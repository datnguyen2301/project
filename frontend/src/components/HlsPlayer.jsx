import { useEffect, useRef, useState, useCallback } from 'react';
import { Circle, Square, Volume2, VolumeX, Maximize, Radio, Download, Trash2, ScanEye } from 'lucide-react';
import PersonDetectionOverlay from './PersonDetectionOverlay';

function pickMimeType() {
  // Prefer efficient codecs, fall back until the browser accepts one. Safari
  // still lacks MediaRecorder for webm on some versions — handled by the caller.
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || null;
}

function fmtTimer(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export default function HlsPlayer({
  src,
  autoPlay = true,
  muted = true,
  className,
  style,
  poster,
  onError,
  recordable = false,
  recordLabel = 'stream',
  detectOverlay = false,
  detectDefault = true,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const stageRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isMuted, setIsMuted] = useState(muted);
  const retryTimerRef = useRef(null);

  // ── Real-time person-detection overlay ──
  // `detectOverlay` enables the feature (shows the AI toggle); `detectDefault`
  // controls whether it starts on. Grid tiles pass detectDefault={false} so four
  // players don't all spin up tfjs at once.
  const [detectOn, setDetectOn] = useState(detectOverlay && detectDefault);
  const [personCount, setPersonCount] = useState(0);
  const onPersonCount = useCallback((n) => setPersonCount(n), []);

  // ── Client-side recording state ──
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recTimerRef = useRef(null);
  const recStartRef = useRef(0);
  const mimeRef = useRef('');
  const activeRef = useRef(false); // guards against a late onstop double-adding
  const [recording, setRecording] = useState(false);
  const [recSecs, setRecSecs] = useState(0);
  const [recError, setRecError] = useState(null);
  const [clips, setClips] = useState([]); // {id, url, name, sizeMB, at, durationSec}

  const clearRetry = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  const scheduleRetry = (hls) => {
    clearRetry();
    retryTimerRef.current = setTimeout(() => {
      if (!src || !hlsRef.current) return;
      try {
        hls.stopLoad();
        hls.startLoad();
      } catch (_) {}
    }, 3000);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return undefined;

    clearRetry();
    setError(null);
    setLoading(true);

    const nativeMpegUrl = video.canPlayType('application/vnd.apple.mpegurl');
    const manifestUrl = src.startsWith('http')
      ? src
      : new URL(src, window.location.origin).href;

    // Named handlers so they can be detached on cleanup. Previously these were
    // anonymous and never removed, so every src change stacked another set of
    // listeners on the same <video>.
    const onPlaying = () => { setError(null); setLoading(false); };
    const onWaiting = () => setLoading(true);
    const onCanPlay = () => setLoading(false);

    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);

    const detachVideoEvents = () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
    };

    if (nativeMpegUrl === 'probably') {
      video.src = manifestUrl;
      video.load();
      if (autoPlay) video.play().catch(() => {});
      return detachVideoEvents;
    }

    // hls.js is by far the heaviest dependency in the app and is only needed on
    // browsers without native HLS, and only once a stream is actually shown.
    // Loading it on demand keeps it out of the initial bundle.
    let cancelled = false;
    let hls = null;

    import('hls.js')
      .then(({ default: Hls }) => {
        if (cancelled) return;

        if (!Hls.isSupported()) {
          setError('HLS not supported in this browser');
          setLoading(false);
          return;
        }

        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 5,
          maxBufferLength: 8,
          maxMaxBufferLength: 15,
          backBufferLength: 5,
          liveDurationInfinity: true,
          manifestLoadingMaxRetry: 6,
          manifestLoadingRetryDelay: 500,
          levelLoadingMaxRetry: 6,
          levelLoadingRetryDelay: 500,
          fragLoadingMaxRetry: 10,
          fragLoadingRetryDelay: 500,
          startLevel: -1,
          nudgeMaxRetry: 5,
          nudgeOffset: 0.2,
        });

        hlsRef.current = hls;
        hls.loadSource(manifestUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (autoPlay) video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;

          const msg = `HLS error: ${data.type} / ${data.details}`;
          console.warn(`[HlsPlayer] ${msg}`);

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError('Lỗi mạng — đang thử lại...');
              scheduleRetry(hls);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              setError('Lỗi media — đang khôi phục...');
              hls.recoverMediaError();
              retryTimerRef.current = setTimeout(() => {
                if (hlsRef.current) setError(null);
              }, 5000);
              break;
            case Hls.ErrorTypes.KEY_SYSTEM_ERROR:
            case Hls.ErrorTypes.M3U8_ERROR:
            case Hls.ErrorTypes.OTHER_ERROR:
            default:
              setError(msg);
              if (onError) onError(msg);
              hls.destroy();
              hlsRef.current = null;
              break;
          }
        });
      })
      .catch(() => {
        if (cancelled) return;
        setError('Không tải được trình phát HLS');
        setLoading(false);
      });

    return () => {
      cancelled = true;
      clearRetry();
      detachVideoEvents();
      if (hls) hls.destroy();
      hlsRef.current = null;
    };
  }, [src, autoPlay, onError]);

  // Jump back to the live edge — the low-latency config keeps a short buffer,
  // but a stalled tab can still drift behind. One button to resync.
  const goLive = useCallback(() => {
    const v = videoRef.current;
    const hls = hlsRef.current;
    if (!v) return;
    try {
      if (hls && hls.liveSyncPosition != null) {
        v.currentTime = hls.liveSyncPosition;
      } else if (v.seekable && v.seekable.length) {
        v.currentTime = v.seekable.end(v.seekable.length - 1);
      }
      v.play().catch(() => {});
    } catch (_) {}
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      el.requestFullscreen?.();
    }
  }, []);

  // Assemble the recorded clip from the chunks collected so far and surface it
  // in the UI. Idempotent: guarded by activeRef so a late, frame-gated onstop
  // (see stopRecording) can't add the same clip twice.
  const finalizeClip = useCallback(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    if (recTimerRef.current) { clearInterval(recTimerRef.current); recTimerRef.current = null; }
    const chunks = chunksRef.current;
    chunksRef.current = [];
    setRecording(false);
    setRecSecs(0);
    if (!chunks.length) return;
    const mimeType = mimeRef.current || 'video/webm';
    const blob = new Blob(chunks, { type: mimeType });
    const durationSec = Math.max(1, Math.round((Date.now() - recStartRef.current) / 1000));
    const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const at = new Date();
    const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const url = URL.createObjectURL(blob);
    setClips((prev) => [
      {
        id: `${at.getTime()}`,
        url,
        name: `${recordLabel}-${stamp}.${ext}`,
        sizeMB: blob.size / 1024 / 1024,
        at,
        durationSec,
      },
      ...prev,
    ]);
  }, [recordLabel]);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch (_) {}
    }
    // Build the clip right now from the timesliced chunks we already hold.
    // Chromium gates a MediaRecorder's final onstop/dataavailable on the source
    // <video> painting another frame, so relying on onstop makes the clip appear
    // only after the tab is backgrounded/refocused. Finalizing here is instant;
    // we lose at most the sub-second tail past the last timeslice boundary.
    finalizeClip();
  }, [finalizeClip]);

  const startRecording = useCallback(() => {
    setRecError(null);
    const video = videoRef.current;
    if (!video) return;
    if (typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') {
      setRecError('Trình duyệt không hỗ trợ ghi màn hình stream');
      return;
    }
    const mimeType = pickMimeType();
    if (!mimeType) {
      setRecError('Trình duyệt không hỗ trợ ghi video');
      return;
    }

    let stream;
    try {
      stream = video.captureStream ? video.captureStream() : video.mozCaptureStream();
    } catch (_) {
      setRecError('Không lấy được luồng video để ghi');
      return;
    }

    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (e) {
      setRecError(`Không khởi tạo được bộ ghi: ${e.message}`);
      return;
    }

    chunksRef.current = [];
    mimeRef.current = mimeType;
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    // Fallback only — stopRecording finalizes synchronously. This covers a stop
    // triggered from elsewhere (e.g. the recorder erroring out on its own).
    recorder.onstop = () => finalizeClip();

    recStartRef.current = Date.now();
    activeRef.current = true;
    // Timeslice so the recorder hands us complete, playable chunks every second
    // instead of holding everything until stop — which is what lets us finalize
    // immediately on the stop click without waiting for onstop.
    recorder.start(1000);
    recorderRef.current = recorder;
    setRecording(true);
    setRecSecs(0);
    recTimerRef.current = setInterval(() => {
      setRecSecs(Math.round((Date.now() - recStartRef.current) / 1000));
    }, 1000);
  }, [recordLabel, finalizeClip]);

  // Tidy up any in-flight recording and blob URLs on unmount.
  useEffect(() => () => {
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    activeRef.current = false; // stop the fallback onstop from finalizing post-unmount
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (_) {} }
    // Revoke on unmount using the latest clip list.
    setClips((prev) => { prev.forEach((c) => URL.revokeObjectURL(c.url)); return prev; });
  }, []);

  const removeClip = useCallback((id) => {
    setClips((prev) => {
      const found = prev.find((c) => c.id === id);
      if (found) URL.revokeObjectURL(found.url);
      return prev.filter((c) => c.id !== id);
    });
  }, []);

  const player = (
    <div
      ref={stageRef}
      className={`hls-player-root${recordable ? '' : className ? ` ${className}` : ''}`}
      style={{ position: 'relative', background: '#000', ...(recordable ? { width: '100%', height: '100%' } : style) }}
    >
      <video
        ref={videoRef}
        muted={isMuted}
        playsInline
        poster={poster}
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
      />

      {/* Real-time person detection boxes drawn over the video */}
      {detectOverlay && (
        <PersonDetectionOverlay videoRef={videoRef} active={detectOn} onCount={onPersonCount} />
      )}

      {/* Person-count badge while detection is on */}
      {detectOverlay && detectOn && personCount > 0 && (
        <div className="hls-detect-badge">
          <ScanEye size={13} /> {personCount} người
        </div>
      )}

      {/* Recording badge — always visible while capturing */}
      {recording && (
        <div className="hls-rec-badge">
          <span className="rec-dot pulse" />
          REC {fmtTimer(recSecs)}
        </div>
      )}

      {/* Playback + record controls */}
      {!error && (
        <div className="hls-controls">
          <button className="hls-ctrl" onClick={goLive} title="Về thời gian thực" aria-label="Về thời gian thực">
            <Radio size={14} /> LIVE
          </button>
          <button className="hls-ctrl" onClick={toggleMute} title={isMuted ? 'Bật tiếng' : 'Tắt tiếng'} aria-label="Bật/tắt tiếng">
            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <button className="hls-ctrl" onClick={toggleFullscreen} title="Toàn màn hình" aria-label="Toàn màn hình">
            <Maximize size={14} />
          </button>
          {detectOverlay && (
            <button
              className={`hls-ctrl${detectOn ? ' active' : ''}`}
              onClick={() => setDetectOn((v) => !v)}
              title={detectOn ? 'Tắt nhận diện người' : 'Bật nhận diện người'}
              aria-label="Bật/tắt nhận diện người"
            >
              <ScanEye size={14} /> AI
            </button>
          )}
          {recordable && (
            recording ? (
              <button className="hls-ctrl hls-ctrl-rec active" onClick={stopRecording} title="Dừng ghi" aria-label="Dừng ghi">
                <Square size={14} /> Dừng ghi
              </button>
            ) : (
              <button className="hls-ctrl hls-ctrl-rec" onClick={startRecording} title="Ghi hình" aria-label="Ghi hình">
                <Circle size={14} /> Ghi hình
              </button>
            )
          )}
        </div>
      )}

      {recError && (
        <div className="hls-rec-error">{recError}</div>
      )}

      {loading && !error && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 13, gap: 8,
        }}>
          <div className="spinner" style={{
            width: 28, height: 28, border: '3px solid rgba(255,255,255,0.2)',
            borderTop: '3px solid #10b981', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span>Đang tải stream...</span>
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.7)', color: '#f97316', fontSize: 13, padding: 16, textAlign: 'center',
        }}>
          {error}
        </div>
      )}
    </div>
  );

  if (!recordable) return player;

  return (
    <div className={`hls-stage${className ? ` ${className}` : ''}`} style={style}>
      <div className="hls-stage-player">{player}</div>
      {clips.length > 0 && (
        <aside className="hls-clips" aria-label="Bản ghi vừa lưu">
          <div className="hls-clips-head">Bản ghi đã lưu ({clips.length})</div>
          <div className="hls-clips-list">
            {clips.map((clip) => (
              <div key={clip.id} className="hls-clip-card">
                <video
                  src={clip.url}
                  controls
                  playsInline
                  preload="metadata"
                  className="hls-clip-video"
                />
                <div className="hls-clip-meta">
                  <span className="hls-clip-time">
                    {clip.at.toLocaleTimeString()} · {fmtTimer(clip.durationSec)} · {clip.sizeMB.toFixed(1)}MB
                  </span>
                  <div className="hls-clip-actions">
                    <a className="hls-clip-btn" href={clip.url} download={clip.name} title="Tải xuống">
                      <Download size={13} />
                    </a>
                    <button className="hls-clip-btn danger" onClick={() => removeClip(clip.id)} title="Xóa">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}
    </div>
  );
}
