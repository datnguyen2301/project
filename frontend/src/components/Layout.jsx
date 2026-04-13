import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState, useCallback, useRef, useLayoutEffect } from 'react';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import {
  LayoutDashboard,
  Clock,
  Search,
  RectangleHorizontal,
  UserRound,
  Settings,
  Plus,
  Moon,
  Sun,
  Menu,
  LogOut,
} from 'lucide-react';
import { api, clearToken, getToken } from '../api';
import { useToast } from './Toast';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Camera trực tiếp' },
  { to: '/events', icon: Clock, label: 'Sự kiện' },
  { to: '/search', icon: Search, label: 'Tra cứu' },
  { to: '/plates', icon: RectangleHorizontal, label: 'Biển số xe' },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const addToast = useToast();
  const [time, setTime] = useState(new Date());
  const [todayCount, setTodayCount] = useState(0);
  const [dark, setDark] = useState(() => localStorage.getItem('theme') === 'dark');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const lastEventRef = useRef(null);
  const sidebarRef = useRef(null);
  const sidebarLogoRef = useRef(null);
  const logoTextRef = useRef(null);
  const logoSubRef = useRef(null);

  // #region agent log
  useLayoutEffect(() => {
    const run = () => {
      const aside = sidebarRef.current;
      const container = sidebarLogoRef.current;
      const textEl = logoTextRef.current;
      const subEl = logoSubRef.current;
      if (!aside || !container || !textEl || !subEl) return;
      const ccs = getComputedStyle(container);
      const subCs = getComputedStyle(subEl);
      const lh = parseFloat(subCs.lineHeight) || 14;
      const data = {
        sidebarW: aside.clientWidth,
        containerInnerW: container.clientWidth,
        flexGap: ccs.gap,
        paddingH: parseFloat(ccs.paddingLeft) + parseFloat(ccs.paddingRight),
        logoTextW: textEl.getBoundingClientRect().width,
        subClientW: subEl.clientWidth,
        subScrollW: subEl.scrollWidth,
        subOffsetH: subEl.offsetHeight,
        subLineHeightPx: lh,
        H_A_rowCrowding: textEl.getBoundingClientRect().width + parseFloat(ccs.columnGap || ccs.gap || 0) + subEl.scrollWidth > container.clientWidth,
        H_B_subOverflow: subEl.scrollWidth > subEl.clientWidth,
        H_C_multiLine: subEl.offsetHeight > lh * 1.4,
      };
      fetch('http://127.0.0.1:7329/ingest/7003fb2f-82c9-4bde-8993-216e52b41cb5', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'a8b71c' }, body: JSON.stringify({ sessionId: 'a8b71c', runId: 'post-fix', location: 'Layout.jsx:sidebarLogo', message: 'sidebar logo layout measure', data: { ...data, layoutVariant: 'stacked' }, timestamp: Date.now(), hypothesisId: 'A-E' }) }).catch(() => {});
    };
    run();
    window.addEventListener('resize', run);
    return () => window.removeEventListener('resize', run);
  }, []);
  // #endregion

  // Cameras page uses SSE watcher, no toast needed there to avoid duplicate notifications
  const isCamerasPage = location.pathname === '/cameras' || location.pathname === '/';

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  const pollEvents = useCallback(async () => {
    try {
      const s = await api.getStats();
      setTodayCount(s?.todayEvents ?? 0);

      const d = await api.getEvents({ limit: 1 });
      const latest = d.events?.[0];
      // Skip toast on Cameras page to avoid duplicate notifications
      // (Cameras page already shows detection alerts via SSE)
      if (latest && lastEventRef.current && latest._id !== lastEventRef.current && !isCamerasPage) {
        const cam = latest.cameraId?.name || 'Camera';
        const tags = latest.tags || [];
        let msg = `Sự kiện mới từ ${cam}`;
        if (tags.includes('person')) msg = `Phát hiện người tại ${cam}`;
        else if (tags.includes('vehicle')) msg = `Phương tiện tại ${cam}`;
        addToast(msg, 'info');
      }
      if (latest) lastEventRef.current = latest._id;
    } catch { /* ignore */ }
  }, [addToast, isCamerasPage]);

  useEffect(() => {
    pollEvents();
    const t = setInterval(pollEvents, 10000);
    return () => clearInterval(t);
  }, [pollEvents]);

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (getToken()) {
      api.getMe().then((d) => setCurrentUser(d.user)).catch(() => clearToken());
    }
  }, []);

  const handleLogout = () => {
    clearToken();
    navigate('/login', { replace: true });
  };

  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

      if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const searchInput = document.querySelector('.search-input');
        if (searchInput) searchInput.focus();
      }
      if (e.key === 'Escape') {
        setMobileOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const dateStr = format(time, "EEEE, dd/MM/yyyy — HH:mm:ss", { locale: vi });

  return (
    <div className="app-shell">
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      <aside ref={sidebarRef} className={`sidebar${mobileOpen ? ' open' : ''}`} aria-label="Thanh điều hướng">
        <div ref={sidebarLogoRef} className="sidebar-logo">
          <div className="sidebar-logo-brand">
            <div ref={logoTextRef} className="logo-text">&#9672; VisionGuard</div>
            <div ref={logoSubRef} className="logo-sub">Hệ thống giám sát</div>
          </div>
        </div>
        <nav className="sidebar-nav" aria-label="Menu chính">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              end={item.to === '/'}
              aria-label={item.label}
            >
              <item.icon size={14} className="nav-icon" />
              <span className="nav-label">{item.label}</span>
              {item.to === '/events' && todayCount > 0 && (
                <span className="nav-badge" aria-label={`${todayCount} sự kiện hôm nay`}>
                  {todayCount > 99 ? '99+' : todayCount}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          {currentUser && (
            <>
              <div className="sidebar-profile">
                <div className="sidebar-profile-avatar" aria-hidden>
                  {String(currentUser.username || '?').charAt(0).toUpperCase()}
                </div>
                <div className="sidebar-profile-text">
                  <div className="sidebar-profile-name">{currentUser.username}</div>
                  {currentUser.email && (
                    <div className="sidebar-profile-email" title={currentUser.email}>
                      {currentUser.email}
                    </div>
                  )}
                </div>
              </div>
              <div className="sidebar-footer-links" role="navigation" aria-label="Tài khoản">
                <NavLink
                  to="/profile"
                  className={({ isActive }) => `sidebar-footer-link${isActive ? ' active' : ''}`}
                  end
                >
                  <UserRound size={15} className="sidebar-footer-link-icon" aria-hidden />
                  <span>Hồ sơ của tôi</span>
                </NavLink>
                <NavLink
                  to="/settings"
                  className={({ isActive }) => `sidebar-footer-link${isActive ? ' active' : ''}`}
                >
                  <Settings size={15} className="sidebar-footer-link-icon" aria-hidden />
                  <span>Cài đặt</span>
                </NavLink>
              </div>
            </>
          )}
          <button type="button" className="nav-item nav-logout" onClick={handleLogout} aria-label="Đăng xuất">
            <LogOut size={14} className="nav-icon" />
            <span className="nav-label">Đăng xuất</span>
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button className="hamburger" onClick={() => setMobileOpen(true)} aria-label="Mở menu">
            <Menu size={20} />
          </button>
          <div>
            <div className="topbar-title"><span className="dot" />Hệ thống đang hoạt động</div>
            <div className="topbar-sub">{dateStr}</div>
          </div>
          <div className="topbar-right">
            <button className="theme-toggle" onClick={() => setDark((d) => !d)} aria-label={dark ? 'Chuyển light mode' : 'Chuyển dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
              {dark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
            <button className="btn" aria-label="Xuất báo cáo">Xuất báo cáo</button>
            <button className="btn btn-primary" onClick={() => navigate('/cameras')} aria-label="Thêm camera">
              <Plus size={14} /> Thêm camera
            </button>
          </div>
        </header>

        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
