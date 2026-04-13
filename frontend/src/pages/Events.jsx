import { useEffect, useState, useCallback, memo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { api, uploadsUrl } from '../api';

// ─── Helpers (stable references, không re-create mỗi render) ───────────────

const TAG_CONFIG = {
  person:        { cls: 'tag-person',  label: 'Người' },
  plate:         { cls: 'tag-plate',   label: 'Biển số' },
  'license-plate': { cls: 'tag-plate', label: 'Biển số' },
  vehicle:       { cls: 'tag-person',  label: 'Phương tiện' },
};

function getTagInfo(tags) {
  if (!tags?.length) return { cls: 'tag-person', label: 'Sự kiện' };
  for (const t of tags) {
    if (TAG_CONFIG[t]) return TAG_CONFIG[t];
  }
  return { cls: 'tag-alert', label: tags[0] };
}

function getDescription(ev) {
  const camName = ev.cameraId?.name ?? 'Camera';
  const { licensePlates, persons, vehicles } = ev.analysis ?? {};
  if (licensePlates?.length)  return licensePlates[0].plateNumber;
  if (persons?.length)        return `${persons.length} người tại ${camName}`;
  if (vehicles?.length)       return `${vehicles.length} phương tiện tại ${camName}`;
  return `Sự kiện tại ${camName}`;
}

function getThumbStyle(tags) {
  if (tags?.includes('plate') || tags?.includes('license-plate'))
    return { background: '#1a0d00', color: '#FAC775' };
  return { background: '#0a1a0a', color: '#5DCAA5' };
}

function getBestConf(persons) {
  if (!persons?.length) return null;
  const best = Math.max(...persons.map(p => p.confidence ?? 0));
  return best > 0 ? `${(best * 100).toFixed(0)}%` : null;
}

function isVideoEvent(ev) {
  return ev.type === 'clip' || Boolean(ev.videoPath);
}

// ─── EventItem — memo để tránh re-render khi list không đổi ────────────────

const EventItem = memo(({ ev }) => {
  const { cls, label } = getTagInfo(ev.tags);
  const conf = getBestConf(ev.analysis?.persons);
  const video = isVideoEvent(ev);

  return (
    <Link key={ev._id} to={`/events/${ev._id}`} className="event-item">
      <div
        className="event-thumb"
        style={video ? { background: '#0a0a2a', color: '#a78bfa' } : getThumbStyle(ev.tags)}
      >
        {ev.thumbnailPath
          ? <img src={uploadsUrl(ev.thumbnailPath)} alt="" />
          : <span>{video ? '▶' : '■'}</span>
        }
        {video && ev.videoPath && <span className="video-icon-overlay">▶</span>}
      </div>

      <div className="event-info">
        <div className="event-title">
          <span className={`tag ${cls}`}>{label}</span>
          {getDescription(ev)}
        </div>
        <div className="event-meta">
          {ev.cameraId?.name ?? 'Camera'}
          {' · '}
          {format(new Date(ev.capturedAt), 'HH:mm:ss dd/MM/yyyy')}
          {conf && ` · ${conf}`}
          {video && ev.clipDuration && ` · ${ev.clipDuration}s`}
        </div>
      </div>
    </Link>
  );
});

// ─── Pagination ─────────────────────────────────────────────────────────────

const Pagination = memo(({ data, page, label, setPage }) => {
  if (data.totalPages <= 1) return null;
  return (
    <div className="pagination">
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
        <ChevronLeft size={14} />
      </button>
      <span>{label}: {data.page} / {data.totalPages}</span>
      <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage(p => p + 1)}>
        <ChevronRight size={14} />
      </button>
    </div>
  );
});

// ─── Dữ liệu mặc định (stable reference, tránh tạo object mới mỗi render) ──

const EMPTY_DATA = { events: [], total: 0, page: 1, totalPages: 1 };

// ─── Main component ─────────────────────────────────────────────────────────

export default function Events() {
  const [data, setData]       = useState(EMPTY_DATA);
  const [search, setSearch]   = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage]       = useState(1);
  const [typeFilter, setTypeFilter] = useState('all');

  const load = useCallback(async () => {
    const params = { search, tag: tagFilter, page, limit: 20 };
    if (typeFilter !== 'all') params.type = typeFilter;

    try {
      const d = await api.getEvents(params);
      setData(d);
    } catch { /* ignore */ }
  }, [search, tagFilter, typeFilter, page]);

  useEffect(() => { load(); }, [load]);

  const switchType = useCallback((t) => {
    setTypeFilter(t);
    setPage(1);
  }, []);

  const handleFilter = useCallback(() => {
    setPage(1);
  }, []);

  const isEmpty = data.events.length === 0;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Sự kiện</span>
        <div className="filter-tabs">
          {[
            { key: 'all',   label: 'Tất cả' },
            { key: 'image', label: `Ảnh` },
            { key: 'clip',  label: `Video` },
          ].map(({ key, label }) => (
            <button
              key={key}
              className={`btn btn-sm${typeFilter === key ? ' btn-primary' : ''}`}
              onClick={() => switchType(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card-body">
        <div className="search-row">
          <input
            className="search-input"
            type="text"
            placeholder="Lọc sự kiện..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleFilter(); }}
          />
          <select className="filter-select" value={tagFilter} onChange={e => setTagFilter(e.target.value)}>
            <option value="">Tất cả loại</option>
            <option value="person">Người</option>
            <option value="vehicle">Phương tiện</option>
            <option value="plate">Biển số</option>
            <option value="auto-watch">Auto-watch</option>
          </select>
          <button className="btn btn-primary" onClick={handleFilter}>Lọc</button>
        </div>

        {isEmpty ? (
          <div className="empty-text">Không tìm thấy sự kiện.</div>
        ) : (
          <div>
            <div className="event-list">
              {data.events.map(ev => (
                <EventItem key={ev._id} ev={ev} />
              ))}
            </div>
            <Pagination data={data} page={page} label="Trang" setPage={setPage} />
          </div>
        )}
      </div>
    </div>
  );
}
