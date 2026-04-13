# AGENTS.md — Project Guide

Đây là tài liệu tham chiếu cho AI agent. Mọi yêu cầu gửi đến agent phải tuân thủ các quy tắc bên dưới.

---

## 1. Kiến trúc Project

```
d:\project\
├── backend\             # Node.js Express API server
│   ├── server.js        # Entry point: CORS, routes, static files, MongoDB connect
│   ├── db.js            # Mongoose connection với retry mechanism
│   ├── .env             # Secrets & config (KHÔNG ĐƯỢC commit)
│   ├── .gitignore
│   ├── models\
│   │   ├── Camera.js    # Schema camera (name, location, type, ipAddress, status)
│   │   └── Event.js     # Schema event (cameraId, image, thumbnail, analysis, tags)
│   ├── routes\
│   │   ├── cameras.js   # CRUD camera
│   │   ├── events.js    # Events: upload, list, filter, stats, re-analyze, delete
│   │   ├── ezviz.js     # EZVIZ integration: sync cameras, capture, webhook
│   │   ├── ipcam.js     # IP Webcam: capture, snapshot proxy, MJPEG stream proxy
│   │   └── watcher.js   # Auto-watch routes: start/stop/status
│   ├── services\
│   │   ├── analyzer.js  # HTTP client gọi Python YOLO server, fallback khi offline
│   │   ├── ezviz.js     # Spawn ezviz_bridge.py qua child_process
│   │   └── watcher.js   # Auto-watch: chụp mỗi 5s, lưu khi phát hiện người/xe
│   ├── scripts\
│   │   ├── analyze_server.py  # YOLO HTTP server (load model 1 lần, chạy persistent)
│   │   ├── analyze_image.py   # YOLO CLI one-shot (backup/test)
│   │   └── ezviz_bridge.py    # pyezviz bridge: devices, status, capture
│   ├── models\          # Thư mục chứa YOLO model file (yolov8n.pt, auto-download)
│   └── uploads\         # Ảnh captured + thumbnails (KHÔNG ĐƯỢC commit)
│
├── frontend\            # React SPA (Vite)
│   ├── vite.config.js   # Dev proxy /api + /uploads → localhost:5000
│   ├── src\
│   │   ├── main.jsx     # React 18 createRoot
│   │   ├── App.jsx      # React Router + route definitions
│   │   ├── api.js       # Fetch wrapper cho tất cả API calls
│   │   ├── index.css    # Global styles
│   │   ├── components\
│   │   │   ├── Layout.jsx          # VisionGuard sidebar + topbar + Outlet
│   │   │   ├── CameraForm.jsx      # Form tạo/sửa camera
│   │   │   ├── EventCard.jsx       # Card hiển thị event trong danh sách
│   │   │   ├── SearchBar.jsx       # Filter/search events (legacy)
│   │   │   └── AnalysisOverlay.jsx # Vẽ bounding box lên ảnh
│   │   └── pages\
│   │       ├── Dashboard.jsx    # Metrics + camera grid + recent events
│   │       ├── Cameras.jsx      # Quản lý camera + live preview + capture
│   │       ├── Events.jsx       # Danh sách events kiểu event-list
│   │       ├── EventDetail.jsx  # Chi tiết event + analysis overlay
│   │       ├── UploadPage.jsx   # Upload ảnh thủ công
│   │       ├── SearchPage.jsx   # Tra cứu nâng cao (bảng kết quả)
│   │       ├── PlatesPage.jsx   # Biển số xe: thống kê + nhật ký
│   │       ├── FacesPage.jsx    # Nhận diện khuôn mặt (stub)
│   │       └── SettingsPage.jsx # Cài đặt hệ thống (stub)
│   └── dist\            # Production build output
│
└── AGENTS.md            # File này
```

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, React Router, Lucide React (icons), date-fns |
| Backend | Node.js, Express 5, Mongoose (MongoDB ODM) |
| Database | MongoDB (local, db name: `camera_surveillance`) |
| File handling | Multer (upload), Sharp (thumbnail), uuid (filename) |
| AI/ML | Python, Ultralytics YOLOv8 (`yolov8n.pt`) |
| Camera integration | pyezviz (EZVIZ), IP Webcam (Android app, MJPEG) |

---

## 3. Environment Variables (backend/.env)

| Variable | Mô tả | Default |
|----------|-------|---------|
| `PORT` | Express server port | `5000` |
| `MONGO_URI` | MongoDB connection string | `mongodb://localhost:27017/camera_surveillance` |
| `ANALYZER_PORT` | Python YOLO server port | `5100` |
| `PYTHON_PATH` | Python executable path | `python` |
| `IP_WEBCAM_URL` | IP Webcam base URL (test endpoint) | — |
| `EZVIZ_EMAIL` | EZVIZ app login email | — |
| `EZVIZ_PASSWORD` | EZVIZ app login password | — |
| `EZVIZ_REGION` | EZVIZ API region | `apiisgp` |

---

## 4. Code Conventions

### Naming

- **Files**: `camelCase.js` cho backend, `PascalCase.jsx` cho React components, `snake_case.py` cho Python
- **Variables/Functions**: `camelCase` (JS), `snake_case` (Python)
- **Models**: `PascalCase` singular (`Camera`, `Event`)
- **Routes**: plural lowercase (`/api/cameras`, `/api/events`)
- **CSS classes**: `kebab-case` (`camera-card`, `section-header`)

