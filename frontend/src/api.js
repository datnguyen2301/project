const BASE = '/api';

export function uploadsUrl(imagePath) {
  const raw = String(imagePath || '').trim().replace(/^\/+/, '');
  const name = raw.replace(/^uploads\//i, '');
  if (!name) return '';
  const base = import.meta.env.BASE_URL || '/';
  const result = `${base}uploads/${name}`;
  // #region agent log
  fetch('http://127.0.0.1:7329/ingest/7003fb2f-82c9-4bde-8993-216e52b41cb5', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'a8b71c' }, body: JSON.stringify({ sessionId: 'a8b71c', runId: 'pre-fix', hypothesisId: 'H1', location: 'api.js:uploadsUrl', message: 'uploadsUrl_called', data: { imagePath, raw, name, result }, timestamp: Date.now() }) }).catch(() => {});
  // #endregion
  return result;
}

const TOKEN_KEY = 'vg_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || null;
}

export function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function request(url, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.headers || {}),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (!(options.body instanceof FormData) && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${url}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Request failed: ${res.status}`);
    if (res.status === 401) {
      err.unauthorized = true;
      clearToken();
      window.location.href = '/login';
      return;
    }
    throw err;
  }
  return res.json();
}

export const api = {
  getCameras: () => request('/cameras'),
  createCamera: (data) =>
    request('/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateCamera: (id, data) =>
    request(`/cameras/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteCamera: (id) => request(`/cameras/${id}`, { method: 'DELETE' }),

  getEvents: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return request(`/events?${qs}`);
  },
  getEvent: (id) => request(`/events/${id}`),
  deleteEvent: (id) => request(`/events/${id}`, { method: 'DELETE' }),
  reanalyze: (id) => request(`/events/${id}/analyze`, { method: 'POST' }),
  getStats: () => request('/events/stats'),

  uploadEvent: (formData) =>
    fetch(`${BASE}/events/upload`, { method: 'POST', body: formData }).then(
      async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Upload failed');
        }
        return res.json();
      }
    ),

  ezvizSyncCameras: () => request('/ezviz/sync-cameras', { method: 'POST' }),
  ezvizCapture: (deviceSerial, channelNo = 1) =>
    request(`/ezviz/capture/${encodeURIComponent(deviceSerial)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelNo }),
    }),
  ezvizDevices: () => request('/ezviz/devices'),

  ipcamCapture: (cameraId) =>
    request(`/ipcam/capture/${cameraId}`, { method: 'POST' }),
  ipcamSnapshot: (cameraId) => `${BASE}/ipcam/snapshot/${cameraId}`,
  ipcamStream: (cameraId) => `${BASE}/ipcam/stream/${cameraId}`,
  ipcamTest: () => request('/ipcam/test'),

  watcherStart: (cameraId) =>
    request(`/watcher/start/${cameraId}`, { method: 'POST' }),
  watcherStop: (cameraId) =>
    request(`/watcher/stop/${cameraId}`, { method: 'POST' }),
  watcherStatus: () => request('/watcher/status'),
  watcherStream: () => {
    const es = new EventSource('/api/events/stream');
    return es;
  },

  getRecordingStatus: () => request('/watcher/recording/status'),
  getClips: (cameraId) => request(`/watcher/recording/clips${cameraId ? `/${cameraId}` : ''}`),
  deleteClip: (clipId) => request(`/watcher/recording/clips/${clipId}`, { method: 'DELETE' }),
  reanalyzeClip: (clipId) => request(`/watcher/recording/clips/${clipId}/reanalyze`, { method: 'POST' }),

  getBlacklist: () => request('/blacklist'),
  addBlacklist: (plateNumber, reason = '') =>
    request('/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plateNumber, reason }),
    }),
  removeBlacklist: (id) => request(`/blacklist/${id}`, { method: 'DELETE' }),
  checkBlacklist: (plate) => request(`/blacklist/check/${plate}`),

  streamStart: (cameraId) =>
    request(`/stream/start/${cameraId}`, { method: 'POST' }),
  streamStop: (cameraId) =>
    request(`/stream/stop/${cameraId}`, { method: 'POST' }),
  streamStatus: () => request('/stream/status'),

  login: (username, password) =>
    request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  register: (username, email, password) =>
    request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    }),
  getMe: () => request('/auth/me'),
};
