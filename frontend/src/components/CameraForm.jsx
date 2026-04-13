import { useState } from 'react';

const EMPTY = {
  name: '',
  location: '',
  type: 'manual',
  ipAddress: '',
  status: 'offline',
  verifyCode: '',
  rtspHost: '',
  autoWatch: false,
  watchMinConfidence: 0.4,
  watchMinPersonSize: 0,
  watchDetectTargets: ['person', 'vehicle'],
};

export default function CameraForm({ initial, onSubmit, onCancel }) {
  const [form, setForm] = useState(() => {
    if (!initial) return { ...EMPTY };
    return {
      ...EMPTY,
      ...initial,
      watchDetectTargets: initial.watchDetectTargets || ['person', 'vehicle'],
    };
  });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handleChange = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleTargetToggle = (target) => {
    setForm((prev) => {
      const current = prev.watchDetectTargets || [];
      const next = current.includes(target)
        ? current.filter((t) => t !== target)
        : [...current, target];
      return { ...prev, watchDetectTargets: next.length > 0 ? next : current };
    });
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(form);
  };

  return (
    <form className="camera-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label>Name *</label>
        <input required value={form.name} onChange={(e) => handleChange('name', e.target.value)} />
      </div>
      <div className="form-group">
        <label>Location</label>
        <input value={form.location} onChange={(e) => handleChange('location', e.target.value)} />
      </div>
      <div className="form-group">
        <label>Type</label>
        <select value={form.type} onChange={(e) => handleChange('type', e.target.value)}>
          <option value="ip">IP Camera</option>
          <option value="webhook">Webhook</option>
          <option value="manual">Manual</option>
        </select>
      </div>
      {form.type === 'ip' && (
        <>
          <div className="form-group">
            <label>IP Address / Serial</label>
            <input value={form.ipAddress} onChange={(e) => handleChange('ipAddress', e.target.value)} placeholder="192.168.1.100 hoặc EZVIZ serial" />
          </div>
          <div className="form-group">
            <label>RTSP Host (LAN IP)</label>
            <input value={form.rtspHost || ''} onChange={(e) => handleChange('rtspHost', e.target.value)} placeholder="192.168.0.100:554" />
            <span className="text-muted" style={{ fontSize: 12 }}>
              IP:port LAN (vd 192.168.1.50:554). Bắt buộc nếu cloud trả sai IP hoặc Auto Watch/HLS lỗi — máy chạy backend phải ping được IP này.
            </span>
          </div>
          <div className="form-group">
            <label>Mã xác thực RTSP (Verify Code)</label>
            <input value={form.verifyCode || ''} onChange={(e) => handleChange('verifyCode', e.target.value)} placeholder="Mã xác thực camera (mặt sau camera)" />
            <span className="text-muted" style={{ fontSize: 12 }}>Xem mặt sau camera hoặc EZVIZ App → Cài đặt.</span>
          </div>
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={Boolean(form.autoWatch)}
                onChange={(e) => handleChange('autoWatch', e.target.checked)}
              />
              <span>Lưu auto-watch — tự chạy lại sau khi restart backend (cần RESTORE_AUTOWATCH_ON_START=true trong .env)</span>
            </label>
          </div>

          {/* Watch Settings */}
          <div style={{
            marginTop: 8,
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: showAdvanced ? '#f0fdf4' : '#f9fafb',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 13,
                fontWeight: 600,
                color: '#374151',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>⚙️ Cài đặt Watch nâng cao</span>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>{showAdvanced ? '▲' : '▼'}</span>
            </button>

            {showAdvanced && (
              <div style={{ padding: '12px', background: '#fafafa' }}>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                    Mục tiêu phát hiện
                  </label>
                  <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={(form.watchDetectTargets || []).includes('person')}
                        onChange={() => handleTargetToggle('person')}
                      />
                      <span>🧑 Người</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={(form.watchDetectTargets || []).includes('vehicle')}
                        onChange={() => handleTargetToggle('vehicle')}
                      />
                      <span>🚗 Xe</span>
                    </label>
                  </div>
                  <span className="text-muted" style={{ fontSize: 11, marginTop: 2, display: 'block' }}>
                    Chọn loại đối tượng sẽ kích hoạt tự động chụp ảnh và quay video.
                  </span>
                </div>

                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                    Độ tin cậy tối thiểu: <span style={{ color: '#16a34a', fontWeight: 700 }}>{(form.watchMinConfidence || 0.4).toFixed(1)}</span>
                  </label>
                  <input
                    type="range"
                    min="0.2"
                    max="0.9"
                    step="0.05"
                    value={form.watchMinConfidence || 0.4}
                    onChange={(e) => handleChange('watchMinConfidence', parseFloat(e.target.value))}
                    style={{ width: '100%', accentColor: '#16a34a' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af' }}>
                    <span>0.2 (nhạy)</span>
                    <span>0.9 (chính xác)</span>
                  </div>
                  <span className="text-muted" style={{ fontSize: 11, marginTop: 2, display: 'block' }}>
                    Giá trị thấp = phát hiện nhiều hơn (có thể nhiễu). Giá trị cao = ít hơn nhưng chính xác hơn.
                  </span>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                    Kích thước bbox tối thiểu (px²): <span style={{ color: '#16a34a', fontWeight: 700 }}>{form.watchMinPersonSize || 0}</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="50000"
                    step="1000"
                    value={form.watchMinPersonSize || 0}
                    onChange={(e) => handleChange('watchMinPersonSize', parseInt(e.target.value))}
                    style={{ width: '100%', accentColor: '#16a34a' }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#9ca3af' }}>
                    <span>0 (tất cả)</span>
                    <span>50000 (chỉ gần)</span>
                  </div>
                  <span className="text-muted" style={{ fontSize: 11, marginTop: 2, display: 'block' }}>
                    Chỉ phát hiện người có kích thước đủ lớn (gần camera). 0 = tất cả kích thước.
                  </span>
                </div>
              </div>
            )}
          </div>
        </>
      )}
      <div className="form-group">
        <label>Status</label>
        <select value={form.status} onChange={(e) => handleChange('status', e.target.value)}>
          <option value="online">Online</option>
          <option value="offline">Offline</option>
        </select>
      </div>
      <div className="form-actions">
        <button type="submit" className="btn btn-primary">Save</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}