### Format & Style

- **Indent**: 2 spaces (JS/JSX), 4 spaces (Python)
- **Quotes**: single quotes cho JS, double quotes cho Python
- **Semicolons**: không dùng trong JS (trừ khi cần thiết)
- **Exports**: `module.exports` (backend CommonJS), `export default` (frontend ESM)
- **React**: functional components only, hooks cho state/effects
- **Error handling**: try/catch trong mọi route handler, trả JSON error

### API Response Format

```js
// Success
res.json({ ...data })
res.status(201).json(createdObject)

// Error
res.status(500).json({ error: err.message })

// List with pagination
res.json({ events: [...], total, page, totalPages })
```

---

## 5. Quy tắc Quan trọng

### KHÔNG ĐƯỢC sửa

- **`backend/.env`** — chứa credentials, chỉ sửa khi user yêu cầu đổi config
- **`backend/uploads/*`** — file do hệ thống tạo, không sửa/xóa thủ công
- **`frontend/dist/*`** — output của `vite build`, không sửa trực tiếp
- **`package-lock.json`** — chỉ thay đổi qua `npm install`, không sửa tay

### PHẢI làm trước khi sửa code

1. **Đọc file liên quan** trước khi edit — hiểu context hiện tại
2. **Kiểm tra linter** sau khi sửa code (`ReadLints`)
3. **Không tạo file mới** nếu có thể sửa file hiện có
4. **Không thêm comment giải thích thay đổi** — code phải tự giải thích

### Khi thêm dependency

- Backend: `npm install <package>` trong `backend/`
- Frontend: `npm install <package>` trong `frontend/`
- Python: `pip install <package>` — ghi chú trong AGENTS.md nếu là dependency mới

### Khi thêm API route mới

1. Tạo route file trong `backend/routes/`
2. Mount trong `backend/server.js` với prefix `/api/<tên>`
3. Thêm API method trong `frontend/src/api.js`
4. Cập nhật frontend component tương ứng

### Khi thêm trang mới (frontend)

1. Tạo page trong `frontend/src/pages/`
2. Thêm route trong `frontend/src/App.jsx`
3. Thêm nav link trong `frontend/src/components/Layout.jsx` (sidebar navItems array)

### UI Design — VisionGuard

- Theme: compact, professional, light-on-white với subtle borders
- Layout: 200px sidebar trái + topbar + content area
- Sidebar navigation: Camera trực tiếp (/), Sự kiện (/events), Tra cứu (/search), Biển số xe (/plates), Nhận diện người (/faces), Cài đặt (/settings)
- Topbar: hệ thống status + đồng hồ realtime + action buttons
- Dashboard: 4 metric cards + grid 2 cột (camera feed + recent events)
- Search page: bảng kết quả dạng table với filters
- Plates page: 4 metric cards + bảng nhật ký biển số

---

## 6. Chạy Project

```bash
# Terminal 1 — Backend
cd backend
npm run dev

# Terminal 2 — Frontend
cd frontend
npm run dev

# Terminal 3 — AI Analyzer (cần cho capture + phân tích)
cd backend
python scripts/analyze_server.py

# Yêu cầu
# - MongoDB đang chạy (localhost:27017)
# - IP Webcam app đang chạy trên điện thoại (nếu dùng IP cam)
```

---

## 7. Luồng hoạt động chính

### Capture ảnh từ IP Webcam
```
[Cameras.jsx] → POST /api/ipcam/capture/:cameraId
  → Fetch ảnh từ http://<IP>:8080/shot.jpg
  → Lưu file uploads/, tạo thumbnail (Sharp)
  → Trả event ngay (fast response)
  → Background: gọi Python YOLO server phân tích → cập nhật event
```

### Capture từ EZVIZ
```
[Cameras.jsx] → POST /api/ezviz/capture/:serial
  → Node spawn ezviz_bridge.py → pyezviz get_last_alarm
  → Download ảnh → lưu uploads/ → phân tích → tạo event
```

### Live Preview
```
[Cameras.jsx] → <img src="http://localhost:5000/api/ipcam/stream/:id">
  → Backend proxy HTTP GET http://<IP>:8080/video (MJPEG)
  → Forward Content-Type + pipe stream → trình duyệt render native
```

### Auto-Watch (tự động capture khi phát hiện người/xe)
```
[Cameras.jsx] → POST /api/watcher/start/:cameraId
  → watcherService.startWatch(cameraId)
    → setInterval(5000ms):
      → Fetch http://<IP>:8080/shot.jpg
      → Gửi tới Python YOLO server (analyze_server.py)
      → Nếu phát hiện person/vehicle:
          → Lưu ảnh uploads/, tạo thumbnail, tạo Event (tags: auto-watch)
      → Nếu không phát hiện: bỏ frame, tiếp tục
      → Cooldown 15s sau mỗi lần lưu (tránh trùng lặp)
[Cameras.jsx] → POST /api/watcher/stop/:cameraId → dừng watch
[Cameras.jsx] → GET /api/watcher/status → danh sách camera đang watch
```

### Tra cứu nâng cao
```
GET /api/events?plate=29A&tag=person&dateFrom=2026-03-01&dateTo=2026-03-24
  → Tìm event theo biển số xe (regex), loại phát hiện, khoảng thời gian
  → Params: cameraId, dateFrom, dateTo, tag, search, plate, minPersons, hasVehicle
```
