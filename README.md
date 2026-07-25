# VisionGuard — AI-Powered Camera Surveillance System

**VisionGuard** is a full-stack camera surveillance platform with AI object detection, live streaming, event management, and license plate recognition.

## System Architecture

```
d:\project\
├── backend\                  # Node.js Express API server
│   ├── server.js             # Entry point: CORS, routes, static files, MongoDB connect
│   ├── db.js                 # Mongoose connection with retry mechanism
│   ├── .env                  # Secrets & config (NOT committed to git)
│   ├── models\
│   │   ├── Camera.js         # Camera schema (name, location, type, ipAddress, status)
│   │   ├── Event.js          # Event schema (cameraId, image, thumbnail, analysis, tags)
│   │   ├── User.js           # User schema (username, password, role)
│   │   └── Blacklist.js      # Blacklist schema (license plates, faces)
│   ├── routes\
│   │   ├── cameras.js        # CRUD camera
│   │   ├── events.js         # Events: upload, list, filter, stats, re-analyze, delete
│   │   ├── ezviz.js           # EZVIZ integration: sync cameras, capture, webhook
│   │   ├── ipcam.js          # IP Webcam: capture, snapshot proxy, MJPEG stream proxy
│   │   ├── watcher.js        # Auto-watch routes: start/stop/status
│   │   ├── stream.js         # RTSP/HLS streaming routes
│   │   ├── auth.js           # JWT authentication: register, login, profile
│   │   └── blacklist.js      # Blacklist management (plates, faces)
│   ├── services\
│   │   ├── analyzer.js       # HTTP client calling Python YOLO server, fallback when offline
│   │   ├── watcher.js        # Auto-watch: capture every 5s, save when person/vehicle detected
│   │   ├── ezviz.js          # Spawn ezviz_bridge.py via child_process
│   │   ├── stream.js         # FFmpeg RTSP-to-HLS/HTTP-GIF transcoding
│   │   ├── streamBridge.js   # RTSP capture via child_process (FFmpeg)
│   │   ├── rtspCapture.js    # RTSP direct capture service
│   │   ├── ringBuffer.js     # Ring buffer for recording
│   │   ├── sse.js            # Server-Sent Events for real-time event push
│   │   └── cleanup.js        # Scheduled cleanup of old uploads/streams
│   ├── scripts\
│   │   ├── analyze_server.py # YOLO HTTP server (load model once, run persistent)
│   │   ├── analyze_image.py  # YOLO CLI one-shot (backup/test)
│   │   ├── ezviz_bridge.py   # pyezviz bridge: devices, status, capture
│   │   ├── ezviz_server.py   # EZVIZ webhook receiver
│   │   ├── plate_reader.py   # License plate detection via YOLO + EasyOCR
│   │   └── generate_clip.py  # Generate video clip from HLS segments
│   ├── uploads\              # Captured images + thumbnails (NOT committed)
│   └── streams\              # HLS segments (.m3u8, .ts) (NOT committed)
│
└── frontend\                 # React SPA (Vite)
    ├── src\
    │   ├── App.jsx            # React Router + route definitions
    │   ├── api.js             # Fetch wrapper for all API calls
    │   ├── components\
    │   │   ├── Layout.jsx     # Sidebar + topbar + Outlet
    │   │   ├── CameraForm.jsx  # Form for creating/editing cameras
    │   │   ├── EventCard.jsx  # Card displaying event in list
    │   │   ├── AnalysisOverlay.jsx # Draw bounding boxes on image
    │   │   ├── HlsPlayer.jsx  # HLS video player
    │   │   ├── ClipPlayer.jsx # Clip playback component
    │   │   ├── RecordingPanel.jsx # Recording controls
    │   │   └── Toast.jsx      # Toast notification system
    │   └── pages\
    │       ├── Dashboard.jsx      # Metrics + camera grid + recent events
    │       ├── Cameras.jsx        # Camera management + live preview + capture
    │       ├── Events.jsx        # Event list view
    │       ├── EventDetail.jsx   # Event detail + analysis overlay
    │       ├── UploadPage.jsx    # Manual image upload
    │       ├── SearchPage.jsx    # Advanced search (table results)
    │       ├── PlatesPage.jsx    # License plate stats + log
    │       ├── LoginPage.jsx     # User login
    │       ├── RegisterPage.jsx  # User registration
    │       └── SettingsPage.jsx  # System settings (stub)
    └── dist\                  # Production build output (NOT committed)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite, React Router, Lucide React (icons), date-fns |
| Backend | Node.js, Express 5, Mongoose (MongoDB ODM) |
| Database | MongoDB (local, db name: `camera_surveillance`) |
| File handling | Multer (upload), Sharp (thumbnail), uuid (filename) |
| AI/ML | Python, Ultralytics YOLOv8 (`yolov8n.pt`) for person/vehicle detection; two-stage YOLOv5 for Vietnamese license plates |
| Camera integration | pyezviz (EZVIZ), IP Webcam (Android app, MJPEG), RTSP |
| Streaming | FFmpeg (RTSP to HLS/HTTP-GIF) |
| Authentication | JWT (jsonwebtoken), bcrypt |

## Main Features

### 1. Camera Management
- Add/edit/delete IP cameras (IP Webcam, EZVIZ, RTSP)
- Live preview via MJPEG proxy or HLS streaming

### 2. Auto-Watch (AI Detection)
- Background watcher captures every 5 seconds
- Sends frames to Python YOLO server for analysis
- Saves a snapshot event when a person/vehicle is detected
- 15-second cooldown after each save to avoid duplicates
- Watcher state is persisted and restored on server restart
- **Presence-triggered video recording is disabled by default.** On a detection
  the watcher saves a snapshot only; it no longer auto-records a video clip while
  someone is present. Set `WATCH_RECORD_ON_DETECTION=true` to re-enable it. (This
  is independent of the 24/7 continuous recorder, controlled by `autoRecord`.)

### 3. Event Management
- Full event history with filtering by camera, date range, tag, license plate
- Event detail with bounding box overlay visualization
- Manual image upload with automatic AI analysis
- Re-analysis of existing events

### 4. Live Streaming (RTSP)
- FFmpeg transcodes RTSP streams to HLS (.m3u8 / .ts)
- HTTP-GIF generation for quick previews
- Ring buffer for continuous recording (configurable duration)
- Clip generation from recorded segments

### 4b. EZVIZ Cloud Live Streaming (off-LAN)

For EZVIZ cameras that are **not** on the server's network, `startStream` falls
back to `services/ezvizCloudStream.js`, which streams over EZVIZ's own cloud:

- Authenticates with the **account email/password** (as the EZVIZ app does), not
  an Open Platform `appKey` — so it is not limited by the Open Platform
  streaming package (which returns `ErrCode 9053` once exhausted).
- Pulls video over an **outbound TCP** connection to EZVIZ's VTM/VTDU relays, so
  it works behind symmetric NAT, where UDP hole-punching fails.
- The camera emits H.265; FFmpeg transcodes to H.264 HLS for browser playback.

Local RTSP is still preferred whenever a configured `rtspHost` actually answers.

**Requires a helper binary** (not committed — ~24MB):

```bash
git clone https://github.com/LethalEthan/LE-EZVIZ-VS
cd LE-EZVIZ-VS && go build -o le-ezviz-vs .
# place the binary at backend/bin/le-ezviz-vs.exe (or set EZVIZ_VS_PATH)
```

Two local patches are needed for continuous piping — a `-pipe` flag that writes
the raw Annex-B HEVC to stdout (with logs moved to stderr), and `io.ReadFull`
for the VTDU header/body reads, since `net.Conn.Read` may return partial data
and desyncs the packet parser otherwise.

> Caveats: the upstream project is beta and reverse-engineered, and the camera's
> **Image Encryption must be off** (E2EE is not implemented yet).

### 4c. Face Recognition & Stranger Alerts

- Enroll known people on the **Khuôn mặt** page (name + clear frontal photo; the
  same name can be enrolled multiple times for more angles).
- During auto-watch, every frame with a person also runs face extraction
  (YuNet detector + SFace 128-d embeddings — both ship with OpenCV, models in
  `backend/models/*.onnx`).
- Node matches embeddings against enrolled persons (cosine ≥ `FACE_MATCH_THRESHOLD`,
  default 0.45). The two outcomes are signalled differently on purpose:

  | | Recognised face | Unrecognised face |
  |---|---|---|
  | Event tag | `known-person` (+ the name) | `stranger` |
  | SSE event | `known-person-alert` | `stranger-alert` |
  | Notification | green, 4s, "✓ Người quen: Bố" | red, 12s, "⚠ NGƯỜI LẠ" |
  | Box on image | solid green, labelled with the name | thick **dashed red**, "NGƯỜI LẠ" |
  | Rate limit | per person, 5 min | per camera, 1 min |
- No alerts fire until at least one person is enrolled, and faces under
  `FACE_MIN_PX` (60px) are ignored rather than mislabeled — measured testing showed
  small faces are the dominant cause of wrong identity matches.
- **The subject must be reasonably close to the camera.** Distant figures are
  reported as a plain `person` detection with no identity claim, rather than being
  guessed at. Measured on a 27-person group photo, this configuration re-identified
  98% of known faces with zero strangers matched as known.

### 5. Authentication
- JWT-based user authentication
- Role-based access (user registration/login)
- Protected API routes

## Main Data Flows

### IP Webcam Capture
```
[Cameras.jsx] → POST /api/ipcam/capture/:cameraId
 → Fetch image from http://<IP>:8080/shot.jpg
 → Save to uploads/, create thumbnail (Sharp)
 → Return event immediately (fast response)
 → Background: call Python YOLO server → update event
```

### Auto-Watch
```
[Cameras.jsx] → POST /api/watcher/start/:cameraId
 → watcherService.startWatch(cameraId)
 → setInterval(5000ms):
   → Fetch http://<IP>:8080/shot.jpg
   → Send to Python YOLO server (analyze_server.py)
   → If person/vehicle detected:
     → Save to uploads/, create thumbnail, create Event (tag: auto-watch)
   → If not detected: skip frame, continue
   → 15s cooldown after each save
```

### RTSP Streaming
```
[Cameras.jsx] → POST /api/stream/start/:cameraId
 → streamService.startStream(cameraId)
 → FFmpeg: rtsp://... → HLS (.m3u8 + .ts segments)
 → [HlsPlayer.jsx] plays via /streams/<cameraId>.m3u8

[Cameras.jsx] → POST /api/stream/gif/:cameraId
 → FFmpeg: rtsp://... → short HTTP-GIF
 → Stream back as multipart/x-mixed-replace
```

### License Plate Recognition (Vietnamese)
```
[Event image] → analyze_server.py
 → plate_reader.py — two-stage YOLOv5:
     Stage 1  LP_detector  → locate plate rectangle(s)
     Stage 2  LP_ocr       → detect each character as an object,
                             order into 1-row / 2-row plate
 → licensePlates saved to Event.analysis (e.g. "30G-70516"), tag: "plate"
```

Handles both 1-row (car) and 2-row (motorbike) Vietnamese plates. Runs ~0.1–0.9s
per plate on CPU using the nano weights. Models & method adapted from
[trungdinh22/License-Plate-Recognition](https://github.com/trungdinh22/License-Plate-Recognition).

> **License note:** the upstream plate-recognition repo publishes no license file.
> Its weights/method are vendored here at the project owner's discretion; review its
> terms before any redistribution or commercial use.

## Environment Variables

Create `backend/.env` before running:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/camera_surveillance
ANALYZER_PORT=5100
PYTHON_PATH=python

# AI analyzer CPU tuning (all optional — defaults tuned for low CPU)
YOLO_MODEL=yolov8s.pt              # default; use yolov8n.pt for less CPU (lower recall)
YOLO_IMGSZ=640                     # inference resolution; lower (e.g. 512) = less CPU, weaker recall
ANALYZER_WORKERS=2                 # parallel YOLO worker processes
ANALYZER_THREADS_PER_WORKER=4      # torch/BLAS threads per worker; keep
                                  # WORKERS * THREADS_PER_WORKER <= CPU cores

# Face recognition / stranger alerts (YuNet + SFace, bundled with OpenCV) — optional
# FACE_MATCH_THRESHOLD=0.45         # SFace cosine similarity for "same person".
#                                   # Higher = fewer strangers slipping through as
#                                   # known, more false "stranger" alerts.
# FACE_MIN_PX=60                    # ignore faces smaller than this (measured on
#                                   # the downscaled frame). Small faces are the
#                                   # main cause of wrong identity matches.
# STRANGER_ALERT_COOLDOWN_MS=60000  # min gap between stranger alerts per camera
# KNOWN_ALERT_COOLDOWN_MS=300000    # min gap between "known person" notices, per
#                                   # person — routine arrivals shouldn't spam

# Vietnamese license plate recognition (two-stage YOLOv5) — all optional
# LPR_DETECTOR_WEIGHTS=models/LP_detector_nano_61.pt  # or LP_detector.pt (~41MB, more accurate)
# LPR_OCR_WEIGHTS=models/LP_ocr_nano_62.pt            # or LP_ocr.pt (~41MB)
# LPR_DETECT_CONF=0.60              # plate-detection confidence threshold
# LPR_OCR_CONF=0.60                 # character-detection confidence threshold
# YOLOV5_DIR=                       # path to a local yolov5 clone (offline mode)
# PLATE_TIMEOUT_SEC=25              # max seconds for one plate read

# IP Webcam (optional)
IP_WEBCAM_URL=http://192.168.1.xxx:xxxx

# EZVIZ (optional)
EZVIZ_EMAIL=your@email.com
EZVIZ_PASSWORD=yourpassword
EZVIZ_REGION=apiisgp

# EZVIZ cloud streaming (optional — see "EZVIZ Cloud Live Streaming")
# Region name is derived from EZVIZ_REGION; override only if needed.
# EZVIZ_VS_PATH=backend/bin/le-ezviz-vs.exe
# EZVIZ_VS_REGION=Asia
# Output size/bitrate of the transcoded HLS (camera sends 2880x1620).
# EZVIZ_STREAM_HEIGHT=720
# EZVIZ_STREAM_BITRATE=2000k

# Optional
RESTORE_AUTOWATCH_ON_START=true

# Auto-record a video clip while a person/vehicle is present (default: false).
# When false, auto-watch saves detection snapshots but records no video clip.
WATCH_RECORD_ON_DETECTION=false
```

## Installation

### Prerequisites

- **Node.js** >= 18
- **Python** >= 3.9
- **MongoDB** running on `localhost:27017`
- **FFmpeg** in system PATH (for RTSP/HLS streaming)
- **Git**

### Steps

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd project

# 2. Install backend dependencies
cd backend
npm install

# 3. Install frontend dependencies
cd ../frontend
npm install

# 4. Set up environment variables
# Copy and edit backend/.env (create from .env.example if needed)
# DO NOT commit .env to git

# 5. Install Python dependencies (in backend directory)
cd ../backend
# ultralytics (YOLOv8) + the deps YOLOv5 needs for plate recognition
pip install ultralytics pillow requests pyezviz pandas tqdm seaborn psutil gitpython

# 6. Model weights — NOT in git (large, and third-party licences vary).
#    Download them into backend/models/ before first run.

# 6a. Person/vehicle detection — auto-downloads on first run, or pre-fetch:
python -c "from ultralytics import YOLO; YOLO('yolov8s.pt')"

# 6b. Face recognition (YuNet + SFace, Apache-2.0, from OpenCV Zoo)
curl -L -o models/face_detection_yunet_2023mar.onnx \
  https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
curl -L -o models/face_recognition_sface_2021dec.onnx \
  https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx

# 6c. Vietnamese licence plate weights, from
#     https://github.com/trungdinh22/License-Plate-Recognition
#     Download LP_detector_nano_61.pt and LP_ocr_nano_62.pt from that repo's
#     ./model folder into backend/models/.
#     NOTE: that project publishes no licence file, so its weights are not
#     redistributed here — fetch them yourself and review its terms.
#
#     The YOLOv5 code is fetched via torch.hub on first plate read (needs
#     internet once; cached afterwards). To run fully offline, clone
#     https://github.com/ultralytics/yolov5 and set YOLOV5_DIR to its path.
```

## Running the System

You need **3 terminal windows**:

```bash
# Terminal 1 — Backend API Server
cd backend
npm run dev

# Terminal 2 — Frontend Dev Server
cd frontend
npm run dev

# Terminal 3 — Python AI Analyzer (optional, system works without it)
cd backend
python scripts/analyze_server.py
```

Access the app at `http://localhost:5173`

### MongoDB Requirement

MongoDB must be running before starting the backend:

```bash
# macOS/Linux
mongod --dbpath /path/to/data

# Windows
mongod --dbpath C:\data\db
```

## Project Structure Notes

- **Do NOT modify** `backend/.env`, `backend/uploads/*`, `backend/streams/*`, `frontend/dist/*`, or `package-lock.json` directly.
- YOLO model files (`*.pt`) are auto-downloaded and excluded from git.
- The `backend/uploads/` and `backend/streams/` directories are gitignored (dynamic content).
- All API routes except `/api/auth/*` and `/api/health` require JWT authentication.


## Troubleshooting

### "YOLO server not available" warning
The AI analyzer is optional. Events will still be saved, but without object detection labels. Start `python scripts/analyze_server.py` to enable AI analysis.

### MongoDB connection fails
Ensure MongoDB is running (`mongod`). Check `MONGO_URI` in `.env`.

### FFmpeg not found
Install FFmpeg and add it to PATH. Required for RTSP streaming and clip generation.
- Windows: `winget install ffmpeg` or download from ffmpeg.org
- Linux: `sudo apt install ffmpeg`
- macOS: `brew install ffmpeg`

### RTSP stream not playing
Some camera brands use non-standard RTSP. Check camera docs for correct URL format and codec settings.

### Port already in use
Change `PORT` in `backend/.env`. Update `frontend/vite.config.js` proxy settings accordingly.
