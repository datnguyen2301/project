import { useEffect, useRef, useState } from 'react';

/**
 * Real-time person detection overlay drawn on top of a <video>.
 *
 * Runs coco-ssd (TensorFlow.js) in the browser against the given video element
 * and paints a bounding box + label over each detected person. tfjs/coco-ssd are
 * lazy-imported (kept out of the initial bundle) and the model is cached across
 * all instances. All detection stays client-side — no server CPU, no auto-watch.
 *
 * Note: coco-ssd fetches its weights from Google's CDN on first load, then the
 * browser caches them. On a fully offline/LAN box, self-host the weights and pass
 * a modelUrl (see coco-ssd docs); the overlay fails gracefully if the model can't
 * load and never breaks video playback.
 */

// Module-level singleton so the (multi-MB) model loads once for the whole app.
let _modelPromise = null;
function loadModel() {
  if (!_modelPromise) {
    _modelPromise = (async () => {
      const tf = await import('@tensorflow/tfjs');
      await tf.ready();
      const cocoSsd = await import('@tensorflow-models/coco-ssd');
      // lite_mobilenet_v2 is the fastest base — best for real-time on CPU/GPU.
      return cocoSsd.load({ base: 'lite_mobilenet_v2' });
    })();
  }
  return _modelPromise;
}

const DETECT_INTERVAL_MS = 150; // throttle inference (~6-7 fps) to limit CPU
const MIN_SCORE = 0.5;

export default function PersonDetectionOverlay({ videoRef, active, onCount }) {
  const canvasRef = useRef(null);
  const rafRef = useRef(0);
  const busyRef = useRef(false);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error

  useEffect(() => {
    if (!active) {
      setStatus('idle');
      return undefined;
    }

    let stopped = false;
    let model = null;
    let lastRun = 0;

    const draw = (persons) => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;

      const cw = video.clientWidth;
      const ch = video.clientHeight;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!cw || !ch || !vw || !vh) return;

      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
        canvas.style.width = `${cw}px`;
        canvas.style.height = `${ch}px`;
      }

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Map intrinsic video pixels → displayed pixels (video uses object-fit:contain).
      const scale = Math.min(cw / vw, ch / vh);
      const offX = (cw - vw * scale) / 2;
      const offY = (ch - vh * scale) / 2;

      ctx.lineWidth = 2;
      ctx.strokeStyle = '#22c55e';
      ctx.fillStyle = '#22c55e';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';

      for (const p of persons) {
        const [x, y, w, h] = p.bbox;
        const bx = offX + x * scale;
        const by = offY + y * scale;
        const bw = w * scale;
        const bh = h * scale;

        ctx.strokeRect(bx, by, bw, bh);
        const label = `Người ${(p.score * 100).toFixed(0)}%`;
        const tw = ctx.measureText(label).width;
        const labelY = by > 18 ? by : by + bh; // flip below box if near top edge
        ctx.fillRect(bx, labelY - 16, tw + 8, 16);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, bx + 4, labelY - 3);
        ctx.fillStyle = '#22c55e';
      }
    };

    const loop = (ts) => {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(loop);
      const video = videoRef.current;
      if (!model || !video || video.readyState < 2 || !video.videoWidth) return;
      if (ts - lastRun < DETECT_INTERVAL_MS || busyRef.current) return;
      lastRun = ts;
      busyRef.current = true;
      model
        .detect(video, 20)
        .then((preds) => {
          if (stopped) return;
          const persons = preds.filter((p) => p.class === 'person' && p.score >= MIN_SCORE);
          draw(persons);
          if (onCount) onCount(persons.length);
        })
        .catch(() => {})
        .finally(() => { busyRef.current = false; });
    };

    setStatus('loading');
    loadModel()
      .then((m) => {
        if (stopped) return;
        model = m;
        setStatus('ready');
        rafRef.current = requestAnimationFrame(loop);
      })
      .catch(() => { if (!stopped) setStatus('error'); });

    return () => {
      stopped = true;
      cancelAnimationFrame(rafRef.current);
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx && ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      if (onCount) onCount(0);
    };
  }, [active, videoRef, onCount]);

  if (!active) return null;

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none', zIndex: 2 }}
      />
      {status === 'loading' && (
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 3,
          background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 11,
          padding: '3px 8px', borderRadius: 4,
        }}>
          Đang tải AI nhận diện…
        </div>
      )}
      {status === 'error' && (
        <div style={{
          position: 'absolute', top: 8, left: 8, zIndex: 3,
          background: 'rgba(220,38,38,0.85)', color: '#fff', fontSize: 11,
          padding: '3px 8px', borderRadius: 4,
        }}>
          Không tải được model AI
        </div>
      )}
    </>
  );
}
