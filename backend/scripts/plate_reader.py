"""
License Plate Detection — surveillance-optimized using EasyOCR + shape detection.
"""

import os
import re
import numpy as np
import cv2
import easyocr

# Timeout for entire plate detection (seconds)
PLATE_TIMEOUT_SEC = 15

# Lazy singleton: initialize EasyOCR once per process (GPU/CPU auto-detected)
_easyocr_reader = None


def _get_reader():
    """Get or create the EasyOCR reader (lazy singleton)."""
    global _easyocr_reader
    if _easyocr_reader is None:
        _easyocr_reader = easyocr.Reader(['en'], gpu=True, verbose=False)
    return _easyocr_reader


def _normalize(raw):
    """
    Parse OCR text into VN plate: N[N]-L[LL]-NNNNN.
    """
    if not raw:
        return None
    c = raw.upper()
    c = re.sub(r'[\n\r\|]+', ' ', c)
    c = re.sub(r'[^A-Z0-9.\- ]', ' ', c)
    c = re.sub(r'\s+', ' ', c).strip()
    if not c:
        return None

    def _build(province, district, serial):
        prov = re.sub(r'[^0-9]', '', province)
        ser = re.sub(r'[^0-9]', '', serial)
        if not re.match(r'^\d{1,2}$', prov):
            return None
        if not re.match(r'^\d{4,7}$', ser):
            return None
        d = district.upper()
        # Valid Vietnamese district letters (excludes F and Q)
        if not re.match(r'^[ABEKHMNPRSTUVXZY]+$', d):
            return None
        if len(ser) > 5:
            ser = ser[:5]
        return f"{prov}{d}-{ser}"

    # Strategy 1: regex find (handles noise between parts)
    for m in re.finditer(
            r'(?<![A-Z0-9])(\d{1,2})[.\- ]*([A-Z0-9]{1,3})[.\- ]*(\d{4,7})(?![A-Z0-9])',
            c, re.IGNORECASE):
        p = _build(m.group(1), m.group(2), m.group(3))
        if p:
            return p

    # Strategy 2: strip → try boundaries
    clean = re.sub(r'[^A-Z0-9]', '', c)
    if 7 <= len(clean) <= 15:
        has_l = bool(re.search(r'[A-Z]', clean))
        has_d = bool(re.search(r'[0-9]', clean))
        if has_l and has_d:
            for pl in [2, 1]:
                if len(clean) < pl + 3:
                    continue
                prov = clean[:pl]
                if not re.match(r'^\d+$', prov):
                    continue
                rem = clean[pl:]
                for dl in range(1, 4):
                    if len(rem) < dl + 4:
                        continue
                    dist = rem[:dl]
                    ser = rem[dl:]
                    if re.match(r'^[A-Z]', dist) and re.match(r'^\d{4,7}$', ser):
                        p = _build(prov, dist, ser)
                        if p:
                            return p
                    if re.match(r'^[0O]$', dist) and re.match(r'^[A-Z]{1,2}\d{4,}$', ser):
                        for adl in [1, 2]:
                            ad = ser[:adl]
                            asr = ser[adl:]
                            if re.match(r'^[A-Z]$', ad) and re.match(r'^\d{4,}$', asr):
                                p = _build(prov, 'O' + ad, asr)
                                if p:
                                    return p

    # Strategy 3: aggressive split for OCR fragments e.g. "29A-3356" or "29A33562"
    m3 = re.search(r'^(\d{1,2})([A-Z]{1,3})(\d{3,7})$', clean)
    if m3:
        p = _build(m3.group(1), m3.group(2), m3.group(3))
        if p:
            return p

    # Strategy 4: just province + serial with minimal district placeholder
    m4 = re.search(r'(\d{1,2})(\d{4,7})$', clean)
    if m4:
        p = _build(m4.group(1), 'X', m4.group(2))
        if p:
            return p

    # Strategy 5: handle digit-within-plate like "15,13,56" -> "151356"
    m5 = re.search(r'^(\d{1,2})[,.](\d{1,2})[,.](\d{2,5})$', clean)
    if m5:
        prov, mid, ser = m5.group(1), m5.group(2), m5.group(3)
        if len(mid) >= 1 and len(ser) <= 5:
            for dl in [1, 2]:
                if len(mid) < dl:
                    continue
                dist = mid[:dl]
                ser_full = mid[dl:] + ser
                if re.match(r'^\d{4,7}$', ser_full):
                    p = _build(prov, dist, ser_full)
                    if p:
                        return p

    return None


def _is_plate_aspect(w, h):
    """Check if region has VN plate aspect ratio (3:1 to 5:1 wide-to-tall)."""
    if h <= 0 or w <= 0:
        return False
    ratio = w / float(h)
    return 2.5 <= ratio <= 6.0


