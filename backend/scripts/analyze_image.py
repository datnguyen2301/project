"""
Analyze an image using YOLOv8 for object detection.
Returns JSON with detected persons, vehicles, and license plates.

Usage:
  python analyze_image.py <image_path>
"""

import sys
import json
import os

def analyze(image_path):
    from ultralytics import YOLO

    model_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'models', 'yolov8n.pt')
    if not os.path.exists(model_path):
        os.makedirs(os.path.dirname(model_path), exist_ok=True)
        model = YOLO('yolov8n.pt')
        import shutil
        downloaded = os.path.join(os.getcwd(), 'yolov8n.pt')
        if os.path.exists(downloaded):
            shutil.move(downloaded, model_path)
    else:
        model = YOLO(model_path)

    results = model(image_path, verbose=False)[0]

    PERSON_CLASS = 0
    VEHICLE_CLASSES = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}

    persons = []
    vehicles = []
    tags = []

    for box in results.boxes:
        cls_id = int(box.cls[0])
        conf = float(box.conf[0])
        x1, y1, x2, y2 = box.xyxy[0].tolist()
        bbox = {
            "x": round(x1),
            "y": round(y1),
            "width": round(x2 - x1),
            "height": round(y2 - y1),
        }

        if cls_id == PERSON_CLASS and conf >= 0.4:
            persons.append({"confidence": round(conf, 2), "bbox": bbox})
        elif cls_id in VEHICLE_CLASSES and conf >= 0.4:
            vehicles.append({
                "type": VEHICLE_CLASSES[cls_id],
                "confidence": round(conf, 2),
                "bbox": bbox,
            })

    if persons:
        tags.append("person")
    if vehicles:
        tags.append("vehicle")

    return {
        "analysis": {
            "persons": persons,
            "vehicles": vehicles,
            "licensePlates": [],
        },
        "tags": tags,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: analyze_image.py <image_path>"}))
        sys.exit(1)

    image_path = sys.argv[1]
    if not os.path.exists(image_path):
        print(json.dumps({"error": f"File not found: {image_path}"}))
        sys.exit(1)

    try:
        result = analyze(image_path)
        print(json.dumps({"ok": True, "data": result}, default=str))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
