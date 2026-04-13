import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Pencil, Trash2, Wifi, WifiOff, RefreshCw, Camera as CameraIcon, Eye, EyeOff, Radio, Square, Play, StopCircle, AlertCircle, Video, Circle } from 'lucide-react';
import { api, uploadsUrl } from '../api';
import CameraForm from '../components/CameraForm';
import { isIpWebcamCamera, isEzvizStyleCamera } from '../utils/cameraSource';
import EzvizLiveFrame from '../components/EzvizLiveFrame';
import HlsPlayer from '../components/HlsPlayer';
import RecordingPanel from '../components/RecordingPanel';

function LivePreview({ cameraId }) {
  const streamUrl = `/api/ipcam/stream/${cameraId}`;

  return (
    <div className="camera-preview">
      <img
        src={streamUrl}
        alt="Live stream"
        onError={(e) => { e.target.alt = 'Cannot connect to camera'; }}
      />
    </div>
  );
}

export default function Cameras() {
  const navigate = useNavigate();
  const [cameras, setCameras] = useState([]);
  const [editing, setEditing] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [preview, setPreview] = useState(null);
  const [watching, setWatching] = useState(new Set());
  const [hlsStreams, setHlsStreams] = useState({});
  const [streamLoading, setStreamLoading] = useState(null);
  const [streamErrors, setStreamErrors] = useState({});
  const [latestEvents, setLatestEvents] = useState({});
  const [latestAlerts, setLatestAlerts] = useState([]);
  const [recordingPanel, setRecordingPanel] = useState({ open: false, cameraId: null });
  const [activeRecordings, setActiveRecordings] = useState({});

  const load = () => api.getCameras().then(setCameras).catch(() => {});

  const loadWatcherStatus = useCallback(async () => {
    try {
      const status = await api.watcherStatus();
      const ids = new Set(status.map((s) => String(s.cameraId)));
      setWatching(ids);

      const recStatus = await api.getRecordingStatus();
      const recMap = {};
      recStatus.forEach((r) => { recMap[String(r.cameraId)] = r; });
      setActiveRecordings(recMap);
    } catch { /* ignore */ }
  }, []);

  const loadStreamStatus = useCallback(async () => {
    try {
      const ss = await api.streamStatus();
      const map = {};
      ss.forEach((s) => { map[String(s.cameraId)] = s.hlsUrl; });
      setHlsStreams(map);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); loadWatcherStatus(); loadStreamStatus(); }, []);

  const recordingTimerRef = useRef(null);
  useEffect(() => {
    if (Object.keys(activeRecordings).length === 0) {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      return;
    }
    if (!recordingTimerRef.current) {
      recordingTimerRef.current = setInterval(() => {
        setActiveRecordings((prev) => {
          const next = { ...prev };
          let changed = false;
          for (const cid in next) {
            const rec = next[cid];
            if (rec.recordingStart) {
              const dur = Math.round((Date.now() - new Date(rec.recordingStart).getTime()) / 1000);
              if (dur !== rec.durationSec) {
                next[cid] = { ...rec, durationSec: dur };
                changed = true;
              }
            }
          }
          return changed ? next : prev;
        });
      }, 1000);
    }
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
  }, [Object.keys(activeRecordings).length]);

  useEffect(() => {
    if (watching.size === 0) return;
    const t = setInterval(loadWatcherStatus, 10000);
    return () => clearInterval(t);
  }, [watching.size, loadWatcherStatus]);

  // SSE: real-time watcher events + status updates
  useEffect(() => {
    const es = api.watcherStream();

    es.addEventListener('watcher-event', (e) => {
      try {
        const data = JSON.parse(e.data);
        const { cameraId, tags, thumbnailPath, imagePath, cameraName, capturedAt, analysis } = data;
        setLatestEvents((prev) => ({ ...prev, [cameraId]: { thumbnailPath, imagePath, tags, cameraName, capturedAt, analysis } }));
        setLatestAlerts((prev) => {
          const next = [{ cameraId, tags, thumbnailPath, cameraName, capturedAt, analysis }, ...prev].slice(0, 10);
          return next;
        });
      } catch (_) {}
    });

    es.addEventListener('watcher-status', (e) => {
      try {
        const status = JSON.parse(e.data);
        const ids = new Set(status.map((s) => String(s.cameraId)));
        setWatching(ids);
      } catch (_) {}
    });

    es.addEventListener('recording-start', (e) => {
      try {
        const data = JSON.parse(e.data);
        const cid = String(data.cameraId);
        setActiveRecordings((prev) => ({
          ...prev,
          [cid]: {
            cameraName: data.cameraName,
            recordingStart: new Date(),
            tags: data.tags || [],
            durationSec: 0,
          },
        }));
      } catch (_) {}
    });

    es.addEventListener('recording-stop', (e) => {
      try {
        const data = JSON.parse(e.data);
        const cid = String(data.cameraId);
        setActiveRecordings((prev) => {
          const next = { ...prev };
          delete next[cid];
          return next;
        });
      } catch (_) {}
    });

    es.addEventListener('recording-complete', (e) => {
      try {
        const data = JSON.parse(e.data);
        const cid = String(data.cameraId);
        setActiveRecordings((prev) => {
          const next = { ...prev };
          delete next[cid];
          return next;
        });
        setLatestEvents((prev) => ({
          ...prev,
          [cid]: {
            thumbnailPath: data.thumbnailPath,
            tags: data.tags,
            cameraName: data.cameraName,
            capturedAt: new Date(),
            isClip: true,
            videoPath: data.videoPath,
          },
        }));
        setLatestAlerts((prev) => {
          const next = [
            { cameraId: cid, tags: data.tags, thumbnailPath: data.thumbnailPath, cameraName: data.cameraName, capturedAt: new Date(), isClip: true },
            ...prev,
          ].slice(0, 10);
          return next;
        });
      } catch (_) {}
    });

    es.onerror = () => {};
    return () => es.close();
  }, []);

  const handleCreate = async (data) => {
    await api.createCamera(data);
    setShowForm(false);
    load();
  };

  const handleUpdate = async (data) => {
    await api.updateCamera(editing._id, data);
    setEditing(null);
    load();
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this camera?')) return;
    await api.deleteCamera(id);
    load();
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await api.ezvizSyncCameras();
      alert(`Synced ${result.synced} cameras from EZVIZ`);
      load();
    } catch (err) {
      alert(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const handlePreview = useCallback((cam) => {
    setPreview((prev) => prev === cam._id ? null : cam._id);
  }, []);

  const handleStream = async (cam) => {
    const id = cam._id;
    setStreamLoading(id);
    setStreamErrors((prev) => { const n = { ...prev }; delete n[String(id)]; return n; });
    try {
      if (hlsStreams[String(id)]) {
        await api.streamStop(id);
        setHlsStreams((prev) => { const n = { ...prev }; delete n[String(id)]; return n; });
      } else {
        const result = await api.streamStart(id);
        setHlsStreams((prev) => ({ ...prev, [String(id)]: result.hlsUrl }));
        setPreview(id);
      }
    } catch (err) {
      setStreamErrors((prev) => ({ ...prev, [String(id)]: err.message }));
    } finally {
      setStreamLoading(null);
    }
  };

  const handleWatch = async (cam) => {
    const id = String(cam._id);
    const wasOn = watching.has(id);
    if (wasOn) {
      setWatching((prev) => { const s = new Set(prev); s.delete(id); return s; });
    } else {
      setWatching((prev) => new Set(prev).add(id));
    }
    try {
      if (wasOn) {
        await api.watcherStop(id);
      } else {
        await api.watcherStart(id);
      }
      loadWatcherStatus();
    } catch (err) {
      setWatching((prev) => {
        const s = new Set(prev);
        if (wasOn) s.add(id); else s.delete(id);
        return s;
      });
      alert(`Watch toggle failed: ${err.message}`);
    }
  };

  return (
    <div className="page">
      <div className="section-header">
        <h1>Cameras</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          {Object.keys(activeRecordings).length > 0 && (
            <button
              className="btn"
              onClick={() => {
                const firstCid = Object.keys(activeRecordings)[0];
                const cam = cameras.find((c) => String(c._id) === firstCid);
                setRecordingPanel({ open: true, cameraId: firstCid, cameraName: cam?.name });
              }}
              style={{ borderColor: '#ef4444', color: '#ef4444' }}
            >
              <span className="rec-dot" style={{ display: 'inline-block', width: 8, height: 8, background: '#ef4444', borderRadius: '50%' }} />
              {Object.keys(activeRecordings).length} Recording{Object.keys(activeRecordings).length > 1 ? 's' : ''}
            </button>
          )}
          <button className="btn" onClick={handleSync} disabled={syncing}>
            <RefreshCw size={16} className={syncing ? 'spin' : ''} /> Sync EZVIZ
          </button>
          <button className="btn btn-primary" onClick={() => { setShowForm(true); setEditing(null); }}>
            <Plus size={16} /> Add Camera
          </button>
        </div>
      </div>

      {latestAlerts.length > 0 && (
        <div style={{
          marginBottom: 16,
          padding: '10px 14px',
          background: '#fff',
          border: '1px solid #d1fae5',
          borderRadius: 8,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#065f46', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Recent Detections ({latestAlerts.length})
          </div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
            {latestAlerts.map((alert, i) => (
              <div
                key={`${alert.cameraId}-${alert.capturedAt}-${i}`}
                style={{
                  flexShrink: 0,
                  width: 100,
                  borderRadius: 6,
                  overflow: 'hidden',
                  border: '1px solid #bbf7d0',
                  cursor: 'pointer',
                  position: 'relative',
                }}
                onClick={() => navigate('/events')}
                title={`${alert.cameraName} — ${alert.tags.join(', ')}`}
              >
                {alert.thumbnailPath ? (
                  <img
                    src={uploadsUrl(alert.thumbnailPath)}
                    alt={alert.cameraName}
                    style={{ width: '100%', height: 60, objectFit: 'cover', display: 'block' }}
                  />
                ) : (
                  <div style={{ width: '100%', height: 60, background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <CameraIcon size={20} color="#16a34a" />
                  </div>
                )}
                <div style={{
                  background: '#dc2626',
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 700,
                  padding: '2px 4px',
                  textAlign: 'center',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {alert.tags.filter(t => t !== 'auto-watch').join(', ')}
                </div>
                <div style={{ fontSize: 9, color: '#6b7280', padding: '2px 4px', background: '#f9fafb' }}>
                  {alert.cameraName?.slice(0, 12) || 'Unknown'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(showForm && !editing) && (
        <div className="form-panel">
          <h3>New Camera</h3>
          <CameraForm onSubmit={handleCreate} onCancel={() => setShowForm(false)} />
        </div>
      )}

      {editing && (
        <div className="form-panel">
          <h3>Edit Camera</h3>
          <CameraForm initial={editing} onSubmit={handleUpdate} onCancel={() => setEditing(null)} />
        </div>
      )}

      {cameras.length === 0 ? (
        <p className="empty-text">No cameras yet. Add one or sync from EZVIZ.</p>
      ) : (
        <div className="camera-list">
          {cameras.map((cam) => {
            const sid = String(cam._id);
            const isWatching = watching.has(sid);
            const hlsActive = Boolean(hlsStreams[sid]);
            return (
              <div key={cam._id} className={`camera-card${isWatching ? ' watching' : ''}`}>
                <div className="camera-card-status">
                  {cam.status === 'online'
                    ? <Wifi size={20} className="text-green" />
                    : <WifiOff size={20} className="text-red" />}
                </div>
                <div className="camera-card-body">
                  <div className="camera-card-name">
                    {cam.name}
                    {isWatching && (
                      <span className="badge badge-watching">
                        <Radio size={12} className="pulse-anim" /> Watching
                      </span>
                    )}
                  </div>
                  <div className="text-muted">{cam.location || 'No location'}</div>
                  <div className="text-muted">
                    {cam.type}
                    {cam.ipAddress && ` — ${cam.ipAddress}`}
                    {isEzvizStyleCamera(cam) && ' (EZVIZ)'}
                  </div>

                  {preview === cam._id && hlsActive && (
                    <div className="camera-preview" style={{ marginTop: 8 }}>
                      <HlsPlayer
                        src={hlsStreams[sid]}
                        style={{ width: '100%', maxHeight: 320, borderRadius: 6 }}
                      />
                    </div>
                  )}
                  {streamErrors[sid] && (
                    <div style={{
                      marginTop: 6, padding: '6px 10px',
                      background: '#fef2f2', border: '1px solid #fca5a5',
                      borderRadius: 6, color: '#dc2626', fontSize: 12,
                    }}>
                      Stream error: {streamErrors[sid]}
                    </div>
                  )}
                  {preview === cam._id && !hlsActive && cam.ipAddress && isIpWebcamCamera(cam) && (
                    <LivePreview cameraId={cam._id} />
                  )}
                  {preview === cam._id && !hlsActive && isEzvizStyleCamera(cam) && (
                    <div className="camera-preview" style={{ marginTop: 8 }}>
                      <EzvizLiveFrame
                        cameraId={cam._id}
                        intervalMs={4000}
                        alt={cam.name}
                        style={{ width: '100%', display: 'block', maxHeight: 280, objectFit: 'cover' }}
                      />
                    </div>
                  )}
                  {isWatching && latestEvents[sid] && latestEvents[sid].thumbnailPath && (
                    <div style={{ marginTop: 8, borderRadius: 6, overflow: 'hidden', border: '2px solid #22c55e', position: 'relative' }}>
                      <img
                        src={uploadsUrl(latestEvents[sid].thumbnailPath)}
                        alt={`Detection on ${cam.name}`}
                        style={{ width: '100%', maxHeight: 180, objectFit: 'cover', display: 'block' }}
                      />
                      <div style={{
                        position: 'absolute', top: 6, left: 6,
                        background: 'rgba(220,38,38,0.9)', color: '#fff',
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                        display: 'flex', alignItems: 'center', gap: 4,
                      }}>
                        <AlertCircle size={11} /> DETECTED: {latestEvents[sid].tags.filter(t => t !== 'auto-watch').join(', ')}
                      </div>
                    </div>
                  )}

                  {activeRecordings[sid] && (
                    <div
                      style={{
                        marginTop: 8, borderRadius: 6, overflow: 'hidden',
                        border: '2px solid #ef4444', position: 'relative', cursor: 'pointer',
                      }}
                      onClick={() => setRecordingPanel({ open: true, cameraId: sid })}
                      title="Click to view recording panel"
                    >
                      <div style={{
                        width: '100%', height: 160, background: '#1a1a1a',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>
                        <div style={{ textAlign: 'center', color: '#ef4444' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                            <span className="rec-dot pulse" />
                            <span style={{ fontSize: 20, fontWeight: 900 }}>REC</span>
                          </div>
                          <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                            {String(Math.floor((activeRecordings[sid].durationSec || 0) / 60)).padStart(2, '0')}:
                            {String((activeRecordings[sid].durationSec || 0) % 60).padStart(2, '0')}
                          </div>
                        </div>
                      </div>
                      <div style={{
                        position: 'absolute', top: 6, right: 6,
                        background: 'rgba(239,68,68,0.9)', color: '#fff',
                        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                      }}>
                        <Video size={10} style={{ display: 'inline', marginRight: 4 }} />
                        RECORDING
                      </div>
                    </div>
                  )}
                </div>
                <div className="camera-card-actions">
                  {(isIpWebcamCamera(cam) || isEzvizStyleCamera(cam)) && (
                    <button
                      className={`btn btn-sm${isWatching ? ' btn-danger' : ' btn-watch'}`}
                      onClick={() => handleWatch(cam)}
                      title={
                        isEzvizStyleCamera(cam) && !isIpWebcamCamera(cam)
                          ? (isWatching ? 'Stop auto-watch' : 'Auto-watch: needs RTSP + Verify Code, same LAN')
                          : (isWatching ? 'Stop auto-watch' : 'Start auto-watch')
                      }
                    >
                      {isWatching ? <Square size={14} /> : <Radio size={14} />}
                      {isWatching ? ' Stop' : ' Watch'}
                    </button>
                  )}
                  {(isIpWebcamCamera(cam) || isEzvizStyleCamera(cam)) && (
                    <button
                      className={`btn btn-sm${preview === cam._id ? ' btn-active' : ''}`}
                      onClick={() => handlePreview(cam)}
                      title={isEzvizStyleCamera(cam) ? 'EZVIZ cloud image (periodic refresh)' : 'Live preview'}
                    >
                      {preview === cam._id ? <EyeOff size={14} /> : <Eye size={14} />}
                      {preview === cam._id ? ' Hide' : ' Preview'}
                    </button>
                  )}
                  {isEzvizStyleCamera(cam) && (
                    <button
                      className={`btn btn-sm${hlsActive ? ' btn-danger' : ''}`}
                      onClick={() => handleStream(cam)}
                      disabled={streamLoading === cam._id}
                      title={
                        hlsActive
                          ? 'Stop HLS live stream'
                          : `HLS (RTSP LAN). EZVIZ status: ${cam.status === 'online' ? 'online' : 'offline — still trying if camera is on same network'}`
                      }
                    >
                      {streamLoading === cam._id ? (
                        <RefreshCw size={14} className="spin" />
                      ) : hlsActive ? (
                        <StopCircle size={14} />
                      ) : (
                        <Play size={14} />
                      )}
                      {hlsActive ? ' Stop' : ' HLS'}
                    </button>
                  )}
                  <button className="btn btn-sm" onClick={() => { setEditing(cam); setShowForm(false); }}><Pencil size={14} /></button>
                  <button className="btn btn-sm btn-danger" onClick={() => handleDelete(cam._id)}><Trash2 size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <RecordingPanel
        isOpen={recordingPanel.open}
        cameraId={recordingPanel.cameraId}
        cameraName={recordingPanel.cameraName || cameras.find((c) => String(c._id) === recordingPanel.cameraId)?.name}
        activeRecording={recordingPanel.cameraId ? activeRecordings[recordingPanel.cameraId] : null}
        latestAlerts={latestAlerts}
        onClose={() => setRecordingPanel({ open: false, cameraId: null })}
      />
    </div>
  );
}