def _detect_plate_candidates(img):
    """
    Detect rectangular regions likely to be license plates using edge detection.
    Returns list of (x, y, width, height) in image pixel coords.
    """
    ih, iw = img.shape[:2]

    # Convert to grayscale
    if len(img.shape) == 3 and img.shape[2] >= 3:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    else:
        gray = img

    # Bilateral filter to reduce noise while keeping edges
    blurred = cv2.bilateralFilter(gray, 9, 75, 75)

    # Canny edge detection
    edges = cv2.Canny(blurred, 50, 150)

    # Dilate to connect edge fragments
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    dilated = cv2.dilate(edges, kernel, iterations=2)

    # Find contours
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates = []
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)

        # Filter by size
        if w < 40 or h < 10:
            continue
        if w > iw * 0.95 or h > ih * 0.5:
            continue

        # Filter by plate-like aspect ratio
        if not _is_plate_aspect(w, h):
            continue

        candidates.append((x, y, w, h))

    # Sort by area descending, take top 5
    candidates.sort(key=lambda r: r[2] * r[3], reverse=True)
    return candidates[:5]


def _ocr_crop(crop, min_confidence=0.25):
    """
    Run EasyOCR on a cropped image. Returns (plate_text, confidence) or (None, 0).
    Tries multiple preprocessing approaches and uses _normalize to validate results.
    """
    h, w = crop.shape[:2]
    if h < 5 or w < 20:
        return None, 0.0

    ih, iw = h, w
    reader = _get_reader()

    best_plate, best_conf = None, 0.0

    # Try multiple scales and preprocessing strategies
    for scale in [3, 4, 2]:
        try:
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.shape[2] >= 3 else crop
            up = cv2.resize(gray, (max(int(iw * scale), 300), max(int(ih * scale), 60)),
                            interpolation=cv2.INTER_LANCZOS4)
            clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(3, 2))
            enhanced = clahe.apply(up)
            color = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)

            results = reader.readtext(color, batch_size=4)
            for bbox, text, conf in results:
                if conf < min_confidence:
                    continue
                text = text.strip()
                if not text:
                    continue
                norm = _normalize(text)
                if norm and conf >= best_conf:
                    best_plate, best_conf = norm, conf
        except Exception:
            pass

    # Strategy A: raw crop
    try:
        results = reader.readtext(crop, batch_size=4)
        for bbox, text, conf in results:
            if conf < min_confidence:
                continue
            text = text.strip()
            if not text:
                continue
            norm = _normalize(text)
            if norm and conf >= best_conf:
                best_plate, best_conf = norm, conf
    except Exception:
        pass

    # Strategy B: CLAHE upscale
    if best_conf < 0.60:
        try:
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.shape[2] >= 3 else crop
            scale = 3
            up = cv2.resize(gray, (max(int(iw * scale), 300), max(int(ih * scale), 60)),
                            interpolation=cv2.INTER_LANCZOS4)
            clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 2))
            enhanced = clahe.apply(up)
            color = cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)
            results2 = reader.readtext(color, batch_size=4)
            for bbox, text, conf in results2:
                if conf < min_confidence:
                    continue
                text = text.strip()
                if not text:
                    continue
                norm = _normalize(text)
                if norm and conf >= best_conf:
                    best_plate, best_conf = norm, conf
        except Exception:
            pass

    return best_plate, best_conf


def _validate_plate_sequence(crop, plate_text, reader):
    """
    Check if OCR text appears contiguously in the crop (plate-like layout).
    Rejects scattered watermark text that happens to match a plate pattern.
    Returns True if the detected text forms a horizontal line (plate behavior).
    """
    try:
        h, w = crop.shape[:2]
        if h < 5 or w < 20:
            return True  # can't check, be permissive

        gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.shape[2] >= 3 else crop
        up = cv2.resize(gray, (max(w * 3, 300), max(h * 3, 60)), interpolation=cv2.INTER_LANCZOS4)
        results = reader.readtext(up, batch_size=4)

        # Find the detected text's bbox
        for bbox, text, conf in results:
            text = text.strip().upper()
            if not text:
                continue
            # Check if this matches the detected plate
            if _normalize(text) == plate_text or _normalize(text) == plate_text:
                pts = np.array(bbox, dtype=np.int32)
                xs = pts[:, 0]
                # Plate text should form a roughly horizontal line
                # Width of bbox should be significantly larger than height
                bw = xs.max() - xs.min()
                bh = pts[:, 1].max() - pts[:, 1].min()
                if bh > 0:
                    aspect = bw / float(bh)
                    # Reject if text is very tall (likely watermark scattered text)
                    if aspect < 2.0:
                        return False
                    return True
        return True  # couldn't check, be permissive
    except Exception:
        return True


