import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { UserPlus, Trash2, ShieldAlert, UserCheck, Upload, Images, X } from 'lucide-react';
import { api, uploadsUrl } from '../api';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';

/**
 * Lets the user click the right person when an event frame holds several faces.
 * Boxes are positioned as percentages of the natural image size, so they stay
 * aligned however the browser scales the picture.
 */
function FacePicker({ event, faces, onPick, onCancel }) {
  const [natural, setNatural] = useState(null);

  return (
    <div style={{ padding: 14, maxWidth: 720 }}>
      <p style={{ marginBottom: 12, fontSize: 13 }}>
        Ảnh có <strong>{faces.length}</strong> khuôn mặt. Bấm vào khuôn mặt của người bạn muốn đăng ký:
      </p>
      <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
        <img
          src={uploadsUrl(event.imagePath)}
          alt=""
          style={{ maxWidth: '100%', display: 'block', borderRadius: 6 }}
          onLoad={(e) => setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight })}
        />
        {natural && faces.map((f) => (
          <button
            key={f.index}
            onClick={() => onPick(f.index)}
            title={`Chọn khuôn mặt #${f.index + 1}`}
            style={{
              position: 'absolute',
              left: `${(f.bbox.x / natural.w) * 100}%`,
              top: `${(f.bbox.y / natural.h) * 100}%`,
              width: `${(f.bbox.width / natural.w) * 100}%`,
              height: `${(f.bbox.height / natural.h) * 100}%`,
              border: '3px solid #22c55e',
              background: 'rgba(34,197,94,0.15)',
              borderRadius: 4,
              cursor: 'pointer',
              padding: 0,
              color: '#fff',
              fontWeight: 800,
              fontSize: 13,
              textShadow: '0 1px 3px #000',
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'flex-start',
            }}
          >
            <span style={{ background: '#22c55e', padding: '0 5px', borderRadius: 3, lineHeight: '18px' }}>
              {f.index + 1}
            </span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 12, textAlign: 'right' }}>
        <button className="btn" onClick={onCancel}>Hủy</button>
      </div>
    </div>
  );
}

