import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { X, Video, Clock, User, Car, AlertTriangle, Play } from 'lucide-react';
import { api, uploadsUrl } from '../api';
import ClipPlayer from './ClipPlayer';

function tagLabel(t) {
  const map = { 'auto-watch': 'Auto-watch', 'recording': 'Recording', 'clip': 'Clip', person: 'Người', vehicle: 'Xe', plate: 'Biển số' };
  return map[t] || t;
}

function tagColor(t) {
  if (t === 'person') return '#3b82f6';
  if (t === 'vehicle') return '#f59e0b';
  if (t === 'recording' || t === 'clip') return '#ef4444';
  return '#6b7280';
}

export default function RecordingPanel({ cameraId, cameraName, isOpen, onClose, activeRecording, latestAlerts }) {
  const [clips, setClips] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedClip, setSelectedClip] = useState(null);

  useEffect(() => {
    if (!isOpen || !cameraId) return;
    setLoading(true);
    api.getClips(cameraId)
      .then(setClips)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isOpen, cameraId]);

  const handleDelete = async (clipId) => {
    if (!confirm('Xóa clip này?')) return;
    await api.deleteClip(clipId).catch(() => {});
    setClips((prev) => prev.filter((c) => c._id !== clipId));
    if (selectedClip?._id === clipId) setSelectedClip(null);
  };

  const handleReanalyze = async (clipId) => {
    await api.reanalyzeClip(clipId).catch(() => {});
    const updated = await api.getClips(cameraId).catch(() => []);
    setClips(updated);
    if (selectedClip?._id === clipId) {
      const found = updated.find((c) => c._id === clipId);
      if (found) setSelectedClip(found);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="recording-panel-backdrop" onClick={onClose}>
      <div className="recording-panel" onClick={(e) => e.stopPropagation()}>
        <div className="recording-panel-header">
          <div>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Video size={16} /> Clip của {cameraName || 'Camera'}
            </h3>
            {activeRecording && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginTop: 4, fontSize: 12, color: '#ef4444',
              }}>
                <span className="rec-dot" />
                Đang ghi — {activeRecording.durationSec || 0}s
              </div>
            )}
          </div>
          <button className="btn btn-sm" onClick={onClose} aria-label="Close panel">
            <X size={14} />
          </button>
        </div>

        <div className="recording-panel-body">
          {activeRecording && (
            <div className="active-recording-card">
              <div className="active-recording-meta">
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="rec-dot pulse" />
                  <strong>ĐANG GHI</strong>
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                  Bắt đầu: {activeRecording.recordingStart ? format(new Date(activeRecording.recordingStart), 'HH:mm:ss') : '...'}
                  {activeRecording.pendingTags?.length > 0 && (
                    <span style={{ marginLeft: 8 }}>
                      {activeRecording.pendingTags.map((t) => (
                        <span key={t} style={{
                          background: tagColor(t) + '22',
                          color: tagColor(t),
                          border: `1px solid ${tagColor(t)}44`,
                          borderRadius: 4,
                          padding: '1px 6px',
                          fontSize: 11,
                          fontWeight: 600,
                          marginRight: 4,
                        }}>
                          {tagLabel(t)}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <div className="active-recording-timer">
                  {activeRecording.durationSec || 0}s
                </div>
              </div>
            </div>
          )}

          {selectedClip ? (
            <div className="clip-detail">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <button className="btn btn-sm" onClick={() => setSelectedClip(null)}>
                  ← Quay lại danh sách
                </button>
                <span style={{ fontSize: 13, color: '#6b7280' }}>
                  {format(new Date(selectedClip.recordingStart), 'dd/MM/yyyy HH:mm:ss')}
                </span>
              </div>
              <ClipPlayer
                videoPath={selectedClip.videoPath}
                gifPath={selectedClip.gifPath}
                thumbnailPath={selectedClip.thumbnailPath}
                alt={selectedClip.cameraId?.name || 'Clip'}
              />
              {Array.isArray(selectedClip.tags) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
                  {selectedClip.tags.map((t) => (
                    <span key={t} className="tag" style={{ background: tagColor(t) + '22', color: tagColor(t), border: `1px solid ${tagColor(t)}44` }}>
                      {tagLabel(t)}
                    </span>
                  ))}
                </div>
              )}
              {selectedClip.analysis && (
                <div style={{ marginTop: 12, fontSize: 13, color: '#374151' }}>
                  {(selectedClip.analysis.persons?.length || 0) > 0 && (
                    <div><User size={12} style={{ display: 'inline', marginRight: 4 }} />
                      {selectedClip.analysis.persons.length} người được phát hiện
                    </div>
                  )}
                  {(selectedClip.analysis.vehicles?.length || 0) > 0 && (
                    <div><Car size={12} style={{ display: 'inline', marginRight: 4 }} />
                      {selectedClip.analysis.vehicles.length} phương tiện
                    </div>
                  )}
                  {(selectedClip.analysis.licensePlates?.length || 0) > 0 && (
                    <div><AlertTriangle size={12} style={{ display: 'inline', marginRight: 4 }} />
                      {selectedClip.analysis.licensePlates.map((lp) => lp.plateNumber).join(', ')}
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn btn-sm" onClick={() => handleReanalyze(selectedClip._id)}>
                  Phân tích lại
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => handleDelete(selectedClip._id)}>
                  Xóa clip
                </button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Lịch sử clip ({clips.length})
              </div>
              {loading ? (
                <div style={{ textAlign: 'center', padding: 24, color: '#9ca3af' }}>Đang tải...</div>
              ) : clips.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 24, color: '#9ca3af' }}>
                  Chưa có clip nào
                </div>
              ) : (
                <div className="clip-list">
                  {clips.map((clip) => (
                    <div
                      key={clip._id}
                      className="clip-card"
                      onClick={() => setSelectedClip(clip)}
                    >
                      {clip.thumbnailPath ? (
                        <img
                          src={uploadsUrl(clip.thumbnailPath)}
                          alt="Clip thumbnail"
                          style={{ width: 80, height: 56, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
                        />
                      ) : (
                        <div style={{
                          width: 80, height: 56, background: '#f3f4f6', borderRadius: 4,
                          flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          <Video size={20} color="#9ca3af" />
                        </div>
                      )}
                      <div className="clip-card-info">
                        <div style={{ fontSize: 13, fontWeight: 600 }}>
                          {clip.recordingStart ? format(new Date(clip.recordingStart), 'HH:mm:ss') : '???'}
                          {clip.clipDuration && <span style={{ color: '#6b7280', fontWeight: 400 }}> · {clip.clipDuration}s</span>}
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 2 }}>
                          {clip.tags?.filter((t) => t !== 'auto-watch').map((t) => (
                            <span key={t} style={{
                              background: tagColor(t) + '22',
                              color: tagColor(t),
                              borderRadius: 3,
                              padding: '1px 5px',
                              fontSize: 10,
                              fontWeight: 600,
                            }}>
                              {tagLabel(t)}
                            </span>
                          ))}
                        </div>
                        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                          {clip.cameraId?.name || 'Camera'}
                        </div>
                      </div>
                      <Play size={14} color="#6b7280" style={{ marginLeft: 'auto', flexShrink: 0 }} />
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
