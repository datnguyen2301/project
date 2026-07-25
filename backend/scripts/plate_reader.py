"""
Vietnamese License Plate Detection & Recognition.

Two-stage YOLOv5 pipeline (adapted from trungdinh22/License-Plate-Recognition):
  Stage 1  LP_detector  — locate the plate rectangle(s) in the frame.
  Stage 2  LP_ocr       — detect each CHARACTER as an object inside the crop, then
                          order them geometrically into 1-row or 2-row plates.

This replaces the previous EasyOCR pipeline. Character-detection is markedly more
accurate on Vietnamese plates (especially 2-row motorbike plates) than generic OCR.

Interface is unchanged so the analyzer needs no edits:
  read_plate(image_path, vehicle_bboxes=None) -> [{plateNumber, confidence, bbox}]
  _get_reader()  -> pre-loads both models (used by the analyzer to warm up)

Setup notes:
  - Weights (nano, ~4MB each) live in backend/models/:
        LP_detector_nano_61.pt, LP_ocr_nano_62.pt
    Override with LPR_DETECTOR_WEIGHTS / LPR_OCR_WEIGHTS. Full-size weights
    (LP_detector.pt / LP_ocr.pt, ~41MB) are more accurate if you add them.
  - YOLOv5 is loaded via torch.hub. On first run it downloads the yolov5 repo to
    the torch hub cache (needs internet once). To run fully offline, clone
    https://github.com/ultralytics/yolov5 and set YOLOV5_DIR to its path.

Attribution: models & method from https://github.com/trungdinh22/License-Plate-Recognition
"""

import math
import os

import cv2
import numpy as np

# Kept for backwards-compat; the analyzer bounds each read with its own timeout.
PLATE_TIMEOUT_SEC = 15

_MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models')

DETECTOR_WEIGHTS = os.environ.get(
    'LPR_DETECTOR_WEIGHTS', os.path.join(_MODELS_DIR, 'LP_detector_nano_61.pt'))
OCR_WEIGHTS = os.environ.get(
    'LPR_OCR_WEIGHTS', os.path.join(_MODELS_DIR, 'LP_ocr_nano_62.pt'))

DETECT_SIZE = int(os.environ.get('LPR_DETECT_SIZE', '640'))
DETECT_CONF = float(os.environ.get('LPR_DETECT_CONF', '0.60'))
OCR_CONF = float(os.environ.get('LPR_OCR_CONF', '0.60'))

# Lazy singletons — loaded once per process.
_lp_detect = None
_lp_ocr = None


def _load_yolov5(weights_path):
    """Load a YOLOv5 'custom' model from local weights via torch.hub."""
    import torch
    yolov5_dir = os.environ.get('YOLOV5_DIR', '').strip()
    if yolov5_dir and os.path.isdir(yolov5_dir):
        return torch.hub.load(yolov5_dir, 'custom', path=weights_path,
                              source='local', force_reload=False)
    # Fall back to fetching the yolov5 repo from GitHub (cached after first run).
    # trust_repo=True avoids torch.hub's interactive trust prompt (fatal on a server).
    return torch.hub.load('ultralytics/yolov5', 'custom', path=weights_path,
                          source='github', force_reload=False, trust_repo=True)


def _load_models():
    """Load and cache both YOLOv5 models. Returns (detector, ocr) or (None, None)."""
    global _lp_detect, _lp_ocr
    if _lp_detect is not None and _lp_ocr is not None:
        return _lp_detect, _lp_ocr
    for w in (DETECTOR_WEIGHTS, OCR_WEIGHTS):
        if not os.path.exists(w):
            print(f"[plate_reader] Missing weights: {w} — plate detection disabled", flush=True)
            return None, None
    try:
        _lp_detect = _load_yolov5(DETECTOR_WEIGHTS)
        _lp_detect.conf = DETECT_CONF
        _lp_ocr = _load_yolov5(OCR_WEIGHTS)
        _lp_ocr.conf = OCR_CONF
        print(f"[plate_reader] Loaded LPR models "
              f"(detector={os.path.basename(DETECTOR_WEIGHTS)}, "
              f"ocr={os.path.basename(OCR_WEIGHTS)})", flush=True)
    except Exception as e:
        print(f"[plate_reader] Failed to load YOLOv5 LPR models: {e}", flush=True)
        _lp_detect, _lp_ocr = None, None
    return _lp_detect, _lp_ocr


def _get_reader():
    """Compat shim for the analyzer's warm-up call — ensures models are loaded."""
    _load_models()
    return _lp_detect


# ── Deskew helpers (vendored from utils_rotate.py) ────────────────────────────

def _change_contrast(img):
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l_channel, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    cl = clahe.apply(l_channel)
    limg = cv2.merge((cl, a, b))
    return cv2.cvtColor(limg, cv2.COLOR_LAB2BGR)


def _rotate_image(image, angle):
    center = tuple(np.array(image.shape[1::-1]) / 2)
    rot_mat = cv2.getRotationMatrix2D(center, angle, 1.0)
    return cv2.warpAffine(image, rot_mat, image.shape[1::-1], flags=cv2.INTER_LINEAR)