export default function FacesPage() {
  const addToast = useToast();
  const [people, setPeople] = useState([]);
  const [strangers, setStrangers] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [mode, setMode] = useState('upload'); // 'upload' | 'db'
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [selectedEvent, setSelectedEvent] = useState(null);
  const [picker, setPicker] = useState(null); // { event, faces }
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const fileRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const [faces, recent] = await Promise.all([
        api.getFaces(),
        api.getRecentStrangers(20),
      ]);
      setPeople(faces);
      setStrangers(recent);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  // Candidate frames are only needed once the user switches to the DB tab.
  useEffect(() => {
    if (mode !== 'db') return;
    api.getFaceCandidates(40).then(setCandidates).catch(() => {});
  }, [mode]);

  const resetForm = () => {
    setName('');
    setFile(null);
    setSelectedEvent(null);
    setPicker(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const enrollFromEvent = async (eventId, faceIndex) => {
    setSubmitting(true);
    try {
      const p = await api.addFaceFromEvent(name.trim(), eventId, faceIndex);
      addToast(`Đã đăng ký "${p.name}" (${p.photoCount} ảnh)`, 'success');
      resetForm();
      load();
    } catch (err) {
      if (err.status === 409 && err.body?.needsSelection) {
        // Several faces in the frame — let the user point at the right one.
        setPicker({ event: candidates.find((c) => c._id === eventId), faces: err.body.faces });
      } else {
        addToast(`Lỗi: ${err.message}`, 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { addToast('Nhập tên người cần đăng ký', 'warning'); return; }

    if (mode === 'db') {
      if (!selectedEvent) { addToast('Chọn một ảnh từ danh sách bên dưới', 'warning'); return; }
      enrollFromEvent(selectedEvent, undefined);
      return;
    }

    if (!file) { addToast('Chọn ảnh có khuôn mặt rõ', 'warning'); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('name', name.trim());
      fd.append('image', file);
      const p = await api.addFace(fd);
      addToast(`Đã đăng ký "${p.name}" (${p.photoCount} ảnh)`, 'success');
      resetForm();
      load();
    } catch (err) {
      addToast(`Lỗi: ${err.message}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (p) => {
    if (!confirm(`Xóa "${p.name}" khỏi danh sách người quen?`)) return;
    try {
      await api.deleteFace(p._id);
      addToast(`Đã xóa ${p.name}`, 'success');
      load();
    } catch (err) {
      addToast(`Lỗi: ${err.message}`, 'error');
    }
  };

  const tabStyle = (active) => ({
    flex: 1,
    padding: '7px 10px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    border: '1px solid var(--color-border, #e5e7eb)',
    background: active ? 'var(--blue, #2563eb)' : 'transparent',
    color: active ? '#fff' : 'inherit',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  });

  return (
    <div className="page">
      <div className="section-header">
        <h1>Nhận diện khuôn mặt</h1>
      </div>

      <div className="grid-2">
        {/* ── Enroll + known people ── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title">
              <UserCheck size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
              Người quen ({people.length})
            </span>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', marginBottom: 12, borderRadius: 6, overflow: 'hidden' }}>
              <button type="button" style={{ ...tabStyle(mode === 'upload'), borderRadius: '6px 0 0 6px' }}
                onClick={() => { setMode('upload'); setSelectedEvent(null); }}>
                <Upload size={14} /> Tải ảnh lên
              </button>
              <button type="button" style={{ ...tabStyle(mode === 'db'), borderRadius: '0 6px 6px 0' }}
                onClick={() => { setMode('db'); setFile(null); }}>
                <Images size={14} /> Chọn từ dữ liệu
              </button>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <input
                className="input"
                style={{ flex: '1 1 140px' }}
                placeholder="Tên (vd: Bố, Mẹ, Anh Tuấn)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              {mode === 'upload' && (
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="input"
                  style={{ flex: '1 1 180px' }}
                  onChange={(e) => setFile(e.target.files?.[0] || null)}
                />
              )}
              <button className="btn btn-primary" type="submit" disabled={submitting}>
                <UserPlus size={14} /> {submitting ? 'Đang xử lý…' : 'Đăng ký'}
              </button>
            </form>

            {mode === 'upload' ? (
              <p className="text-muted" style={{ fontSize: 12, marginBottom: 14 }}>
                Ảnh chụp thẳng mặt, đủ sáng, chỉ MỘT người. Đăng ký cùng tên nhiều lần
                để thêm ảnh (nhiều góc → nhận diện chính xác hơn).
              </p>
            ) : (
              <>
                <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  Chọn một ảnh đã chụp từ camera. Hữu ích khi có cảnh báo "người lạ" nhưng
                  thực ra là người quen — nhập tên rồi bấm chọn ảnh đó.
                </p>
                {candidates.length === 0 ? (
                  <div className="empty-text" style={{ marginBottom: 14 }}>
                    Chưa có ảnh nào có người trong cơ sở dữ liệu.
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))',
                      gap: 8,
                      maxHeight: 260,
                      overflowY: 'auto',
                      marginBottom: 14,
                      padding: 2,
                    }}
                  >
                    {candidates.map((ev) => {
                      const active = selectedEvent === ev._id;
                      return (
                        <button
                          key={ev._id}
                          type="button"
                          onClick={() => setSelectedEvent(active ? null : ev._id)}
                          title={`${ev.cameraId?.name || 'Camera'} · ${format(new Date(ev.capturedAt), 'dd/MM HH:mm')}`}
                          style={{
                            position: 'relative',
                            padding: 0,
                            border: active ? '3px solid #22c55e' : '1px solid var(--color-border, #e5e7eb)',
                            borderRadius: 6,
                            overflow: 'hidden',
                            cursor: 'pointer',
                            background: '#000',
                            aspectRatio: '1',
                          }}
                        >
                          <img
                            src={uploadsUrl(ev.thumbnailPath || ev.imagePath)}
                            alt=""
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                          {ev.tags?.includes('stranger') && (
                            <span style={{
                              position: 'absolute', top: 2, left: 2,
                              background: 'rgba(220,38,38,0.92)', color: '#fff',
                              fontSize: 9, fontWeight: 700, padding: '1px 4px', borderRadius: 3,
                            }}>LẠ</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {loading ? (
              <div className="skeleton" style={{ height: 80, borderRadius: 8 }} />
            ) : people.length === 0 ? (
              <div className="empty-text">
                Chưa có ai được đăng ký. Khi chưa đăng ký, hệ thống KHÔNG cảnh báo người lạ
                (vì mọi người đều sẽ là "lạ").
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {people.map((p) => (
                  <div
                    key={p._id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 12,
                      padding: '8px 10px', border: '1px solid var(--color-border, #e5e7eb)', borderRadius: 8,
                    }}
                  >
                    {p.imagePaths?.[0] ? (
                      <img
                        src={uploadsUrl(p.imagePaths[0])}
                        alt={p.name}
                        style={{ width: 46, height: 46, borderRadius: '50%', objectFit: 'cover' }}
                      />
                    ) : (
                      <div style={{
                        width: 46, height: 46, borderRadius: '50%', background: 'var(--color-bg-secondary, #f3f4f6)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700,
                      }}>
                        {p.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600 }}>{p.name}</div>
                      <div className="text-muted" style={{ fontSize: 12 }}>{p.photoCount} ảnh đăng ký</div>
                    </div>
                    <button className="btn btn-sm btn-danger" onClick={() => handleDelete(p)} title="Xóa">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Recent stranger alerts ── */}
        <div className="card">
          <div className="card-header">
            <span className="card-title" style={{ color: '#dc2626' }}>
              <ShieldAlert size={15} style={{ verticalAlign: -2, marginRight: 6 }} />
              Cảnh báo người lạ gần đây
            </span>
          </div>
          <div className="card-body">
            {loading ? (
              <div className="skeleton" style={{ height: 80, borderRadius: 8 }} />
            ) : strangers.length === 0 ? (
              <div className="empty-text">Chưa ghi nhận người lạ nào.</div>
            ) : (
              <div className="event-list">
                {strangers.map((ev) => (
                  <Link key={ev._id} to={`/events/${ev._id}`} className="event-item">
                    <div className="event-thumb" style={{ background: '#1a0505', color: '#f87171' }}>
                      {ev.thumbnailPath ? (
                        <img src={uploadsUrl(ev.thumbnailPath)} alt="" />
                      ) : (
                        <ShieldAlert size={16} />
                      )}
                    </div>
                    <div className="event-info">
                      <div className="event-title">
                        <span className="tag tag-alert">Người lạ</span>
                        {ev.cameraId?.name || 'Camera'}
                      </div>
                      <div className="event-meta">
                        {format(new Date(ev.capturedAt), 'dd/MM/yyyy HH:mm:ss')}
                        {ev.analysis?.faces?.some((f) => f.name) &&
                          ` · cùng khung: ${ev.analysis.faces.filter((f) => f.name).map((f) => f.name).join(', ')}`}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <Modal open={!!picker} onClose={() => setPicker(null)} title="Chọn khuôn mặt cần đăng ký">
        {picker && (
          <FacePicker
            event={picker.event}
            faces={picker.faces}
            onPick={(i) => { const id = picker.event._id; setPicker(null); enrollFromEvent(id, i); }}
            onCancel={() => setPicker(null)}
          />
        )}
      </Modal>
    </div>
  );
}
