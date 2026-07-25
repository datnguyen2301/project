import { useMemo, useRef } from 'react';

const DAY_SEC = 86400;

function tagClass(tags = []) {
  if (tags.includes('plate') || tags.includes('license-plate')) return 'pb-marker-plate';
  if (tags.includes('vehicle')) return 'pb-marker-vehicle';
  return 'pb-marker-person';
}

function pct(sec) {
  return `${Math.max(0, Math.min(100, (sec / DAY_SEC) * 100))}%`;
}

/** Seconds since local midnight of `dayStart`. */
function offsetSec(iso, dayStartMs) {
  return (new Date(iso).getTime() - dayStartMs) / 1000;
}

/**
 * A 24-hour scrub bar: recorded spans, event markers, and the playhead.
 *
 * Adjacent segments are merged into "runs" so a day of 5-minute files renders as
 * a few continuous bars rather than 288 slivers — the gaps between runs are the
 * meaningful thing to show.
 */
export default function PlaybackTimeline({
  dayStart,
  segments = [],
  events = [],
  playheadAt,
  onSeek,
}) {
  const trackRef = useRef(null);
  const dayStartMs = useMemo(() => new Date(dayStart).getTime(), [dayStart]);

  const runs = useMemo(() => {
    const out = [];
    for (const s of segments) {
      const from = offsetSec(s.startedAt, dayStartMs);
      const to = offsetSec(s.endedAt, dayStartMs);
      const last = out[out.length - 1];
      // 3s tolerance: keyframe alignment can shift a cut slightly, and that is
      // not a real gap.
      if (last && from - last.to <= 3) last.to = to;
      else out.push({ from, to });
    }
    return out;
  }, [segments, dayStartMs]);

  const markers = useMemo(
    () => events.map((e) => ({ ...e, at: offsetSec(e.at, dayStartMs) })),
    [events, dayStartMs],
  );

  const playheadSec = playheadAt == null ? null : offsetSec(playheadAt, dayStartMs);

  const seekFromEvent = (clientX) => {
    const el = trackRef.current;
    if (!el || !onSeek) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    onSeek(new Date(dayStartMs + ratio * DAY_SEC * 1000));
  };

  return (
    <div className="pb-timeline">
      <div
        className="pb-timeline-track"
        ref={trackRef}
        onClick={(e) => seekFromEvent(e.clientX)}
        role="slider"
        tabIndex={0}
        aria-label="Dòng thời gian"
        aria-valuemin={0}
        aria-valuemax={DAY_SEC}
        aria-valuenow={playheadSec == null ? 0 : Math.round(playheadSec)}
        onKeyDown={(e) => {
          if (!onSeek || playheadSec == null) return;
          const step = e.shiftKey ? 600 : 60;
          if (e.key === 'ArrowLeft') onSeek(new Date(dayStartMs + (playheadSec - step) * 1000));
          if (e.key === 'ArrowRight') onSeek(new Date(dayStartMs + (playheadSec + step) * 1000));
        }}
      >
        {runs.map((r, i) => (
          <div
            key={`run-${i}`}
            className="pb-run"
            style={{ left: pct(r.from), width: pct(r.to - r.from) }}
            title={`Có dữ liệu ${new Date(dayStartMs + r.from * 1000).toTimeString().slice(0, 5)}–${new Date(dayStartMs + r.to * 1000).toTimeString().slice(0, 5)}`}
          />
        ))}

        {markers.map((m) => (
          <div
            key={m.id}
            className={`pb-marker ${tagClass(m.tags)}`}
            style={{ left: pct(m.at) }}
            title={`${new Date(dayStartMs + m.at * 1000).toTimeString().slice(0, 8)} — ${m.tags.join(', ') || 'sự kiện'}`}
            onClick={(e) => {
              e.stopPropagation();
              // Land slightly before the event so the moment itself is visible.
              if (onSeek) onSeek(new Date(dayStartMs + Math.max(0, m.at - 5) * 1000));
            }}
          />
        ))}

        {playheadSec != null && playheadSec >= 0 && playheadSec <= DAY_SEC && (
          <div className="pb-playhead" style={{ left: pct(playheadSec) }} />
        )}
      </div>

      <div className="pb-hours" aria-hidden>
        {Array.from({ length: 25 }, (_, h) => (
          <span key={h} className="pb-hour-tick" style={{ left: pct(h * 3600) }}>
            {h % 3 === 0 ? String(h).padStart(2, '0') : ''}
          </span>
        ))}
      </div>
    </div>
  );
}
