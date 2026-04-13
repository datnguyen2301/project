const COLORS = {
  person: '#22c55e',
  vehicle: '#3b82f6',
  plate: '#f59e0b',
};

export default function AnalysisOverlay({ analysis, imgWidth, imgHeight, naturalWidth, naturalHeight }) {
  if (!analysis || !naturalWidth) return null;

  const scaleX = imgWidth / naturalWidth;
  const scaleY = imgHeight / naturalHeight;

  const boxes = [];

  (analysis.persons || []).forEach((p, i) => {
    boxes.push({ ...p.bbox, label: `Person ${(p.confidence * 100).toFixed(0)}%`, color: COLORS.person, key: `p${i}` });
  });
  (analysis.vehicles || []).forEach((v, i) => {
    boxes.push({ ...v.bbox, label: `${v.type} ${(v.confidence * 100).toFixed(0)}%`, color: COLORS.vehicle, key: `v${i}` });
  });
  (analysis.licensePlates || []).forEach((lp, i) => {
    boxes.push({ ...lp.bbox, label: lp.plateNumber, color: COLORS.plate, key: `lp${i}` });
  });

  return (
    <svg
      className="analysis-overlay"
      width={imgWidth}
      height={imgHeight}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
    >
      {boxes.map((b) => (
        <g key={b.key}>
          <rect
            x={b.x * scaleX}
            y={b.y * scaleY}
            width={b.width * scaleX}
            height={b.height * scaleY}
            fill="none"
            stroke={b.color}
            strokeWidth={2}
          />
          <rect
            x={b.x * scaleX}
            y={b.y * scaleY - 20}
            width={b.label.length * 8 + 8}
            height={20}
            fill={b.color}
            rx={3}
          />
          <text
            x={b.x * scaleX + 4}
            y={b.y * scaleY - 5}
            fill="#fff"
            fontSize={12}
            fontWeight="bold"
          >
            {b.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