def read_plate(image_path, vehicle_bboxes=None):
    """
    Main entry point. Returns list of {plateNumber, confidence, bbox}.
    Strategy:
      1. Detect rectangular plate candidates via edge detection
      2. OCR only those rectangular regions
      3. Fallback: open-field scan in bottom-right if no candidates found
    """
    if not os.path.exists(image_path):
        return []
    img = cv2.imread(image_path)
    if img is None:
        return []
    if vehicle_bboxes is None:
        vehicle_bboxes = []

    if img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)

    # Downscale very large images to speed up OCR (2880x1620 -> 960x540)
    max_dim = 1920
    ih, iw = img.shape[:2]
    if max(ih, iw) > max_dim:
        scale = max_dim / max(ih, iw)
        img = cv2.resize(img, (int(iw * scale), int(ih * scale)), interpolation=cv2.INTER_AREA)
        print(f"[plate_reader] Downscaled to {img.shape[1]}x{img.shape[0]}", flush=True)
    results = []
    reader = _get_reader()

    # 1. Shape detection: find plate-like rectangles
    shape_candidates = _detect_plate_candidates(img)

    if shape_candidates:
        print(f"[plate_reader] Found {len(shape_candidates)} shape candidates: {[f'({x},{y},{w}x{h})' for x,y,w,h in shape_candidates]}", flush=True)

        best_plate, best_conf = None, 0.0
        best_bbox = None

        for x, y, w, h in shape_candidates:
            crop = img[y:y+h, x:x+w]
            if crop.size == 0:
                continue

            plate, conf = _ocr_crop(crop)
            if plate and conf > best_conf:
                # Validate plate-like layout
                if _validate_plate_sequence(crop, plate, reader):
                    best_plate, best_conf = plate, conf
                    best_bbox = {"x": x, "y": y, "width": w, "height": h}

        if best_plate and best_conf > 0:
            results.append({
                "plateNumber": best_plate,
                "confidence": round(min(best_conf, 0.95), 3),
                "bbox": best_bbox,
            })
            return results

    # 2. Fallback: open-field scan (right-bottom area)
    # Wide scan to catch plates in various positions (handles tilted plates)
    for start_pct in [0.65, 0.70, 0.75, 0.80, 0.60]:
        start_y = int(ih * start_pct)
        end_y = min(ih, start_y + int(ih * 0.20))
        # Try right portion (70% of width) and full width
        for x_start_pct in [0.30, 0.0]:
            x_start = int(iw * x_start_pct)
            crop = img[start_y:end_y, x_start:iw]
            if crop.size == 0:
                continue

            plate, conf = _ocr_crop(crop)
            if plate and conf >= 0.50:
                # Validate layout — skip watermark text with tall aspect ratio
                if not _validate_plate_sequence(crop, plate, reader):
                    print(f"[plate_reader] Rejected watermark-like text: {plate}", flush=True)
                    continue

                plate_h = max(int((end_y - start_y) * 0.6), 10)
                plate_w = max(int(iw * 0.5), 30)
                px = int((iw - plate_w) // 2)
                py = start_y
                results.append({
                    "plateNumber": plate,
                    "confidence": round(min(conf, 0.95), 3),
                    "bbox": {"x": px, "y": py, "width": plate_w, "height": plate_h},
                })
                return results

    # 3. Per-vehicle scans (for when vehicle detection is accurate)
    flat_bboxes = []
    for vb in vehicle_bboxes:
        if "x" in vb and "y" in vb:
            flat_bboxes.append(vb)
        elif "bbox" in vb and isinstance(vb["bbox"], dict):
            flat_bboxes.append(vb["bbox"])

    for vb in flat_bboxes:
        x = int(vb.get("x", 0))
        y = int(vb.get("y", 0))
        vw = int(vb.get("width", 0))
        vh = int(vb.get("height", 0))
        x2 = min(iw, x + vw)
        y2 = min(ih, y + vh)
        x, y = max(0, x), max(0, y)
        aw, ah = x2 - x, y2 - y
        if aw <= 0 or ah <= 0:
            continue

        best_plate, best_conf = None, 0.0
        best_bbox = None

        # Scan bottom-right portion of vehicle where plate is located
        for bfrac, hfrac in [
            (0.60, 0.28),
            (0.70, 0.25),
            (0.78, 0.22),
            (0.85, 0.18),
        ]:
            top = min(int(y + ah * bfrac), ih - 1)
            bot = min(int(top + ah * hfrac), ih)
            if bot <= top:
                continue
            crop = img[top:bot, x:iw]
            if crop.size == 0:
                continue

            plate, conf = _ocr_crop(crop)
            if plate and conf > best_conf:
                if _validate_plate_sequence(crop, plate, reader):
                    best_plate, best_conf = plate, conf
                    best_bbox = {"x": max(0, int(x + vw * 0.05)),
                                 "y": top,
                                 "width": min(int(vw * 0.95), iw - x - 1),
                                 "height": max(int(ah * 0.18), 10)}

        # Full vehicle crop
        crop2 = img[y:y2, x:x2]
        if crop2.size > 0:
            plate2, conf2 = _ocr_crop(crop2)
            if plate2 and conf2 > best_conf:
                if _validate_plate_sequence(crop2, plate2, reader):
                    best_plate, best_conf = plate2, conf2
                    best_bbox = {"x": x, "y": y, "width": aw, "height": ah}

        if best_plate and best_conf > 0 and best_bbox:
            results.append({
                "plateNumber": best_plate,
                "confidence": round(min(best_conf, 0.95), 3),
                "bbox": best_bbox,
            })

    return results
