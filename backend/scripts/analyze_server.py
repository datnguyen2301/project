"""
Persistent YOLO analysis server.
Loads model once, listens on HTTP for analyze requests.
"""

import json
import os
import sys
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from concurrent.futures import ProcessPoolExecutor, TimeoutError as FuturesTimeoutError
from functools import partial

# ── CPU tuning ───────────────────────────────────────────────────────────────
# With a ProcessPoolExecutor of N workers, PyTorch/OpenMP/BLAS each default to
# grabbing ALL logical cores per process. N workers x all-cores => heavy
# oversubscription and context-switch thrash. Pin the per-worker thread count so
# total intra-op threads stay near the core count. Must be set BEFORE torch/numpy
# are imported (they read these at import time); on Windows "spawn" each worker
# re-imports this module, so the values propagate to workers too.
THREADS_PER_WORKER = int(os.environ.get("ANALYZER_THREADS_PER_WORKER", "4"))
for _var in (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
):
    os.environ.setdefault(_var, str(THREADS_PER_WORKER))

PLATE_TIMEOUT_SEC = int(os.environ.get("PLATE_TIMEOUT_SEC", "25"))

MODEL = None
PORT = int(os.environ.get("ANALYZER_PORT", "5100"))
ANALYZE_TIMEOUT_SEC = 120
WORKERS = int(os.environ.get("ANALYZER_WORKERS", "2"))
# Model + inference resolution are env-configurable for tuning CPU vs accuracy.
# Default to yolov8s @ 640 for reliable recall of people AND vehicles (incl. small
# / distant motorbikes) on real surveillance frames — nano @ 512 missed many.
# For a lighter CPU load set YOLO_MODEL=yolov8n.pt and/or YOLO_IMGSZ=512.
MODEL_NAME = os.environ.get("YOLO_MODEL", "yolov8s.pt")
IMGSZ = int(os.environ.get("YOLO_IMGSZ", "640"))


def _run_with_timeout(fn, args, timeout_sec, default):
    """Run a function with a thread-based timeout. Returns default on timeout."""
    result = [default]
    def target():
        result[0] = fn(*args)
    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout=timeout_sec)
    if t.is_alive():
        return default
    return result[0]


def _init_worker():
    """Load the YOLO model once in each subprocess worker."""
    global MODEL
    # Cap intra-op parallelism per worker so N workers don't oversubscribe cores.
    try:
        import torch
        torch.set_num_threads(THREADS_PER_WORKER)
    except Exception:
        pass
    from ultralytics import YOLO
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models')
    model_path = os.path.join(model_dir, MODEL_NAME)
    MODEL = YOLO(model_path)
    print(f"[analyzer] Worker {os.getpid()} loaded YOLO model from {model_path} "
          f"(threads={THREADS_PER_WORKER})", flush=True)
    # NOTE: the plate-recognition (YOLOv5 LPR) models are intentionally NOT
    # preloaded here. Watch cycles call with skip_plate=True, so most workers never
    # need them; they load lazily on the first real plate read instead.


# Use ProcessPoolExecutor for true parallelism — YOLO inference is CPU-bound
_executor = ProcessPoolExecutor(max_workers=WORKERS, initializer=_init_worker)

# Warm-up: run inference once before taking real requests to eliminate cold-start latency
_warmed_up = False


def _analyze_wrapper(image_path, skip_plate=False, want_faces=False):
    """Top-level function picklable by ProcessPoolExecutor."""
    return analyze(image_path, skip_plate, want_faces)


def _faces_only_wrapper(image_path):
    """Extract faces + embeddings only (used for known-person enrollment)."""
    import face_reader
    return {"faces": face_reader.detect_faces(image_path)}


def _make_dummy_image():
    import numpy as np
    from PIL import Image
    # Use unique temp file per worker to avoid WinError 32 (file lock) on Windows
    pid = os.getpid()
    dummy_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models', f'_warmup_tmp_{pid}.jpg')
    img = Image.fromarray(np.zeros((640, 640, 3), dtype=np.uint8))
    img.save(dummy_path)
    return dummy_path


def warm_up():
    """Run dummy inference in ALL workers to eliminate cold-start latency."""
    global _warmed_up
    if _warmed_up:
        return
    print("[analyzer] Warming up all workers...", flush=True)
    dummy_path = _make_dummy_image()
    try:
        # Submit WORKERS times to prime every subprocess in the pool
        futures = [_executor.submit(_analyze_wrapper, dummy_path, True) for _ in range(WORKERS)]
        for f in futures:
            try:
                f.result(timeout=60)
            except Exception as e:
                print(f"[analyzer] Warm-up warning: {e}", flush=True)
    finally:
        try:
            os.remove(dummy_path)
        except Exception:
            pass
    _warmed_up = True
    print("[analyzer] All workers warmed up", flush=True)


def load_model():
    global MODEL
    try:
        import torch
        torch.set_num_threads(THREADS_PER_WORKER)
    except Exception:
        pass
    from ultralytics import YOLO
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models')
    model_path = os.path.join(model_dir, MODEL_NAME)
    if not os.path.exists(model_path):
        os.makedirs(model_dir, exist_ok=True)
        MODEL = YOLO(MODEL_NAME)
        import shutil
        downloaded = os.path.join(os.getcwd(), MODEL_NAME)
        if os.path.exists(downloaded):
            shutil.move(downloaded, model_path)
    else:
        MODEL = YOLO(model_path)
    print(f"[analyzer] Model {MODEL_NAME} loaded in main process (imgsz={IMGSZ}, "
          f"workers={WORKERS}, threads/worker={THREADS_PER_WORKER}), listening on port {PORT}", flush=True)
    # Warm-up: pre-load model in the pool workers
    warm_up()


