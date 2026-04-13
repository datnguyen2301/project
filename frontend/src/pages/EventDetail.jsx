import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Trash2, RefreshCw, ArrowLeft, User, Car, CreditCard, Eye, EyeOff, ChevronLeft, ChevronRight, Video } from 'lucide-react';
import { format } from 'date-fns';
import { api, uploadsUrl } from '../api';
import AnalysisOverlay from '../components/AnalysisOverlay';
import ClipPlayer from '../components/ClipPlayer';

export default function EventDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const imgRef = useRef(null);
  const [event, setEvent] = useState(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0, nw: 0, nh: 0 });
  const [loading, setLoading] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [timeline, setTimeline] = useState([]);

  useEffect(() => {
    api.getEvent(id).then((ev) => {
      setEvent(ev);
      if (ev.cameraId?._id) {
        api.getEvents({ cameraId: ev.cameraId._id, limit: 10 }).then((d) => {
          setTimeline(d.events || []);
        }).catch(() => {});
      }
    }).catch(() => navigate('/events'));
  }, [id, navigate]);

  const handleImgLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    setImgSize({ w: img.width, h: img.height, nw: img.naturalWidth, nh: img.naturalHeight });
  };

  const handleDelete = async () => {
    if (!confirm('Xóa sự kiện này?')) return;
    await api.deleteEvent(id);
    navigate('/events');
  };

  const handleReanalyze = async () => {
    setLoading(true);
    try {
      const updated = await api.reanalyze(id);
      setEvent(updated);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const currentIdx = timeline.findIndex(ev => ev._id === id);
      if (e.key === 'ArrowLeft' && currentIdx > 0) {
        navigate(`/events/${timeline[currentIdx - 1]._id}`);
      } else if (e.key === 'ArrowRight' && currentIdx < timeline.length - 1) {
        navigate(`/events/${timeline[currentIdx + 1]._id}`);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [id, timeline, navigate]);

  if (!event) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div className="skeleton" style={{ width: 200, height: 20, margin: '0 auto 12px' }} />
        <div className="skeleton" style={{ width: '100%', height: 300, borderRadius: 8 }} />
      </div>
    );
  }

  const { analysis } = event;
  const tagLabel = (t) => {
    const map = { 'auto-watch': 'Auto-watch', person: 'Người', vehicle: 'Xe', plate: 'Biển số' };
    return map[t] || t;
  };
  const currentIdx = timeline.findIndex(ev => ev._id === id);
  const prevEvent = currentIdx > 0 ? timeline[currentIdx - 1] : null;
  const nextEvent = currentIdx < timeline.length - 1 ? timeline[currentIdx + 1] : null;

  return (
    <>
      <div className="detail-header">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={() => navigate('/events')} aria-label="Quay lại">
            <ArrowLeft size={14} /> Quay lại
          </button>
          {prevEvent && (
            <Link to={`/events/${prevEvent._id}`} className="btn btn-sm" aria-label="Sự kiện trước">
              <ChevronLeft size={14} />
            </Link>
          )}
          {nextEvent && (
            <Link to={`/events/${nextEvent._id}`} className="btn btn-sm" aria-label="Sự kiện sau">
              <ChevronRight size={14} />
            </Link>
          )}
        </div>
        <div className="detail-actions">
          <button
            className="btn btn-sm"
            onClick={() => setShowOverlay((s) => !s)}
            aria-label={showOverlay ? 'Ẩn bounding box' : 'Hiện bounding box'}
          >
            {showOverlay ? <EyeOff size={14} /> : <Eye size={14} />}
            {showOverlay ? ' Ẩn overlay' : ' Hiện overlay'}
          </button>
          <button className="btn" onClick={handleReanalyze} disabled={loading} aria-label="Phân tích lại">
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Phân tích lại
          </button>
          <button className="btn btn-danger" onClick={handleDelete} aria-label="Xóa sự kiện">
            <Trash2 size={14} /> Xóa
          </button>
        </div>
      </div>

      <div className="detail-body">
        <div className="detail-image-wrap">
          {event.type === 'clip' ? (
            <ClipPlayer
              videoPath={event.videoPath}
              gifPath={event.gifPath}
              thumbnailPath={event.thumbnailPath}
              alt="Clip"
            />
          ) : (
            <img
              ref={imgRef}
              src={uploadsUrl(event.imagePath)}
              alt="capture"
              className="detail-image"
              onLoad={handleImgLoad}
            />
          )}
          {event.type !== 'clip' && showOverlay && (
            <AnalysisOverlay
              analysis={analysis}
              imgWidth={imgSize.w}
              imgHeight={imgSize.h}
              naturalWidth={imgSize.nw}
              naturalHeight={imgSize.nh}
            />
          )}
        </div>

        <div className="detail-info">
          <h2>Thông tin sự kiện</h2>
          <div className="info-row"><strong>Camera:</strong> {event.cameraId?.name || 'Không rõ'}</div>
          <div className="info-row"><strong>Vị trí:</strong> {event.cameraId?.location || '-'}</div>
          <div className="info-row"><strong>Thời gian:</strong> {format(new Date(event.capturedAt), 'dd/MM/yyyy HH:mm:ss')}</div>
          {event.type === 'clip' && event.clipDuration && (
            <div className="info-row">
              <strong>Thời lượng clip:</strong> {event.clipDuration}s
            </div>
          )}
          {event.type === 'clip' && event.recordingStart && (
            <div className="info-row">
              <strong>Recording:</strong> {format(new Date(event.recordingStart), 'HH:mm:ss')} — {format(new Date(event.recordingEnd || event.recordingStart), 'HH:mm:ss')}
            </div>
          )}
          {event.notes && <div className="info-row"><strong>Ghi chú:</strong> {event.notes}</div>}

          <h3>Kết quả phân tích</h3>

          {Array.isArray(event.tags) && event.tags.length > 0 && (
            <div className="event-card-tags" style={{ marginBottom: 10 }}>
              {event.tags.map((t) => (
                <span key={t} className="tag tag-warn">{tagLabel(t)}</span>
              ))}
            </div>
          )}

          {analysis?.persons?.length > 0 && (
            <div className="analysis-section">
              <h4><User size={14} /> Người ({analysis.persons.length})</h4>
              {analysis.persons.map((p, i) => (
                <div key={i} className="analysis-item">Người #{i + 1} — Tin cậy: {(p.confidence * 100).toFixed(0)}%</div>
              ))}
            </div>
          )}

          {analysis?.vehicles?.length > 0 && (
            <div className="analysis-section">
              <h4><Car size={14} /> Phương tiện ({analysis.vehicles.length})</h4>
              {analysis.vehicles.map((v, i) => (
                <div key={i} className="analysis-item">{v.type} — Tin cậy: {(v.confidence * 100).toFixed(0)}%</div>
              ))}
            </div>
          )}

          {analysis?.licensePlates?.length > 0 && (
            <div className="analysis-section">
              <h4><CreditCard size={14} /> Biển số ({analysis.licensePlates.length})</h4>
              {analysis.licensePlates.map((lp, i) => (
                <div key={i} className="analysis-item plate-number">{lp.plateNumber} — {(lp.confidence * 100).toFixed(0)}%</div>
              ))}
            </div>
          )}

          {timeline.length > 1 && (
            <div className="timeline-section">
              <h4>Sự kiện cùng camera</h4>
              <div className="timeline-list">
                {timeline.map((ev) => (
                  <Link
                    key={ev._id}
                    to={`/events/${ev._id}`}
                    className={`timeline-item${ev._id === id ? ' current' : ''}`}
                  >
                    <span className="timeline-time">{format(new Date(ev.capturedAt), 'HH:mm:ss')}</span>
                    <span className="timeline-desc">
                      {ev.tags?.includes('person') ? 'Người' : ev.tags?.includes('vehicle') ? 'Phương tiện' : 'Sự kiện'}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
