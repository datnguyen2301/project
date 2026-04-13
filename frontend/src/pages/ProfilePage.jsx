import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { UserRound, Mail, Calendar, Shield } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';

export default function ProfilePage() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api
      .getMe()
      .then((d) => {
        if (!cancelled) setUser(d.user);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message || 'Không tải được hồ sơ');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const initial = user?.username?.charAt(0)?.toUpperCase() || '?';
  const joined =
    user?.createdAt &&
    format(new Date(user.createdAt), "d MMMM yyyy", { locale: vi });

  return (
    <div className="profile-page">
      <div className="profile-hero card">
        <div className="profile-hero-bg" aria-hidden />
        <div className="profile-hero-body">
          <div className="profile-hero-avatar" aria-hidden>
            {initial}
          </div>
          <div className="profile-hero-text">
            <h1 className="profile-hero-name">{user?.username || '—'}</h1>
            <p className="profile-hero-role">Tài khoản VisionGuard</p>
          </div>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginBottom: 16 }}>{error}</div>}

      {!user && !error && (
        <div className="card">
          <div className="card-body">
            <div className="skeleton" style={{ height: 120, borderRadius: 8 }} />
          </div>
        </div>
      )}

      {user && (
        <div className="card profile-detail-card">
          <div className="card-header">
            <span className="card-title">Thông tin tài khoản</span>
          </div>
          <div className="card-body">
            <ul className="profile-info-list">
              <li>
                <UserRound size={18} className="profile-info-icon" aria-hidden />
                <div>
                  <div className="profile-info-label">Tên đăng nhập</div>
                  <div className="profile-info-value">{user.username}</div>
                </div>
              </li>
              <li>
                <Mail size={18} className="profile-info-icon" aria-hidden />
                <div>
                  <div className="profile-info-label">Email</div>
                  <div className="profile-info-value">{user.email}</div>
                </div>
              </li>
              {joined && (
                <li>
                  <Calendar size={18} className="profile-info-icon" aria-hidden />
                  <div>
                    <div className="profile-info-label">Tham gia</div>
                    <div className="profile-info-value">{joined}</div>
                  </div>
                </li>
              )}
              <li>
                <Shield size={18} className="profile-info-icon" aria-hidden />
                <div>
                  <div className="profile-info-label">Bảo mật</div>
                  <div className="profile-info-value">
                    Đổi mật khẩu sẽ được bổ sung trong bản cập nhật sau.
                  </div>
                </div>
              </li>
            </ul>
            <div className="profile-actions">
              <button type="button" className="btn" onClick={() => navigate('/settings')}>
                Mở cài đặt hệ thống
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