def _compute_skew(src_img, center_thres):
    if len(src_img.shape) == 3:
        h, w, _ = src_img.shape
    elif len(src_img.shape) == 2:
        h, w = src_img.shape
    else:
        return 0.0
    img = cv2.medianBlur(src_img, 3)
    edges = cv2.Canny(img, threshold1=30, threshold2=100, apertureSize=3, L2gradient=True)
    lines = cv2.HoughLinesP(edges, 1, math.pi / 180, 30, minLineLength=w / 1.5, maxLineGap=h / 3.0)
    if lines is None:
        return 1
    min_line = 100
    min_line_pos = 0
    for i in range(len(lines)):
        for x1, y1, x2, y2 in lines[i]:
            center_point = [((x1 + x2) / 2), ((y1 + y2) / 2)]
            if center_thres == 1 and center_point[1] < 7:
                continue
            if center_point[1] < min_line:
                min_line = center_point[1]
                min_line_pos = i
    angle = 0.0
    cnt = 0
    for x1, y1, x2, y2 in lines[min_line_pos]:
        ang = np.arctan2(y2 - y1, x2 - x1)
        if math.fabs(ang) <= 30:  # exclude extreme rotations
            angle += ang
            cnt += 1
    if cnt == 0:
        return 0.0
    return (angle / cnt) * 180 / math.pi


def _deskew(src_img, change_cons, center_thres):
    if change_cons == 1:
        return _rotate_image(src_img, _compute_skew(_change_contrast(src_img), center_thres))
    return _rotate_image(src_img, _compute_skew(src_img, center_thres))


# ── Character ordering (vendored from helper.py) ──────────────────────────────

def _linear_equation(x1, y1, x2, y2):
    b = y1 - (y2 - y1) * x1 / (x2 - x1)
    a = (y1 - b) / x1
    return a, b


def _check_point_linear(x, y, x1, y1, x2, y2):
    a, b = _linear_equation(x1, y1, x2, y2)
    y_pred = a * x + b
    return math.isclose(y_pred, y, abs_tol=3)


def _read_plate_chars(ocr_model, im):
    """Detect + order plate characters. Returns the plate string or 'unknown'."""
    lp_type = "1"
    results = ocr_model(im)
    bb_list = results.pandas().xyxy[0].values.tolist()
    # A valid VN plate has 7-10 characters.
    if len(bb_list) == 0 or len(bb_list) < 7 or len(bb_list) > 10:
        return "unknown"

    center_list = []
    y_sum = 0
    for bb in bb_list:
        x_c = (bb[0] + bb[2]) / 2
        y_c = (bb[1] + bb[3]) / 2
        y_sum += y_c
        center_list.append([x_c, y_c, bb[-1]])  # bb[-1] = detected character (class name)

    # Two extreme-x points define a baseline; a char far off it ⇒ 2-row plate.
    l_point = center_list[0]
    r_point = center_list[0]
    for cp in center_list:
        if cp[0] < l_point[0]:
            l_point = cp
        if cp[0] > r_point[0]:
            r_point = cp
    for ct in center_list:
        if l_point[0] != r_point[0]:
            if not _check_point_linear(ct[0], ct[1], l_point[0], l_point[1], r_point[0], r_point[1]):
                lp_type = "2"

    y_mean = int(int(y_sum) / len(bb_list))
    license_plate = ""
    if lp_type == "2":
        line_1, line_2 = [], []
        for c in center_list:
            (line_2 if int(c[1]) > y_mean else line_1).append(c)
        for l1 in sorted(line_1, key=lambda x: x[0]):
            license_plate += str(l1[2])
        license_plate += "-"
        for l2 in sorted(line_2, key=lambda x: x[0]):
            license_plate += str(l2[2])
    else:
        for l in sorted(center_list, key=lambda x: x[0]):
            license_plate += str(l[2])
    return license_plate


# ── Public entry point ────────────────────────────────────────────────────────

def read_plate(image_path, vehicle_bboxes=None):
    """
    Return list of {plateNumber, confidence, bbox}.

    `vehicle_bboxes` is accepted for interface compatibility but unused: the plate
    detector runs on the full frame and localises plates directly.
    """
    if not os.path.exists(image_path):
        return []
    img = cv2.imread(image_path)
    if img is None:
        return []

    detect, ocr = _load_models()
    if detect is None or ocr is None:
        return []

    results = []
    try:
        det = detect(img, size=DETECT_SIZE)
        plates = det.pandas().xyxy[0].values.tolist()
    except Exception as e:
        print(f"[plate_reader] detector error: {e}", flush=True)
        return []

    for p in plates:
        x1, y1, x2, y2 = int(p[0]), int(p[1]), int(p[2]), int(p[3])
        conf = float(p[4])
        crop = img[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
        if crop.size == 0:
            continue

        # Try up to 4 deskew variants; take the first valid read.
        plate_text = "unknown"
        for change_cons in range(2):
            for center_thres in range(2):
                try:
                    plate_text = _read_plate_chars(ocr, _deskew(crop, change_cons, center_thres))
                except Exception:
                    plate_text = "unknown"
                if plate_text and plate_text != "unknown":
                    break
            if plate_text and plate_text != "unknown":
                break

        if plate_text and plate_text != "unknown":
            results.append({
                "plateNumber": plate_text.upper().strip(),
                "confidence": round(min(conf, 0.99), 3),
                "bbox": {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1},
            })

    return results
