import { UserCircle } from 'lucide-react';

export default function FacesPage() {
  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Nhận diện khuôn mặt</span>
      </div>
      <div className="card-body">
        <div className="stub-page">
          <UserCircle size={48} style={{ color: 'var(--color-text-secondary)', opacity: 0.4, marginBottom: 12 }} />
          <p>
            Tính năng nhận diện khuôn mặt đang được phát triển.
            <br />
            Khi sẵn sàng, hệ thống sẽ tự động nhận dạng và phân loại khuôn mặt từ camera.
          </p>
        </div>
      </div>
    </div>
  );
}
