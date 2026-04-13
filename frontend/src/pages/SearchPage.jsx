import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { api, uploadsUrl } from '../api';

function getTagClass(tags) {
  if (tags?.includes('person')) return 'tag-person';
  if (tags?.includes('plate') || tags?.includes('license-plate')) return 'tag-plate';
  if (tags?.includes('vehicle')) return 'tag-person';
  return 'tag-alert';
}

function getTagLabel(tags) {
  if (tags?.includes('person')) return 'Người';
  if (tags?.includes('plate') || tags?.includes('license-plate')) return 'Biển số';
  if (tags?.includes('vehicle')) return 'Phương tiện';
  return 'Sự kiện';
}

function getDetail(ev) {
  if (ev.analysis?.licensePlates?.length > 0) {
    return <span className="plate-tag">{ev.analysis.licensePlates[0].plateNumber}</span>;
  }
  const camName = ev.cameraId?.name || 'Camera';
  if (ev.analysis?.persons?.length > 0) return `${ev.analysis.persons.length} người tại ${camName}`;
  if (ev.analysis?.vehicles?.length > 0) return `${ev.analysis.vehicles.length} phương tiện tại ${camName}`;
  return `Sự kiện tại ${camName}`;
}

function getConfidence(ev) {
  if (ev.analysis?.persons?.length > 0) {
    const best = Math.max(...ev.analysis.persons.map(p => p.confidence || 0));
    if (best > 0) return `${(best * 100).toFixed(0)}%`;
  }
  if (ev.analysis?.licensePlates?.length > 0) {
    const best = Math.max(...ev.analysis.licensePlates.map(p => p.confidence || 0));
    if (best > 0) return `${(best * 100).toFixed(0)}%`;
  }
  if (ev.analysis?.vehicles?.length > 0) {
    const best = Math.max(...ev.analysis.vehicles.map(v => v.confidence || 0));
    if (best > 0) return `${(best * 100).toFixed(0)}%`;
  }
  return '-';
}

function getThumbStyle(tags) {
  if (tags?.includes('plate') || tags?.includes('license-plate'))
    return { background: '#1a0d00', color: '#FAC775' };
  if (tags?.includes('person'))
    return { background: '#0a1a0a', color: '#5DCAA5' };
  return { background: '#0a0a1a', color: '#AFA9EC' };
}

export default function SearchPage() {
  const [cameras, setCameras] = useState([]);
  const [results, setResults] = useState([]);
  const [total, setTotal] = useState(0);

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [cameraFilter, setCameraFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');

  useEffect(() => { api.getCameras().then(setCameras).catch(() => {}); }, []);

  const doSearch = useCallback(async () => {
    try {
      const params = { limit: 50 };
      if (search) {
        params.search = search;
        params.plate = search;
      }
      if (typeFilter) params.tag = typeFilter;
      if (cameraFilter) params.cameraId = cameraFilter;
      if (dateFilter) {
        params.dateFrom = dateFilter;
        params.dateTo = dateFilter + 'T23:59:59';
      }
      const d = await api.getEvents(params);
      setResults(d.events || []);
      setTotal(d.total || 0);
    } catch { /* ignore */ }
  }, [search, typeFilter, cameraFilter, dateFilter]);

  const handleKeyDown = (e) => { if (e.key === 'Enter') doSearch(); };

  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-header">
        <span className="card-title">Tra cứu dữ liệu giám sát</span>
        <span className="text-muted">{total > 0 ? `${total} kết quả` : ''}</span>
      </div>
      <div className="card-body">
        <div className="search-row">
          <input
            className="search-input"
            type="text"
            placeholder="Tìm biển số, tên người, thời gian..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{ flex: 2 }}
          />
          <select className="filter-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">Tất cả loại</option>
            <option value="person">Người</option>
            <option value="vehicle">Phương tiện</option>
            <option value="plate">Biển số</option>
          </select>
          <select className="filter-select" value={cameraFilter} onChange={(e) => setCameraFilter(e.target.value)}>
            <option value="">Tất cả camera</option>
            {cameras.map((c) => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>
          <input
            className="search-input"
            type="date"
            style={{ maxWidth: 140 }}
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
          />
          <button className="btn btn-primary" onClick={doSearch}>Tìm kiếm</button>
        </div>

        {results.length === 0 ? (
          <div className="empty-text">Nhập từ khóa và bấm Tìm kiếm.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Camera</th>
                  <th>Loại</th>
                  <th>Chi tiết</th>
                  <th>Hình ảnh</th>
                  <th>Độ tin cậy</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {results.map((ev) => (
                  <tr key={ev._id}>
                    <td className="td-time">{format(new Date(ev.capturedAt), 'HH:mm:ss')}</td>
                    <td>{ev.cameraId?.name || '-'}</td>
                    <td><span className={`tag ${getTagClass(ev.tags)}`}>{getTagLabel(ev.tags)}</span></td>
                    <td>{getDetail(ev)}</td>
                    <td>
                      <div style={{ ...getThumbStyle(ev.tags), width: 40, height: 28, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, overflow: 'hidden' }}>
                        {ev.thumbnailPath ? (
                          <img src={uploadsUrl(ev.thumbnailPath)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : 'IMG'}
                      </div>
                    </td>
                    <td>{getConfidence(ev)}</td>
                    <td><Link to={`/events/${ev._id}`} className="btn btn-sm">Xem</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
