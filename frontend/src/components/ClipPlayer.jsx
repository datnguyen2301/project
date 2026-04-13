import { useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';

export default function ClipPlayer({
  videoPath,
  gifPath,
  thumbnailPath,
  alt = 'Clip',
  captionPrimary,
  captionSecondary,
}) {
  const videoRef = useRef(null);
  const [mode, setMode] = useState('video');
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);

  const hasVideo = Boolean(videoPath);
  const hasGif = Boolean(gifPath);
  const showCaption = Boolean(captionPrimary || captionSecondary);

  const captionBlock = showCaption ? (
    <div className="clip-player-caption">
      {captionPrimary && <div className="clip-player-caption-primary">{captionPrimary}</div>}
      {captionSecondary && <div className="clip-player-caption-secondary">{captionSecondary}</div>}
    </div>
  ) : null;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => setProgress(video.currentTime / video.duration || 0);
    const onEnded = () => setPlaying(false);
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('ended', onEnded);
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('ended', onEnded);
    };
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.pause();
    } else {
      video.play().catch(() => {});
    }
    setPlaying((p) => !p);
  };

  const seekTo = (e) => {
    const video = videoRef.current;
    if (!video) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    video.currentTime = ratio * video.duration;
  };

  return (
    <div className="clip-player">
      <div className="clip-player-viewport">
        {mode === 'video' && hasVideo ? (
          <>
            <div className="clip-player-media-wrap">
              <video
                ref={videoRef}
                src={`/uploads/${videoPath}`}
                style={{ width: '100%', maxHeight: 400, display: 'block', borderRadius: 8 }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                muted
              />
              {captionBlock}
            </div>
            <div className="clip-player-controls">
              <button className="btn btn-sm" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
                {playing ? <Pause size={12} /> : <Play size={12} />}
              </button>
              <div
                className="clip-progress-bar"
                onClick={seekTo}
                title="Seek"
                role="slider"
                aria-valuenow={Math.round(progress * 100)}
              >
                <div className="clip-progress-fill" style={{ width: `${progress * 100}%` }} />
              </div>
              {hasGif && (
                <button
                  className="btn btn-sm"
                  onClick={() => setMode('gif')}
                  title="View GIF"
                  aria-label="Switch to GIF"
                >
                  GIF
                </button>
              )}
            </div>
          </>
        ) : mode === 'gif' && hasGif ? (
          <div style={{ position: 'relative' }}>
            <div className="clip-player-media-wrap">
              <img
                src={`/uploads/${gifPath}`}
                alt={alt}
                style={{ width: '100%', maxHeight: 400, display: 'block', borderRadius: 8 }}
              />
              {captionBlock}
            </div>
            <div style={{ position: 'absolute', top: 8, right: 8 }}>
              <button
                className="btn btn-sm"
                onClick={() => setMode('video')}
                title="Back to video"
              >
                <Play size={12} />
              </button>
            </div>
          </div>
        ) : thumbnailPath ? (
          <div className="clip-player-media-wrap">
            <img
              src={`/uploads/${thumbnailPath}`}
              alt={alt}
              style={{ width: '100%', maxHeight: 400, display: 'block', borderRadius: 8, objectFit: 'contain' }}
            />
            {captionBlock}
          </div>
        ) : (
          <div style={{
            width: '100%', height: 240, background: '#f3f4f6',
            borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#9ca3af',
          }}>
            Không có clip
          </div>
        )}
      </div>

      {mode === 'video' && hasVideo && (
        <div className="clip-mode-tabs">
          <button
            className={`btn btn-sm${mode === 'video' ? ' btn-active' : ''}`}
            onClick={() => setMode('video')}
          >
            Video
          </button>
          {hasGif && (
            <button
              className={`btn btn-sm${mode === 'gif' ? ' btn-active' : ''}`}
              onClick={() => setMode('gif')}
            >
              GIF
            </button>
          )}
        </div>
      )}
    </div>
  );
}
