const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const BRIDGE_SCRIPT = path.join(__dirname, '..', 'scripts', 'ezviz_bridge.py');
const PYTHON = process.env.PYTHON_PATH || 'python';
const EZVIZ_SERVER = `http://127.0.0.1:${process.env.EZVIZ_SERVER_PORT || 5101}`;
const EZVIZ_SERVER_TIMEOUT_MS = 12_000;

// ── HTTP client (persistent server) ────────────────────────────────────────────

async function callServer(command, args = {}, timeoutMs = EZVIZ_SERVER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(EZVIZ_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, args }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      if (res.status === 504) throw Object.assign(new Error(`HTTP 504: ${err}`), { code: 'SERVER_TIMEOUT' });
      throw new Error(`HTTP ${res.status}: ${err}`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Unknown server error');
    return data.data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`ezviz-server timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function checkServerHealth() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${EZVIZ_SERVER}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch (_) {
    return false;
  }
}

let _serverAvailable = null;
let _lastServerCheck = 0;
const SERVER_CHECK_INTERVAL_MS = 60_000;

async function _ensureServerAvailable() {
  const now = Date.now();
  if (_serverAvailable === false && now - _lastServerCheck < SERVER_CHECK_INTERVAL_MS) {
    return false;
  }
  _lastServerCheck = now;
  _serverAvailable = await checkServerHealth();
  return _serverAvailable;
}

// ── Fallback: execFile (old slow approach) ────────────────────────────────────

function callBridge(command, args = {}, opts = {}) {
  const timeoutMs = typeof opts.timeout === 'number' ? opts.timeout : 30_000;
  return new Promise((resolve, reject) => {
    const child = execFile(
      PYTHON,
      [BRIDGE_SCRIPT, command, JSON.stringify(args)],
      {
        env: { ...process.env },
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (stderr) console.warn('[pyezviz stderr]', stderr.slice(0, 500));
        if (err) {
          if (err.code === 'ETIMEDOUT' || err.code === 'ETIME') {
            return reject(new Error(`pyezviz bridge timeout after ${timeoutMs}ms`));
          }
          if (!stdout) {
            return reject(new Error(`pyezviz bridge error: ${err.message}`));
          }
        }
        try {
          const result = JSON.parse(stdout.trim());
          if (!result.ok) return reject(new Error(result.error || 'Unknown pyezviz error'));
          resolve(result.data);
        } catch (parseErr) {
          reject(new Error(`Failed to parse pyezviz output: ${stdout.slice(0, 300)}`));
        }
      },
    );
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getDeviceList() {
  try {
    if (_serverAvailable === null) _serverAvailable = await checkServerHealth();
    if (_serverAvailable) return await callServer('devices', {});
    return await callBridge('devices');
  } catch (err) {
    if (err.code === 'SERVER_TIMEOUT' || err.message.startsWith('HTTP 504:')) {
      _serverAvailable = false;
      return await callBridge('devices');
    }
    _serverAvailable = false;
    throw err;
  }
}

async function getCameraStatus(serial) {
  try {
    if (_serverAvailable === null) _serverAvailable = await checkServerHealth();
    if (_serverAvailable) return await callServer('status', { serial });
    return await callBridge('status', { serial });
  } catch (err) {
    if (err.code === 'SERVER_TIMEOUT' || err.message.startsWith('HTTP 504:')) {
      _serverAvailable = false;
      return await callBridge('status', { serial });
    }
    _serverAvailable = false;
    throw err;
  }
}

async function captureImageViaBridge(deviceSerial, opts = {}) {
  const args = { serial: deviceSerial, fast: opts.fastMode ?? true };
  return new Promise((resolve, reject) => {
    const timeoutMs = typeof opts.timeout === 'number' ? opts.timeout : 14_000;
    const child = execFile(
      PYTHON,
      [BRIDGE_SCRIPT, 'capture', JSON.stringify(args)],
      {
        env: { ...process.env },
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (stderr) console.warn('[pyezviz bridge stderr]', stderr.slice(0, 500));
        if (err) {
          if (err.code === 'ETIMEDOUT' || err.code === 'ETIME') {
            return reject(new Error(`pyezviz bridge timeout after ${timeoutMs}ms`));
          }
          if (!stdout) {
            return reject(new Error(`pyezviz bridge error: ${err.message}`));
          }
        }
        try {
          const result = JSON.parse(stdout.trim());
          if (!result.ok) return reject(new Error(result.error || 'Unknown pyezviz error'));
          resolve(result.data);
        } catch (parseErr) {
          reject(new Error(`Failed to parse pyezviz output: ${stdout.slice(0, 300)}`));
        }
      },
    );
  });
}

async function captureImage(deviceSerial, opts = {}) {
  const args = { serial: deviceSerial, fast: opts.fastMode ?? true };
  try {
    if (_serverAvailable === null) _serverAvailable = await checkServerHealth();
    if (_serverAvailable) return await callServer('capture', args, 14_000);
    return await captureImageViaBridge(deviceSerial, opts);
  } catch (err) {
    if (err.code === 'SERVER_TIMEOUT' || err.message.startsWith('HTTP 504:')) {
      _serverAvailable = false;
      return await captureImageViaBridge(deviceSerial, opts);
    }
    _serverAvailable = false;
    throw err;
  }
}

async function downloadImage(imageUrl, uploadsDir) {
  const res = await fetch(imageUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`Failed to download image: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const filename = `ezviz_${uuidv4()}.jpg`;
  const filepath = path.join(uploadsDir, filename);
  fs.writeFileSync(filepath, buffer);
  return filename;
}

async function getRtspInfo(serial, opts = {}) {
  const timeoutMs = typeof opts.timeout === 'number' ? opts.timeout : EZVIZ_SERVER_TIMEOUT_MS;
  try {
    if (_serverAvailable === null) _serverAvailable = await checkServerHealth();
    if (_serverAvailable) return await callServer('rtsp_info', { serial }, timeoutMs);
    return await callBridge('rtsp_info', { serial }, { timeout: timeoutMs });
  } catch (err) {
    if (err.code === 'SERVER_TIMEOUT' || err.message.startsWith('HTTP 504:')) {
      _serverAvailable = false;
      return await callBridge('rtsp_info', { serial }, { timeout: timeoutMs });
    }
    _serverAvailable = false;
    throw err;
  }
}

module.exports = {
  getDeviceList,
  getCameraStatus,
  captureImage,
  captureImageViaBridge,
  downloadImage,
  getRtspInfo,
  checkServerHealth,
};
