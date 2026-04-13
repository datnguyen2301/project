import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { format } from 'date-fns';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api';
import { useToast } from '../components/Toast';
import Modal from '../components/Modal';
import { SkeletonMetric } from '../components/Skeleton';

export default function PlatesPage() {
  const addToast = useToast();
  const [events, setEvents] = useState([]);
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [stats, setStats] = useState({ total: 0, recognized: 0, unknown: 0 });
  const [blacklist, setBlacklist] = useState([]);
  const [showBlacklistModal, setShowBlacklistModal] = useState(false);
  const [newPlate, setNewPlate] = useState('');
  const [newReason, setNewReason] = useState('');
  const [loading, setLoading] = useState(true);

  const loadBlacklist = useCallback(async () => {
    try {
      const items = await api.getBlacklist();
      setBlacklist(items);
    } catch { /* ignore */ }
  }, []);

  const load = useCallback(async () => {
    try {
      const params = { limit: 100, tag: 'vehicle' };
      if (search) params.plate = search;
      if (dateFilter) {
        params.dateFrom = dateFilter;
        params.dateTo = dateFilter + 'T23:59:59';
      }
      const d = await api.getEvents(params);
      const evts = d.events || [];
      setEvents(evts);

      let recognized = 0;
      let unknown = 0;
      evts.forEach((ev) => {
        if (ev.analysis?.licensePlates?.length > 0) {
          ev.analysis.licensePlates.forEach((lp) => {
            if (lp.plateNumber && lp.plateNumber !== '???') recognized++;
            else unknown++;
          });
        } else {
          unknown++;
        }
      });
      setStats({ total: evts.length, recognized, unknown });
    } catch { /* ignore */ }
    setLoading(false);
  }, [search, dateFilter]);

  useEffect(() => { load(); loadBlacklist(); }, [load, loadBlacklist]);

  const handleFilter = () => load();

  const blacklistSet = new Set(blacklist.map(b => b.plateNumber.toUpperCase()));

  const handleAddBlacklist = async () => {
    if (!newPlate.trim()) return;
    try {
      await api.addBlacklist(newPlate, newReason);
      addToast(`Đã thêm ${newPlate.toUpperCase()} vào biển số bị cấm`, 'warning');
      setNewPlate('');
      setNewReason('');
      loadBlacklist();
    } catch (err) {
      addToast(`Lỗi: ${err.message}`, 'error');
    }
  };

  const handleRemoveBlacklist = async (item) => {
    try {
      await api.removeBlacklist(item._id);
      addToast(`Đã xóa ${item.plateNumber} khỏi biển số bị cấm`, 'success');
      loadBlacklist();
    } catch (err) {
      addToast(`Lỗi: ${err.message}`, 'error');
    }
  };

  const plates = [];
  events.forEach((ev, idx) => {
    const direction = idx % 2 === 0 ? 'Vào' : 'Ra';
    if (ev.analysis?.licensePlates?.length > 0) {
      ev.analysis.licensePlates.forEach((lp) => {
        plates.push({
          _id: ev._id,
          time: ev.capturedAt,
          plate: lp.plateNumber || '???',
          camera: ev.cameraId?.name || '-',
          confidence: lp.confidence,
          vehicleType: ev.analysis.vehicles?.[0]?.type || 'Phương tiện',
          direction,
        });
      });
    } else if (ev.analysis?.vehicles?.length > 0) {
      plates.push({
        _id: ev._id,
        time: ev.capturedAt,
        plate: '???',
        camera: ev.cameraId?.name || '-',
        confidence: 0,
        vehicleType: ev.analysis.vehicles[0]?.type || 'Phương tiện',
        direction,
      });
    }
  });

  const blacklistedCount = plates.filter(p => blacklistSet.has(p.plate.toUpperCase())).length;

  return (
    <>
      <div className="metrics" style={{ marginBottom: 16 }}>
        {loading ? (
          <>{[1,2,3,4].map(i => <SkeletonMetric key={i} />)}</>
        ) : (
          <>
            <div className="metric-card">
              <div className="metric-label">Tổng hôm nay</div>
              <div className="metric-value blue">{stats.total}</div>
              <div className="metric-sub">Lượt qua camera</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Đã nhận dạng</div>
              <div className="metric-value green">{stats.recognized}</div>
              <div className="metric-sub">{stats.total > 0 ? `${((stats.recognized / stats.total) * 100).toFixed(0)}% thành công` : '-'}</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Không rõ</div>
              <div className="metric-value red">{stats.unknown}</div>
              <div className="metric-sub">Cần kiểm tra thủ công</div>
            </div>
            <div className="metric-card">
              <div className="metric-label">Biển số bị cấm</div>
              <div className="metric-value red">{blacklist.length}</div>
              <div className="metric-sub">{blacklistedCount > 0 ? `${blacklistedCount} phát hiện hôm nay` : 'Cảnh báo ngay'}</div>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Nhật ký biển số xe</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-sm btn-danger" onClick={() => setShowBlacklistModal(true)} aria-label="Quản lý biển số bị cấm">
              Biển số bị cấm ({blacklist.length})
            </button>
            <button className="btn btn-sm" onClick={() => {
              const csv = ['Thời gian,Biển số,Camera,Hướng,Loại xe,Trạng thái']
                .concat(plates.map(p => `${new Date(p.time).toLocaleTimeString()},${p.plate},${p.camera},${p.direction},${p.vehicleType},${blacklistSet.has(p.plate.toUpperCase()) ? 'Bị cấm' : p.plate !== '???' ? 'Được phép' : 'Không rõ'}`))
                .join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'plates.csv';
              a.click();
            }}>Xuất CSV</button>
          </div>
        </div>
        <div className="card-body">
          <div className="search-row" style={{ marginBottom: 12 }}>
            <input
              className="search-input"
              type="text"
              placeholder="Tìm biển số..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleFilter()}
            />
            <input
              className="search-input"
              type="date"
              value={dateFilter}
              onChange={(e) => setDateFilter(e.target.value)}
              style={{ maxWidth: 140 }}
            />
            <button className="btn btn-primary" onClick={handleFilter}>Lọc</button>
          </div>

          {plates.length === 0 ? (
            <div className="empty-text">Chưa có biển số xe nào được ghi nhận.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Biển số</th>
                  <th>Camera</th>
                  <th>Hướng</th>
                  <th>Loại xe</th>
                  <th>Trạng thái</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {plates.map((p, i) => {
                  const isBlacklisted = blacklistSet.has(p.plate.toUpperCase());
                  return (
                    <tr key={`${p._id}-${i}`} style={isBlacklisted ? { background: 'rgba(226,75,74,0.08)' } : undefined}>
                      <td className="td-time">{format(new Date(p.time), 'HH:mm:ss')}</td>
                      <td><span className="plate-tag">{p.plate}</span></td>
                      <td>{p.camera}</td>
                      <td>{p.direction}</td>
                      <td>{p.vehicleType}</td>
                      <td>
                        {isBlacklisted ? (
                          <span className="tag tag-alert">Bị cấm</span>
                        ) : p.plate !== '???' ? (
                          <span className="tag tag-ok">Được phép</span>
                        ) : (
                          <span className="tag tag-warn">Không rõ</span>
                        )}
                      </td>
                      <td><Link to={`/events/${p._id}`} className="btn btn-sm">Chi tiết</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <Modal open={showBlacklistModal} onClose={() => setShowBlacklistModal(false)} title="Quản lý biển số bị cấm">
        <div style={{ padding: 14, minWidth: 360 }}>
          <div className="search-row" style={{ marginBottom: 12 }}>
            <input
              className="search-input"
              type="text"
              placeholder="Nhập biển số (VD: 51A-123.45)"
              value={newPlate}
              onChange={(e) => setNewPlate(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddBlacklist()}
            />
            <input
              className="search-input"
              type="text"
              placeholder="Lý do..."
              value={newReason}
              onChange={(e) => setNewReason(e.target.value)}
              style={{ maxWidth: 140 }}
            />
            <button className="btn btn-primary btn-sm" onClick={handleAddBlacklist}>
              <Plus size={12} /> Thêm
            </button>
          </div>

          {blacklist.length === 0 ? (
            <div className="empty-text">Chưa có biển số nào bị cấm.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Biển số</th>
                  <th>Lý do</th>
                  <th>Ngày thêm</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {blacklist.map((item) => (
                  <tr key={item._id}>
                    <td><span className="plate-tag">{item.plateNumber}</span></td>
                    <td>{item.reason || '-'}</td>
                    <td className="td-time">{format(new Date(item.addedAt), 'dd/MM/yyyy')}</td>
                    <td>
                      <button className="btn btn-sm btn-danger" onClick={() => handleRemoveBlacklist(item)} aria-label="Xóa khỏi biển số bị cấm">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Modal>
    </>
  );
}
