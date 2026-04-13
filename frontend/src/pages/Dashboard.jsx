import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Maximize2, Camera } from 'lucide-react';
import { format } from 'date-fns';
import { api, uploadsUrl } from '../api';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';
import { SkeletonMetric, SkeletonRow } from '../components/Skeleton';
import { isIpWebcamCamera, isEzvizStyleCamera } from '../utils/cameraSource';
import EzvizLiveFrame from '../components/EzvizLiveFrame';
import HlsPlayer from '../components/HlsPlayer';

function CamFeed({ cam, isWatching, hlsUrl, onFullscreen, onCapture }) {
  const isOnline = cam.status === 'online';
  const hasIp = !!cam.ipAddress;
  const liveStream = isOnline && hasIp && isIpWebcamCamera(cam);
  const ezvizCam = isEzvizStyleCamera(cam);
  const canCapture = isOnline && hasIp && (liveStream || ezvizCam);
  const hasHls = !!hlsUrl;

  return (
    <div
      className="cam-feed"
      title={cam.location || cam.name}
      onDoubleClick={() => { if (canCapture) onCapture(cam); }}
      role="button"
      tabIndex={0}
      aria-label={`Camera ${cam.name}${isOnline ? ' - đang phát' : ' - offline'}`}
      onKeyDown={(e) => { if (e.key === 'Enter') onFullscreen(cam); }}
    >
      <div className="cam-feed-actions">
        <button className="cam-feed-btn" onClick={(e) => { e.stopPropagation(); onFullscreen(cam); }} aria-label="Phóng to">
          <Maximize2 size={12} />
        </button>
        {canCapture && (
          <button className="cam-feed-btn" onClick={(e) => { e.stopPropagation(); onCapture(cam); }} aria-label="Chụp ảnh">
            <Camera size={12} />
          </button>
        )}
      </div>
      <div className="cam-bg" style={!isOnline ? { background: '#111' } : undefined}>
        {liveStream ? (
          <img
            src={`/api/ipcam/stream/${cam._id}`}
            alt={cam.name}
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : hasHls ? (
          <HlsPlayer src={hlsUrl} style={{ width: '100%', height: '100%' }} />
        ) : !isOnline ? (
          <div className="cam-offline-content">
            <div className="cam-offline-icon">&#9655;</div>
            <div className="cam-offline-text">MẤT KẾT NỐI</div>
          </div>
        ) : ezvizCam && hasIp ? (
          <EzvizLiveFrame cameraId={cam._id} alt={cam.name} />
        ) : (
          <span className="cam-icon">&#9679;</span>
        )}
      </div>
      <div className="cam-overlay">
        <span className="cam-name">{cam.name}{cam.location ? ` — ${cam.location}` : ''}</span>
        <span className={`cam-status ${isOnline ? 'live' : 'offline'}`}>
          &#9632;{' '}
          {isOnline
            ? (hasHls ? 'HLS LIVE' : ezvizCam ? 'CLOUD' : isWatching ? 'WATCHING' : 'LIVE')
            : 'OFFLINE'}
        </span>
      </div>
    </div>
  );
}

function getTagClass(tags) {
  if (!tags) return 'tag-person';
  if (tags.includes('person')) return 'tag-person';
  if (tags.includes('plate') || tags.includes('license-plate')) return 'tag-plate';
  if (tags.includes('vehicle')) return 'tag-person';
  return 'tag-person';
}

function getTagLabel(tags) {
  if (!tags || tags.length === 0) return 'Sự kiện';
  if (tags.includes('person')) return 'Người';
  if (tags.includes('plate') || tags.includes('license-plate')) return 'Biển số';
  if (tags.includes('vehicle')) return 'Phương tiện';
  return tags[0];
}

function getEventDescription(event) {
  const { analysis } = event;
  const camName = event.cameraId?.name || 'Camera';
  if (analysis?.licensePlates?.length > 0) return analysis.licensePlates[0].plateNumber;
  if (analysis?.persons?.length > 0) return `Phát hiện ${analysis.persons.length} người tại ${camName}`;
  if (analysis?.vehicles?.length > 0) return `${analysis.vehicles.length} phương tiện tại ${camName}`;
  return `Sự kiện tại ${camName}`;
}

function getEventConfidence(event) {
  const { analysis } = event;
  if (analysis?.persons?.length > 0) {
    const best = Math.max(...analysis.persons.map(p => p.confidence || 0));
    if (best > 0) return `${(best * 100).toFixed(0)}%`;
  }
  if (analysis?.licensePlates?.length > 0) return 'Đã nhận dạng';
  if (analysis?.vehicles?.length > 0) {
    const best = Math.max(...analysis.vehicles.map(v => v.confidence || 0));
    if (best > 0) return `${(best * 100).toFixed(0)}%`;
  }
  return '';
}

function getThumbStyle(tags) {
  if (!tags) return { background: '#0a1a0a', color: '#5DCAA5' };
  if (tags.includes('plate') || tags.includes('license-plate')) return { background: '#1a0d00', color: '#FAC775' };
  if (tags.includes('person')) return { background: '#0a1a0a', color: '#5DCAA5' };
  return { background: '#0a1a0a', color: '#5DCAA5' };
}

export default function Dashboard() {
  const navigate = useNavigate();
  const addToast = useToast();
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [watching, setWatching] = useState(new Set());
  const [hlsStreams, setHlsStreams] = useState({});
  const [loading, setLoading] = useState(true);
  const [fullscreenCam, setFullscreenCam] = useState(null);

  const loadAll = useCallback(async () => {
    try {
      const [s, ev, cams] = await Promise.all([
        api.getStats(),
        api.getEvents({ limit: 6 }),
        api.getCameras(),
      ]);
      setStats(s);
      setRecent(ev.events || []);
      setCameras(cams);
    } catch { /* ignore */ }

    try {
      const ws = await api.watcherStatus();
      setWatching(new Set(ws.map((w) => String(w.cameraId))));
    } catch { /* ignore */ }

    try {
      const ss = await api.streamStatus();
      const map = {};
      ss.forEach((s) => { map[s.cameraId] = s.hlsUrl; });
      setHlsStreams(map);
    } catch { /* ignore */ }

    setLoading(false);
  }, []);

  useEffect(() => {
    loadAll();
    const t = setInterval(loadAll, 30000);
    return () => clearInterval(t);
  }, [loadAll]);

  const handleCapture = async (cam) => {
    try {
      addToast(`Đang chụp từ ${cam.name}...`, 'info', 2000);
      const event = isEzvizStyleCamera(cam)
        ? await api.ezvizCapture(cam.ipAddress)
        : await api.ipcamCapture(cam._id);
      addToast(`Đã chụp thành công từ ${cam.name}`, 'success');
      navigate(`/events/${event._id}`);
    } catch (err) {
      addToast(`Lỗi chụp: ${err.message}`, 'error');
    }
  };

  const online = cameras.filter((c) => c.status === 'online').length;
  const offline = cameras.length - online;

  return (
    <>
      <div className="metrics">
        {loading ? (
          <>
            <SkeletonMetric />
            <SkeletonMetric />
            <SkeletonMetric />
            <SkeletonMetric />
          </>
        ) : (
          <>
            <div className="metric-card">
              <div className="metric-label">Camera online</div>
              <div className="metric-value green">{online}/{cameras.length}</div>
              <div className="metric-sub">{offline > 0 ? `${offline} đang offline` : 'Tất cả hoạt động'}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Sự kiện hôm nay</div>
              <div className="metric-value blue">{stats?.todayEvents ?? '-'}</div>
              <div className="metric-sub">Tổng sự kiện</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Người phát hiện</div>
              <div className="metric-value">{stats?.personEvents ?? '-'}</div>
              <div className="metric-sub">Người qua camera</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Biển số nhận dạng</div>
              <div className="metric-value">{stats?.vehicleEvents ?? '-'}</div>
              <div className="metric-sub">Phương tiện ghi nhận</div>
            </div>
          </>
        )}
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <span className="card-title">Màn hình camera</span>
            <span className="text-muted">{online} đang phát</span>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="cam-grid">
                {[1,2,3,4].map(i => <div key={i} className="skeleton" style={{ aspectRatio: '16/9', borderRadius: 6 }} />)}
              </div>
            ) : cameras.length === 0 ? (
              <div className="empty-text">
                Chưa có camera. <Link to="/cameras" style={{ color: 'var(--blue)' }}>Thêm camera</Link>
              </div>
            ) : (
              <div className="cam-grid">
                {cameras.slice(0, 4).map((cam) => (
                  <CamFeed
                    key={cam._id}
                    cam={cam}
                    isWatching={watching.has(String(cam._id))}
                    hlsUrl={hlsStreams[cam._id] || null}
                    onFullscreen={setFullscreenCam}
                    onCapture={handleCapture}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="card-title">Sự kiện gần đây</span>
            <Link to="/events" className="btn btn-sm">Xem tất cả</Link>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="event-list">
                {[1,2,3,4].map(i => <SkeletonRow key={i} />)}
              </div>
            ) : recent.length === 0 ? (
              <div className="empty-text">Chưa có sự kiện.</div>
            ) : (
              <div className="event-list">
                {recent.map((ev) => (
                  <Link key={ev._id} to={`/events/${ev._id}`} className="event-item">
                    <div className="event-thumb" style={getThumbStyle(ev.tags)}>
                      {ev.thumbnailPath ? (
                        <img src={uploadsUrl(ev.thumbnailPath)} alt="" />
                      ) : (
                        <span>&#9632;</span>
                      )}
                    </div>
                    <div className="event-info">
                      <div className="event-title">
                        <span className={`tag ${getTagClass(ev.tags)}`}>{getTagLabel(ev.tags)}</span>
                        {getEventDescription(ev)}
                      </div>
                      <div className="event-meta">
                        {ev.cameraId?.name || 'Camera'} &middot; {format(new Date(ev.capturedAt), 'HH:mm:ss')}
                        {getEventConfidence(ev) && ` · ${getEventConfidence(ev)}`}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal
        open={!!fullscreenCam}
        onClose={() => setFullscreenCam(null)}
        title={fullscreenCam ? `${fullscreenCam.name}${fullscreenCam.location ? ` — ${fullscreenCam.location}` : ''}` : ''}
      >
        {fullscreenCam && hlsStreams[fullscreenCam._id] ? (
          <HlsPlayer
            src={hlsStreams[fullscreenCam._id]}
            style={{ width: '100%', maxHeight: '80vh' }}
          />
        ) : fullscreenCam && fullscreenCam.ipAddress && fullscreenCam.status === 'online' && isIpWebcamCamera(fullscreenCam) ? (
          <img
            src={`/api/ipcam/stream/${fullscreenCam._id}`}
            alt={fullscreenCam.name}
            style={{ width: '100%', maxHeight: '80vh' }}
          />
        ) : fullscreenCam && isEzvizStyleCamera(fullscreenCam) && fullscreenCam.status === 'online' ? (
          <div style={{ width: '100%', maxHeight: '80vh', position: 'relative' }}>
            <EzvizLiveFrame
              cameraId={fullscreenCam._id}
              intervalMs={3500}
              alt={fullscreenCam.name}
              style={{ width: '100%', maxHeight: '80vh', objectFit: 'contain', background: '#0a0a0a' }}
            />
            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--color-text-secondary)', textAlign: 'center' }}>
              EZVIZ: ảnh cloud. Bấm "Live Stream" trong trang Cameras để xem HLS live.
            </p>
          </div>
        ) : (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 13 }}>
            Camera offline hoặc không có IP
          </div>
        )}
      </Modal>
    </>
  );
}
