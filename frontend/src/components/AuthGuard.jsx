import { Navigate, Outlet } from 'react-router-dom';
import { getToken } from '../api';

export default function AuthGuard() {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
