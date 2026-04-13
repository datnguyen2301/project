import { useState, useEffect } from 'react';

export default function SettingsPage() {
  const [captureDir, setCaptureDir] = useState('/data/captures');
  const [apiUrl, setApiUrl] = useState('');
  const [personThreshold, setPersonThreshold] = useState(80);
  const [plateThreshold, setPlateThreshold] = useState(85);

  useEffect(() => {
    setApiUrl(window.location.origin + '/api');
  }, []);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Cài đặt hệ thống</span>
      </div>
      <div className="card-body">
        <div className="settings-grid">
          <div>
            <div className="settings-label">Thư mục lưu ảnh</div>
            <input
              className="search-input"
              type="text"
              value={captureDir}
              onChange={(e) => setCaptureDir(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <div className="settings-label">Camera API URL</div>
            <input
              className="search-input"
              type="text"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <div className="settings-label">Ngưỡng nhận dạng người (%)</div>
            <input
              className="search-input"
              type="number"
              value={personThreshold}
              onChange={(e) => setPersonThreshold(e.target.value)}
              style={{ width: '100%' }}
              min={0}
              max={100}
            />
          </div>
          <div>
            <div className="settings-label">Ngưỡng nhận dạng biển số (%)</div>
            <input
              className="search-input"
              type="number"
              value={plateThreshold}
              onChange={(e) => setPlateThreshold(e.target.value)}
              style={{ width: '100%' }}
              min={0}
              max={100}
            />
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <button className="btn btn-primary">Lưu cài đặt</button>
        </div>
      </div>
    </div>
  );
}