def analyze(image_path, skip_plate=False, want_faces=False):
    import os as _os
    PERSON_CLASS = 0
    VEHICLE_CLASSES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}

    PERSON_MIN_CONF = 0.55
    VEHICLE_MIN_CONF = 0.40
    PERSON_MIN_AREA = 400
    PERSON_MIN_RATIO = 0.3
    VEHICLE_MIN_AREA = 300

    results = MODEL(
        image_path,
        imgsz=IMGSZ,
        verbose=False,
        half=False,
        augment=False,
    )[0]

    persons = []
    vehicles = []
    tags = []
    skipped_persons = 0
    skipped_vehicles = 0

    for box in results.boxes:
        cls_id = int(box.cls[0])
        conf = float(box.conf[0])
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        w = round(x2 - x1)
        h = round(y2 - y1)
        area = w * h
        bbox = {"x": round(x1), "y": round(y1), "width": w, "height": h}

        if cls_id == PERSON_CLASS and conf >= PERSON_MIN_CONF:
            if area < PERSON_MIN_AREA:
                skipped_persons += 1
                continue
            ratio = h / max(w, 1)
            if ratio < PERSON_MIN_RATIO:
                skipped_persons += 1
                continue
            persons.append({"confidence": round(conf, 2), "bbox": bbox})
        elif cls_id in VEHICLE_CLASSES and conf >= VEHICLE_MIN_CONF:
            if area < VEHICLE_MIN_AREA:
                skipped_vehicles += 1
                continue
            vehicles.append({"type": VEHICLE_CLASSES[cls_id], "confidence": round(conf, 2), "bbox": bbox})

    if skipped_persons or skipped_vehicles:
        print(f"[analyzer] filtered out: {skipped_persons} tiny/bad persons, {skipped_vehicles} tiny vehicles", flush=True)
    print(f"[analyzer] yolo done: persons={len(persons)} vehicles={len(vehicles)}", flush=True)

    if persons:
        tags.append("person")
    if vehicles:
        tags.append("vehicle")

    result = {"analysis": {"persons": persons, "vehicles": vehicles, "licensePlates": [], "faces": []}, "tags": list(tags)}

    # Face extraction (for known/stranger matching in Node). Only when requested
    # and a person is actually in frame — faces without a person don't happen,
    # and this keeps idle watch cycles cheap.
    if want_faces and persons:
        try:
            import face_reader
            result["analysis"]["faces"] = face_reader.detect_faces(image_path)
            if result["analysis"]["faces"]:
                print(f"[analyzer] faces={len(result['analysis']['faces'])}", flush=True)
        except Exception as e:
            print(f"[analyzer] Face detection error: {e}", flush=True)

    # License plate detection — run synchronously and merge the results into the
    # response. (Previously this ran in a fire-and-forget daemon thread whose
    # results were discarded, so licensePlates was always empty and the UI showed
    # "???".) The OCR pass is still bounded by PLATE_TIMEOUT_SEC so a slow frame
    # can't hang the request. Only runs when the caller wants plates (watch cycles
    # pass skip_plate=True), so it never slows the auto-watch loop.
    if not skip_plate:
        try:
            import plate_reader
            # Ensure the LPR (YOLOv5) models are loaded once *outside* the per-read
            # timeout — the first load can take ~30s (yolov5 import + weights) and
            # would otherwise time out (they're lazy, not preloaded per worker).
            try:
                plate_reader._get_reader()
            except Exception as warm_err:
                print(f"[analyzer] LPR init failed: {warm_err}", flush=True)

            plate_results = _run_with_timeout(
                plate_reader.read_plate,
                (image_path, vehicles),
                PLATE_TIMEOUT_SEC,
                []
            )
            license_plates = []
            for p in plate_results:
                pn = p.get("plateNumber", "")
                if "F" in pn or "Q" in pn[2:]:
                    continue
                license_plates.append(p)
            if license_plates:
                result["analysis"]["licensePlates"] = license_plates
                result["tags"].append("plate")
                print(f"[analyzer] plates={[(str(p['plateNumber']), float(p['confidence'])) for p in license_plates]}", flush=True)
            else:
                print("[analyzer] no plates read", flush=True)
        except Exception as e:
            print(f"[analyzer] Plate detection error: {e}", flush=True)

    print(f"[analyzer] persons={[(float(p['confidence'])) for p in persons]} vehicles={[(v['type'], float(v['confidence'])) for v in vehicles]}", flush=True)
    return result


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            self._respond(200, {"ok": True, "warmed_up": _warmed_up, "model_loaded": MODEL is not None})
        else:
            self._respond(400, {"ok": False, "error": "Unknown endpoint"})

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        image_path = body.get("imagePath", "")
        skip_plate = bool(body.get("skip_plate", False))
        want_faces = bool(body.get("faces", False))
        faces_only = bool(body.get("faces_only", False))

        if not image_path or not os.path.exists(image_path):
            self._respond(400, {"ok": False, "error": "imagePath missing or not found"})
            return

        try:
            if faces_only:
                future = _executor.submit(_faces_only_wrapper, image_path)
            else:
                future = _executor.submit(_analyze_wrapper, image_path, skip_plate, want_faces)
            result = future.result(timeout=ANALYZE_TIMEOUT_SEC)
            self._respond(200, {"ok": True, "data": result})
        except FuturesTimeoutError:
            self._respond(504, {"ok": False, "error": f"timeout after {ANALYZE_TIMEOUT_SEC}s"})
        except Exception as e:
            self._respond(500, {"ok": False, "error": str(e)})

    def _respond(self, code, data):
        body = json.dumps(data, default=str).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    load_model()
    server = HTTPServer(('127.0.0.1', PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[analyzer] Shutting down")
        server.shutdown()
