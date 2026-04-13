import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

export default function HlsPlayer({
  src,
  autoPlay = true,
  muted = true,
  className,
  style,
  poster,
  onError,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const retryTimerRef = useRef(null);

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

    if (nativeMpegUrl === 'probably') {
      video.src = manifestUrl;
      video.load();
      if (autoPlay) video.play().catch(() => {});
      return () => {};
    }

    if (!Hls.isSupported()) {
      setError('HLS not supported in this browser');
      setLoading(false);
      return () => {};
    }

    const hls = new Hls({
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

    video.addEventListener('playing', () => {
      setError(null);
      setLoading(false);
    });

    video.addEventListener('waiting', () => {
      setLoading(true);
    });

    video.addEventListener('canplay', () => {
      setLoading(false);
    });

    return () => {
      clearRetry();
      hls.destroy();
      hlsRef.current = null;
    };
  }, [src, autoPlay, onError]);

  return (
    <div className={className} style={{ position: 'relative', background: '#000', ...style }}>
      <video
        ref={videoRef}
        muted={muted}
        playsInline
        poster={poster}
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
      />
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
}
