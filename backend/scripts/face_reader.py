"""
Face detection + embedding for stranger alerting.

Pipeline (all bundled with OpenCV >= 4.5.4, no extra installs):
  YuNet  (cv2.FaceDetectorYN)    — locate faces + 5 landmarks
  SFace  (cv2.FaceRecognizerSF)  — align crop → 128-d embedding

Matching itself happens in Node (services/faceMatch.js) against embeddings of
enrolled "known persons"; this module only extracts faces + embeddings.

Matching threshold lives in Node (FACE_MATCH_THRESHOLD). Note OpenCV's documented
0.363 is a general verification threshold and proved far too permissive here —
see the measurements in services/faceMatch.js.
"""

import os

import cv2
import numpy as np

_MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models')

DETECTOR_ONNX = os.environ.get(
    'FACE_DETECTOR_ONNX', os.path.join(_MODELS_DIR, 'face_detection_yunet_2023mar.onnx'))
RECOGNIZER_ONNX = os.environ.get(
    'FACE_RECOGNIZER_ONNX', os.path.join(_MODELS_DIR, 'face_recognition_sface_2021dec.onnx'))

# Minimum face size to attempt identification, measured on the image AFTER the
# MAX_DIM downscale below — i.e. on the pixels actually fed to SFace, which is
# what embedding quality depends on. (Reported bboxes are in original-image
# coordinates, so they can read larger than this number.)
#
# Small faces are the single biggest source of wrong identity matches. Measured
# on a 27-person group photo, worst similarity between two DIFFERENT people:
#   40px -> 0.608   (would be matched as the same person at most thresholds)
#   50px -> 0.489
#   60px -> 0.368   (safely below the 0.45 match threshold)
# Anything below this is reported as a plain person detection with no identity.
MIN_FACE_PX = int(os.environ.get('FACE_MIN_PX', '60'))
SCORE_THRESHOLD = float(os.environ.get('FACE_SCORE_THRESHOLD', '0.8'))
MAX_DIM = int(os.environ.get('FACE_MAX_DIM', '1600'))

_detector = None
_recognizer = None


def _get_models():
    """Lazy singletons; one instance per process."""
    global _detector, _recognizer
    if _detector is None:
        if not (os.path.exists(DETECTOR_ONNX) and os.path.exists(RECOGNIZER_ONNX)):
            raise FileNotFoundError(
                f"Face models missing: {DETECTOR_ONNX} / {RECOGNIZER_ONNX}")
        _detector = cv2.FaceDetectorYN.create(
            DETECTOR_ONNX, "", (320, 320), SCORE_THRESHOLD, 0.3, 5000)
        _recognizer = cv2.FaceRecognizerSF.create(RECOGNIZER_ONNX, "")
    return _detector, _recognizer


def detect_faces(image_path):
    """
    Return [{bbox:{x,y,width,height}, score, embedding:[128 floats]}] for every
    usable face in the image. bbox is in ORIGINAL image coordinates.
    """
    if not os.path.exists(image_path):
        return []
    img = cv2.imread(image_path)
    if img is None:
        return []
    if img.ndim == 3 and img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

    orig_h, orig_w = img.shape[:2]
    scale = 1.0
    if max(orig_h, orig_w) > MAX_DIM:
        scale = MAX_DIM / max(orig_h, orig_w)
        img = cv2.resize(img, (int(orig_w * scale), int(orig_h * scale)),
                         interpolation=cv2.INTER_AREA)

    h, w = img.shape[:2]
    detector, recognizer = _get_models()
    detector.setInputSize((w, h))
    _, faces = detector.detect(img)
    if faces is None:
        return []

    out = []
    for row in faces:
        fw, fh = float(row[2]), float(row[3])
        if min(fw, fh) < MIN_FACE_PX:
            continue
        try:
            crop = recognizer.alignCrop(img, row)
            feat = recognizer.feature(crop).flatten()
        except Exception:
            continue
        inv = 1.0 / scale
        out.append({
            "bbox": {
                "x": int(row[0] * inv),
                "y": int(row[1] * inv),
                "width": int(fw * inv),
                "height": int(fh * inv),
            },
            "score": round(float(row[-1]), 3),
            "embedding": [round(float(v), 6) for v in feat],
        })
    return out


if __name__ == "__main__":
    import json
    import sys
    faces = detect_faces(sys.argv[1])
    for f in faces:
        f_preview = dict(f, embedding=f["embedding"][:4] + ["..."])
        print(json.dumps(f_preview))
    print(f"{len(faces)} face(s)")
