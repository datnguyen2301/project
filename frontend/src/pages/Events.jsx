import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { api, uploadsUrl } from '../api';

function getTagClass(tags) {
  if (!tags || tags.length === 0) return 'tag-person';
  if (tags.includes('person')) return 'tag-person';
  if (tags.includes('plate') || tags.includes('license-plate')) return 'tag-plate';
  if (tags.includes('vehicle')) return 'tag-person';
  return 'tag-alert';
}

function getTagLabel(tags) {
  if (!tags || tags.length === 0) return 'Sự kiện';
  if (tags.includes('person')) return 'Người';
  if (tags.includes('plate') || tags.includes('license-plate')) return 'Biển số';
  if (tags.includes('vehicle')) return 'Phương tiện';
  return tags[0];
}

function getDescription(ev) {
  const camName = ev.cameraId?.name || 'Camera';
  if (ev.analysis?.licensePlates?.length > 0) return ev.analysis.licensePlates[0].plateNumber;
  if (ev.analysis?.persons?.length > 0) return `${ev.analysis.persons.length} người tại ${camName}`;
  if (ev.analysis?.vehicles?.length > 0) return `${ev.analysis.vehicles.length} phương tiện tại ${camName}`;
  return `Sự kiện tại ${camName}`;
}

function getThumbStyle(tags) {
  if (tags?.includes('plate') || tags?.includes('license-plate'))
    return { background: '#1a0d00', color: '#FAC775' };
  if (tags?.includes('person'))
    return { background: '#0a1a0a', color: '#5DCAA5' };
  return { background: '#0a1a0a', color: '#5DCAA5' };
}

export default function Events() {
  const [data, setData] = useState({ events: [], total: 0, page: 1, totalPages: 1, imageTotal: 0, clipTotal: 0 });
  const [cameras, setCameras] = useState([]);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('all'); // 'all' | 'image' | 'clip'

  const load = useCallback(async (p = page) => {
    try {
      const params = { page: p, limit: 20 };
      if (search) params.search = search;
      if (tagFilter) params.tag = tagFilter;
      if (typeFilter !== 'all') params.type = typeFilter;
      const d = await api.getEvents(params);
      setData(d);
    } catch { /* ignore */ }
  }, [search, tagFilter, typeFilter, page]);

  useEffect(() => { api.getCameras().then(setCameras).catch(() => {}); }, []);
  useEffect(() => { load(page); }, [page, load]);

  const handleFilter = () => { setPage(1); load(1); };

  const imageEvents = data.events.filter((e) => !e.videoPath && e.type !== 'clip');
  const videoEvents = data.events.filter((e) => e.videoPath || e.type === 'clip');
  const showImageSection = typeFilter === 'image' || (typeFilter === 'all' && imageEvents.length > 0);
  const showVideoSection = typeFilter === 'clip' || (typeFilter === 'all' && videoEvents.length > 0);

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Sự kiện</span>
        <div className="filter-tabs">
          <button
            className={`btn btn-sm${typeFilter === 'all' ? ' btn-primary' : ''}`}
            onClick={() => { setTypeFilter('all'); setPage(1); }}
          >
            Tất cả ({data.total})
          </button>
          <button
            className={`btn btn-sm${typeFilter === 'image' ? ' btn-primary' : ''}`}
            onClick={() => { setTypeFilter('image'); setPage(1); }}
          >
            Ảnh ({data.imageTotal})
          </button>
          <button
            className={`btn btn-sm${typeFilter === 'clip' ? ' btn-primary' : ''}`}
            onClick={() => { setTypeFilter('clip'); setPage(1); }}
          >
            Video ({data.clipTotal})
          </button>
        </div>
      </div>
      <div className="card-body">
        <div className="search-row">
          <input
            className="search-input"
            type="text"
            placeholder="Lọc sự kiện..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleFilter(); }}
          />
          <select className="filter-select" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
            <option value="">Tất cả loại</option>
            <option value="person">Người</option>
            <option value="vehicle">Phương tiện</option>
            <option value="plate">Biển số</option>
            <option value="auto-watch">Auto-watch</option>
          </select>
          <button className="btn btn-primary" onClick={handleFilter}>Lọc</button>
        </div>

        {data.events.length === 0 ? (
          <div className="empty-text">Không tìm thấy sự kiện.</div>
        ) : (
          <div>
            {showImageSection && (
              <div>
                {typeFilter === 'all' && (
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)', padding: '12px 0 6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Ảnh
                  </div>
                )}
                <div className="event-list">
                  {imageEvents.map((ev) => (
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
                          {getDescription(ev)}
                        </div>
                        <div className="event-meta">
                          {ev.cameraId?.name || 'Camera'} &middot; {format(new Date(ev.capturedAt), 'HH:mm:ss dd/MM/yyyy')}
                          {ev.analysis?.persons?.length > 0 && (() => {
                            const best = Math.max(...ev.analysis.persons.map(p => p.confidence || 0));
                            return best > 0 ? ` · ${(best * 100).toFixed(0)}%` : '';
                          })()}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {showVideoSection && (
              <div>
                {typeFilter === 'all' && (
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)', padding: '12px 0 6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Video
                  </div>
                )}
                <div className="event-list">
                  {videoEvents.map((ev) => (
                    <Link key={ev._id} to={`/events/${ev._id}`} className="event-item">
                      <div className="event-thumb" style={{ background: '#0a0a2a', color: '#a78bfa' }}>
                        {ev.thumbnailPath ? (
                          <img src={uploadsUrl(ev.thumbnailPath)} alt="" />
                        ) : (
                          <span>&#9654;</span>
                        )}
                        {ev.videoPath && (
                          <span className="video-icon-overlay">▶</span>
                        )}
                      </div>
                      <div className="event-info">
                        <div className="event-title">
                          <span className={`tag ${getTagClass(ev.tags)}`}>{getTagLabel(ev.tags)}</span>
                          {getDescription(ev)}
                        </div>
                        <div className="event-meta">
                          {ev.cameraId?.name || 'Camera'} &middot; {format(new Date(ev.capturedAt), 'HH:mm:ss dd/MM/yyyy')}
                          {ev.clipDuration && ` · ${ev.clipDuration}s`}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {data.totalPages > 1 && (
          <div className="pagination">
            <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              <ChevronLeft size={14} />
            </button>
            <span>Trang {data.page} / {data.totalPages}</span>
            <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
