export function SkeletonLine({ width = '100%', height = 14 }) {
  return <div className="skeleton" style={{ width, height, borderRadius: 4 }} />;
}

export function SkeletonCard() {
  return (
    <div className="skeleton-card">
      <SkeletonLine height={120} />
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SkeletonLine width="60%" />
        <SkeletonLine width="40%" />
        <div style={{ display: 'flex', gap: 6 }}>
          <SkeletonLine width={50} height={18} />
          <SkeletonLine width={50} height={18} />
        </div>
      </div>
    </div>
  );
}

export function SkeletonMetric() {
  return (
    <div className="metric-card">
      <SkeletonLine width="50%" height={10} />
      <SkeletonLine width="40%" height={24} />
      <SkeletonLine width="70%" height={10} />
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div className="event-item" style={{ opacity: 0.5 }}>
      <div className="skeleton" style={{ width: 44, height: 32, borderRadius: 4 }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <SkeletonLine width="70%" />
        <SkeletonLine width="45%" height={11} />
      </div>
    </div>
  );
}
