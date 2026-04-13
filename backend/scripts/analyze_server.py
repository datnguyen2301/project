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

PLATE_TIMEOUT_SEC = 15

MODEL = None
PORT = int(os.environ.get("ANALYZER_PORT", "5100"))
ANALYZE_TIMEOUT_SEC = 120
WORKERS = int(os.environ.get("ANALYZER_WORKERS", "2"))


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
    """Load YOLO model and EasyOCR once in each subprocess worker."""
    global MODEL
    from ultralytics import YOLO
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models')
    model_path = os.path.join(model_dir, 'yolov8s.pt')
    MODEL = YOLO(model_path)
    print(f"[analyzer] Worker {os.getpid()} loaded YOLO model from {model_path}", flush=True)
    # Pre-load EasyOCR reader (first call downloads + loads models ~10-30s)
    import plate_reader
    _ = plate_reader._get_reader()
    print(f"[analyzer] Worker {os.getpid()} loaded EasyOCR reader", flush=True)


# Use ProcessPoolExecutor for true parallelism — YOLO inference is CPU-bound
_executor = ProcessPoolExecutor(max_workers=WORKERS, initializer=_init_worker)

# Warm-up: run inference once before taking real requests to eliminate cold-start latency
_warmed_up = False


def _analyze_wrapper(image_path, skip_plate=False):
    """Top-level function picklable by ProcessPoolExecutor."""
    return analyze(image_path, skip_plate)


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
    from ultralytics import YOLO
    model_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models')
    model_path = os.path.join(model_dir, 'yolov8s.pt')
    if not os.path.exists(model_path):
        os.makedirs(model_dir, exist_ok=True)
        MODEL = YOLO('yolov8s.pt')
        import shutil
        downloaded = os.path.join(os.getcwd(), 'yolov8s.pt')
        if os.path.exists(downloaded):
            shutil.move(downloaded, model_path)
    else:
        MODEL = YOLO(model_path)
    print(f"[analyzer] Model loaded in main process, listening on port {PORT}", flush=True)
    # Warm-up: pre-load model in the pool workers
    warm_up()


def analyze(image_path, skip_plate=False):
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
        imgsz=640,
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

    result = {"analysis": {"persons": persons, "vehicles": vehicles, "licensePlates": []}, "tags": list(tags)}

    # License plate detection: run in background thread only when not skipped
    if not skip_plate:
        def _run_plate():
            import plate_reader
            license_plates = []
            try:
                plate_results = _run_with_timeout(
                    plate_reader.read_plate,
                    (image_path, vehicles),
                    PLATE_TIMEOUT_SEC,
                    []
                )
                for p in plate_results:
                    pn = p.get("plateNumber", "")
                    if "F" in pn or "Q" in pn[2:]:
                        continue
                    license_plates.append(p)
                if license_plates:
                    tags.append("plate")
                    print(f"[analyzer] plates={[(str(p['plateNumber']), float(p['confidence'])) for p in license_plates]}", flush=True)
            except Exception as e:
                print(f"[analyzer] Plate detection error: {e}", flush=True)
            # Store plate results back (background, no return needed)

        t = threading.Thread(target=_run_plate, daemon=True)
        t.start()

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

        if not image_path or not os.path.exists(image_path):
            self._respond(400, {"ok": False, "error": "imagePath missing or not found"})
            return

        try:
            future = _executor.submit(_analyze_wrapper, image_path, skip_plate)
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
