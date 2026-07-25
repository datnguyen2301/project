import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Circle, Square, ChevronLeft, ChevronRight } from 'lucide-react';
import { api, uploadsUrl } from '../api';
import { useToast } from '../components/Toast';
import PlaybackTimeline from '../components/PlaybackTimeline';
import { localDayKey } from '../utils/localDay';

function fmtClock(d) {
  return d ? new Date(d).toTimeString().slice(0, 8) : '--:--:--';
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

export default function PlaybackPage() {
  const addToast = useToast();
  const videoRef = useRef(null);

  const [cameras, setCameras] = useState([]);
  const [cameraId, setCameraId] = useState('');
  const [date, setDate] = useState(() => localDayKey(new Date()));
  const [timeline, setTimeline] = useState(null);
  const [loading, setLoading] = useState(false);
  const [index, setIndex] = useState(-1);      // which segment is loaded
  const [playheadAt, setPlayheadAt] = useState(null);
  const [busy, setBusy] = useState(false);
  const activeItemRef = useRef(null);

  const segments = timeline?.segments || [];
  const current = index >= 0 ? segments[index] : null;

  useEffect(() => {
    api.playbackCameras()
      .then((list) => {
        setCameras(list || []);
        if (!cameraId && list?.length) {
          // Prefer a camera that actually has footage.
          const withFootage = list.find((c) => c.segments > 0) || list[0];
          setCameraId(String(withFootage._id));
        }
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTimeline = useCallback(async () => {
    if (!cameraId) return;
    setLoading(true);
    try {
      const t = await api.playbackTimeline(cameraId, date);
      setTimeline(t);
      // Land on the newest segment rather than an empty player. A day with only
      // a few minutes of footage occupies ~1px of a 24h bar, so leaving the user
      // to find and click it makes the page look broken.
      if (t.segments.length) {
        setIndex(t.segments.length - 1);
        setPlayheadAt(new Date(t.segments[t.segments.length - 1].startedAt));
      } else {
        setIndex(-1);
        setPlayheadAt(null);
      }
    } catch (e) {
      addToast(`Không tải được dòng thời gian: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [cameraId, date, addToast]);

  useEffect(() => { loadTimeline(); }, [loadTimeline]);

  // Keep the playing segment visible in the side list as playback auto-advances,
  // otherwise the highlight scrolls out of view on a long day.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const camera = useMemo(
    () => cameras.find((c) => String(c._id) === String(cameraId)),
    [cameras, cameraId],
  );

  // Prefer the timeline's live `recording` flag over the camera list, which is
  // fetched once on mount and goes stale the moment recording starts or stops
  // (including a recorder that gave up on its own).
  const isRecording = timeline?.recording ?? Boolean(camera?.autoRecord);

  /** Find the segment covering an instant, or the next one after a gap. */
  const resolve = useCallback(
    (when) => {
      const t = when.getTime();
      for (let i = 0; i < segments.length; i++) {
        const s = new Date(segments[i].startedAt).getTime();
        const e = new Date(segments[i].endedAt).getTime();
        if (t >= s && t <= e) return { i, offset: (t - s) / 1000 };
      }
      const nextI = segments.findIndex((sg) => new Date(sg.startedAt).getTime() > t);
      if (nextI >= 0) return { i: nextI, offset: 0, skipped: true };
      return null;
    },
    [segments],
  );

  const playAt = useCallback(
    (when) => {
      const hit = resolve(when);
      if (!hit) {
        addToast('Không có dữ liệu ghi hình sau thời điểm này', 'warning');
        return;
      }
      if (hit.skipped) addToast('Bỏ qua khoảng trống — chuyển tới đoạn tiếp theo', 'info', 2000);

      const v = videoRef.current;
      if (hit.i !== index) {
        setIndex(hit.i);
        // Wait for the new source's metadata before seeking into it.
        if (v) {
          const onMeta = () => {
            v.currentTime = hit.offset;
            v.play().catch(() => {});
            v.removeEventListener('loadedmetadata', onMeta);
          };
          v.addEventListener('loadedmetadata', onMeta);
        }
      } else if (v) {
        v.currentTime = hit.offset;
        v.play().catch(() => {});
      }
      setPlayheadAt(when);
    },
    [resolve, index, addToast],
  );

  // Auto-advance across segment boundaries so a day plays continuously.
  const onEnded = useCallback(() => {
    if (index < 0 || index + 1 >= segments.length) return;
    const next = segments[index + 1];
    const gapMs = new Date(next.startedAt) - new Date(segments[index].endedAt);
    if (gapMs > 5000) {
      addToast(`Bỏ qua khoảng trống ${Math.round(gapMs / 60000)} phút`, 'info', 2500);
    }
    setIndex(index + 1);
    const v = videoRef.current;
    if (v) {
      const onMeta = () => { v.play().catch(() => {}); v.removeEventListener('loadedmetadata', onMeta); };
      v.addEventListener('loadedmetadata', onMeta);
    }
  }, [index, segments, addToast]);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v || !current) return;
    setPlayheadAt(new Date(new Date(current.startedAt).getTime() + v.currentTime * 1000));
  }, [current]);

  const toggleRecording = async () => {
    if (!camera) return;
    setBusy(true);
    try {
      const r = await api.playbackSetRecording(cameraId, !isRecording);
      setCameras((prev) =>
        prev.map((c) => (String(c._id) === String(cameraId)
          ? { ...c, autoRecord: r.autoRecord, recording: r.recording }
          : c)),
      );
      setTimeline((t) => (t ? { ...t, recording: r.recording } : t));
      addToast(r.autoRecord ? 'Đã bật ghi hình liên tục' : 'Đã tắt ghi hình liên tục', 'success');
    } catch (e) {
      addToast(`Lỗi: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const shiftDay = (delta) => {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + delta);
    setDate(localDayKey(d));
  };

  const totals = timeline?.totals;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Xem lại</span>
        <div className="search-row" style={{ margin: 0, gap: 8 }}>
          <select
            className="filter-select"
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
            aria-label="Chọn camera"
          >
            {cameras.map((c) => (
              <option key={c._id} value={c._id}>
                {c.name}{c.segments ? '' : ' (chưa có dữ liệu)'}
              </option>
            ))}
          </select>

          <button className="btn btn-sm" onClick={() => shiftDay(-1)} aria-label="Ngày trước">
            <ChevronLeft size={14} />
          </button>
          <input
            type="date"
            className="search-input"
            style={{ maxWidth: 150 }}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label="Chọn ngày"
          />
          <button className="btn btn-sm" onClick={() => shiftDay(1)} aria-label="Ngày sau">
            <ChevronRight size={14} />
          </button>

          {camera && (
            <button
              className={`btn btn-sm${isRecording ? ' btn-danger' : ' btn-primary'}`}
              onClick={toggleRecording}
              disabled={busy}
            >
              {isRecording ? <Square size={13} /> : <Circle size={13} />}
              {isRecording ? ' Tắt ghi hình' : ' Bật ghi hình'}
            </button>
          )}
        </div>
      </div>

      <div className="card-body">
        {loading && <div className="empty-text">Đang tải...</div>}

        {!loading && camera && !camera.autoRecord && segments.length === 0 && (
          <div className="empty-text">
            Camera này chưa bật ghi hình liên tục — chưa có gì để xem lại.
          </div>
        )}

        {!loading && camera?.autoRecord && segments.length === 0 && (
          <div className="empty-text">
            Đang ghi hình, chưa có đoạn nào hoàn tất cho ngày này. Đoạn đang ghi chỉ
            xuất hiện sau khi kết thúc.
          </div>
        )}

        {!loading && segments.length > 0 && (
          <div className="pb-layout">
            <div className="pb-main">
            <div className="pb-video">
              <video
                ref={videoRef}
                controls
                playsInline
                // Recordings are encoded with -an, so there is no audio to lose.
                // Without `muted` Chrome's autoplay policy rejects the play()
                // issued from the async loadedmetadata handler, and the video
                // loads but never starts.
                muted
                // Render the first frame immediately so the player shows the
                // footage instead of a black box before anything is clicked.
                preload="auto"
                src={current ? uploadsUrl(current.filePath) : undefined}
                onEnded={onEnded}
                onTimeUpdate={onTimeUpdate}
                style={{ width: '100%', maxHeight: '55vh', background: '#000', display: 'block' }}
              />
              <div className="pb-clock">{fmtClock(playheadAt)}</div>
            </div>

            <PlaybackTimeline
              dayStart={timeline.dayStart}
              segments={segments}
              events={timeline.events}
              playheadAt={playheadAt}
              onSeek={playAt}
            />

            <div className="pb-meta">
              {/* The recorded window, spelled out: a few minutes of footage is
                  otherwise invisible on a 24-hour bar. */}
              <span className="text-blue">
                Có dữ liệu {fmtClock(segments[0].startedAt).slice(0, 5)}
                –{fmtClock(segments[segments.length - 1].endedAt).slice(0, 5)}
              </span>
              <span>{totals.segmentCount} đoạn · {fmtDuration(totals.recordedSec)} đã ghi</span>
              <span>{timeline.gaps.length} khoảng trống</span>
              <span>{totals.eventCount} sự kiện</span>
              <button
                className="btn btn-sm"
                onClick={() => playAt(new Date(segments[segments.length - 1].startedAt))}
              >
                Mới nhất
              </button>
            </div>
            </div>

            {/* Browsable list of the day's recordings beside the player. The
                24h bar is precise but unreadable when footage is sparse; this
                gives every segment a real click target. */}
            <aside className="pb-side" aria-label="Danh sách đoạn ghi">
              <div className="pb-side-head">
                Đoạn ghi ({segments.length})
              </div>
              <div className="pb-side-list">
                {segments.map((s, i) => {
                  const evCount = timeline.events.filter((e) => {
                    const t = new Date(e.at).getTime();
                    return t >= new Date(s.startedAt).getTime() && t <= new Date(s.endedAt).getTime();
                  }).length;
                  return (
                    <button
                      key={s.id}
                      ref={i === index ? activeItemRef : null}
                      className={`pb-seg-item${i === index ? ' active' : ''}`}
                      onClick={() => playAt(new Date(s.startedAt))}
                      aria-current={i === index}
                    >
                      <span className="pb-seg-time">{fmtClock(s.startedAt)}</span>
                      <span className="pb-seg-meta">
                        {Math.round(s.durationSec)}s · {(s.sizeBytes / 1024 / 1024).toFixed(1)}MB
                        {evCount > 0 && <span className="pb-seg-ev"> · {evCount} sự kiện</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
