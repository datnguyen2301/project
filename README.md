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
| AI/ML | Python, Ultralytics YOLOv8 (`yolov8n.pt`), EasyOCR |
| Camera integration | pyezviz (EZVIZ), IP Webcam (Android app, MJPEG), RTSP |
| Streaming | FFmpeg (RTSP to HLS/HTTP-GIF) |
| Authentication | JWT (jsonwebtoken), bcrypt |

## Main Features

### 1. Camera Management
- Add/edit/delete IP cameras (IP Webcam, EZVIZ, RTSP)
- Live preview via MJPEG proxy or HLS streaming
- One-click capture and manual upload

### 2. Auto-Watch (AI Detection)
- Background watcher captures every 5 seconds
- Sends frames to Python YOLO server for analysis
- Saves event when person/vehicle is detected
- 15-second cooldown after each save to avoid duplicates
- Watcher state is persisted and restored on server restart

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

### 5. License Plate Recognition
- Automatic plate detection via YOLO + EasyOCR
- Blacklist management for flagged plates
- Plate search and history

### 6. Authentication
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

### License Plate Recognition
```
[Event image] → analyze_server.py (YOLOv8)
 → Detected plate region → plate_reader.py (EasyOCR)
 → Extracted text → saved to Event.tags (plate: "29A12345")
```

## Environment Variables

Create `backend/.env` before running:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/camera_surveillance
ANALYZER_PORT=5100
PYTHON_PATH=python

# IP Webcam (optional)
IP_WEBCAM_URL=http://192.168.1.100:8080

# EZVIZ (optional)
EZVIZ_EMAIL=your@email.com
EZVIZ_PASSWORD=yourpassword
EZVIZ_REGION=apiisgp

# Optional
RESTORE_AUTOWATCH_ON_START=true
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
pip install ultralytics easyocr pillow requests pyezviz

# 6. (Optional) Download YOLO model manually
# The model yolov8n.pt auto-downloads on first run via analyze_server.py
# You can pre-download:
# python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"
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
