import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import Layout from './components/Layout';
import AuthGuard from './components/AuthGuard';
import LoginPage from './pages/LoginPage';

// Route-level code splitting: only the login screen and the shell are needed for
// first paint. Everything else — including the pages that pull in hls.js and
// date-fns — loads on navigation, which keeps the initial bundle small.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Events = lazy(() => import('./pages/Events'));
const EventDetail = lazy(() => import('./pages/EventDetail'));
const Cameras = lazy(() => import('./pages/Cameras'));
const PlaybackPage = lazy(() => import('./pages/PlaybackPage'));
const UploadPage = lazy(() => import('./pages/UploadPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));
const PlatesPage = lazy(() => import('./pages/PlatesPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));

function RouteFallback() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '40vh',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          border: '3px solid rgba(148,163,184,0.2)',
          borderTop: '3px solid #10b981',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<AuthGuard />}>
              <Route element={<Layout />}>
                <Route index element={<Dashboard />} />
                <Route path="events" element={<Events />} />
                <Route path="events/:id" element={<EventDetail />} />
                <Route path="cameras" element={<Cameras />} />
                <Route path="playback" element={<PlaybackPage />} />
                <Route path="upload" element={<UploadPage />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="plates" element={<PlatesPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="profile" element={<ProfilePage />} />
              </Route>
            </Route>
            <Route path="*" element={<Navigate to="/cameras" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </ToastProvider>
  );
}