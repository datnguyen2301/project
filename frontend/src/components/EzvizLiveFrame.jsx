import { useEffect, useState, useRef } from 'react';

export default function EzvizLiveFrame({
  cameraId,
  intervalMs = 4000,
  className,
  style,
  alt,
}) {
  const [src, setSrc] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryCount, setRetryCount] = useState(0);
  const retryTimer = useRef(null);

  useEffect(() => {
    if (!cameraId) return undefined;
    setLoadFailed(false);
    setLoading(true);
    setRetryCount(0);

    const bump = () => setSrc(`/api/ezviz/frame/${cameraId}?t=${Date.now()}`);
    bump();
    const t = setInterval(bump, intervalMs);

    return () => {
      clearInterval(t);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [cameraId, intervalMs]);

  const handleError = () => {
    setLoadFailed(true);
    setLoading(false);
    if (retryCount < 5) {
      retryTimer.current = setTimeout(() => {
        setRetryCount((r) => r + 1);
        setSrc(`/api/ezviz/frame/${cameraId}?t=${Date.now()}&retry=${retryCount + 1}`);
        setLoadFailed(false);
        setLoading(true);
      }, 3000 + retryCount * 2000);
    }
  };

  if (!cameraId) return null;

  if (loadFailed && retryCount >= 5) {
    return (
      <div
        className={className}
        style={{
          ...style,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0f172a',
          color: '#94a3b8',
          fontSize: 12,
          gap: 6,
          minHeight: 160,
        }}
      >
        <span style={{ fontSize: 24 }}>📷</span>
        <span>Không thể kết nối camera</span>
        <button
          style={{
            marginTop: 4, padding: '4px 12px', background: '#1e293b',
            border: '1px solid #334155', borderRadius: 4, color: '#94a3b8',
            cursor: 'pointer', fontSize: 11,
          }}
          onClick={() => {
            setRetryCount(0);
            setLoadFailed(false);
            setLoading(true);
            setSrc(`/api/ezviz/frame/${cameraId}?t=${Date.now()}&reset=1`);
          }}
        >
          Thử lại
        </button>
      </div>
    );
  }

  return (
    <div style={{ position: 'relative', ...style }}>
      {(loading || loadFailed) && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: '#0f172a', color: '#94a3b8', fontSize: 12, gap: 6,
          zIndex: 1,
        }}>
          <div style={{
            width: 24, height: 24, border: '3px solid rgba(148,163,184,0.2)',
            borderTop: '3px solid #10b981', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span>{loadFailed ? 'Đang thử lại...' : 'Đang tải hình ảnh...'}</span>
        </div>
      )}
      <img
        src={src || undefined}
        alt={alt || 'EZVIZ'}
        className={className}
        style={{
          width: '100%',
          display: loading ? 'none' : 'block',
          maxHeight: 280,
          objectFit: 'cover',
        }}
        onLoad={() => {
          setLoadFailed(false);
          setLoading(false);
          setRetryCount(0);
        }}
        onError={handleError}
      />
    </div>
  );
}
