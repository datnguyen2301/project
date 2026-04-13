"""
Persistent EZVIZ bridge server.
Login once, keep session alive, serve HTTP requests.

Usage:
  python ezviz_server.py

Port: 5101
"""

import json
import os
import signal
import threading
import time
from dotenv import load_dotenv
from http.server import HTTPServer, BaseHTTPRequestHandler

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from pyezviz import EzvizClient, EzvizCamera

PORT = int(os.environ.get("EZVIZ_SERVER_PORT", "5101"))
HANDLER_TIMEOUT_SEC = 18

# ── Session management ────────────────────────────────────────────────────────
_client = None
_client_lock = threading.Lock()
_last_login = 0
SESSION_TTL_SEC = 3600  # re-login sau 1 tiếng

_client_login_error = None


def get_client():
    global _client, _last_login, _client_login_error
    with _client_lock:
        now = time.time()
        if _client and (now - _last_login) < SESSION_TTL_SEC:
            return _client

        email = os.environ.get("EZVIZ_EMAIL", "")
        password = os.environ.get("EZVIZ_PASSWORD", "")
        region = os.environ.get("EZVIZ_REGION", "apiisgp")
        url = f"{region}.ezvizlife.com" if "." not in region else region

        if not email or not password:
            raise ValueError("EZVIZ_EMAIL and EZVIZ_PASSWORD env vars required")

        if _client:
            try:
                _client.close_session()
            except Exception:
                pass

        _client = None
        _client_login_error = None
        c = EzvizClient(email, password, url)
        c.login()
        _client = c
        _last_login = now
        print(f"[ezviz-server] Logged in as {email}", flush=True)
        return _client


def get_login_error():
    return _client_login_error


# ── Alarm URL cache ───────────────────────────────────────────────────────────
_alarm_cache = {}
_alarm_cache_ttl = 30  # seconds


def _is_real_pic_url(url):
    if not url or not str(url).startswith("http"):
        return False
    u = str(url).lower()
    if "ezviz_logo" in u:
        return False
    if "ovs_mall" in u:
        return False
    return True


def _pic_from_alarm(alarm):
    return alarm.get("picUrl") or alarm.get("alarmPicUrl")


def _get_alarm_url(client, serial, fast=False):
    # Check cache first
    cached = _alarm_cache.get(serial)
    if cached and (time.time() - cached["ts"]) < _alarm_cache_ttl:
        return cached["url"]

    if fast:
        data = client.get_alarminfo(serial, limit=5)
        alarms = data.get("alarms") or []
        for alarm in alarms:
            pic = _pic_from_alarm(alarm)
            if _is_real_pic_url(pic):
                _alarm_cache[serial] = {"url": pic, "ts": time.time()}
                return pic
    else:
        for limit in (40, 15, 5):
            data = client.get_alarminfo(serial, limit=limit)
            alarms = data.get("alarms") or []
            for alarm in alarms:
                pic = _pic_from_alarm(alarm)
                if _is_real_pic_url(pic):
                    _alarm_cache[serial] = {"url": pic, "ts": time.time()}
                    return pic

        # Fallback: camera status last alarm pic
        cam = EzvizCamera(client, serial)
        st = cam.status()
        pic = st.get("last_alarm_pic") or ""
        if _is_real_pic_url(pic):
            _alarm_cache[serial] = {"url": pic, "ts": time.time()}
            return pic

    raise ValueError(
        f"No valid alarm image found for {serial}"
    )


# ── Helpers from ezviz_bridge.py ──────────────────────────────────────────────

def _good_ip(addr):
    if addr is None:
        return False
    s = str(addr).strip()
    return bool(s) and s != "0.0.0.0"


def _infer_online(info):
    dev = info.get("deviceInfos") or {}
    raw = dev.get("status")
    if raw is not None and raw != "":
        try:
            v = int(raw)
            if v == 1:
                return True
            if v == 2:
                return False
        except (TypeError, ValueError):
            pass
        s = str(raw).strip().lower()
        if s in ("1", "online", "true"):
            return True
        if s in ("2", "offline", "false"):
            return False

    conn = info.get("CONNECTION") or {}
    if _good_ip(conn.get("netIp")) or _good_ip(conn.get("localIp")):
        return True

    wifi = info.get("WIFI") or {}
    if _good_ip(wifi.get("address")):
        return True

    return False


# ── Command handlers ───────────────────────────────────────────────────────────

def handle_devices(client, _args):
    devices = client.get_device_infos()
    result = []
    for serial, info in devices.items():
        dev = info.get("deviceInfos") or {}
        result.append({
            "deviceSerial": serial,
            "deviceName": dev.get("name") or dev.get("deviceName") or serial,
            "deviceModel": dev.get("deviceType", ""),
            "status": 1 if _infer_online(info) else 0,
            "deviceCover": dev.get("deviceCover", dev.get("devicePicPrefix", "")) or "",
        })
    return result


def handle_status(client, args):
    serial = args.get("serial", "")
    if not serial:
        raise ValueError("serial required")
    cam = EzvizCamera(client, serial)
    return cam.status()


def handle_capture(client, args):
    serial = args.get("serial", "")
    if not serial:
        raise ValueError("serial required")
    url = _get_alarm_url(client, serial, fast=args.get("fast", True))
    return {"serial": serial, "picUrl": url}


def handle_rtsp_info(client, args):
    serial = args.get("serial", "")
    if not serial:
        raise ValueError("serial required")

    cam = EzvizCamera(client, serial)
    st = cam.status()
    local_ip = st.get("local_ip", "0.0.0.0")
    rtsp_port = str(st.get("local_rtsp_port", "554"))
    is_local_ip_valid = _good_ip(local_ip)

    cam_key = None
    try:
        cam_key = client.get_cam_key(serial)
    except Exception:
        pass

    return {
        "serial": serial,
        "localIp": local_ip,
        "rtspPort": rtsp_port,
        "encrypted": st.get("encrypted", False),
        "camKey": cam_key or "",
        "isLocalIpValid": is_local_ip_valid,
    }


# Thread-based timeout for Windows (signal.alarm doesn't work on Windows)
def _run_with_timeout(func, args, timeout_sec):
    result = [None]   # container to hold result
    exc = [None]       # container to hold exception

    def target():
        try:
            result[0] = func(*args)
        except Exception as e:
            exc[0] = e

    t = threading.Thread(target=target, daemon=True)
    t.start()
    t.join(timeout_sec)
    if t.is_alive():
        # Force re-login on timeout — the EZVIZ API call hung
        global _last_login, _client_login_error
        _last_login = 0
        _client_login_error = f"Command timed out after {timeout_sec}s"
        raise TimeoutError(f"Command timed out after {timeout_sec}s")
    if exc[0]:
        raise exc[0]
    return result[0]


HANDLERS = {
    "devices": handle_devices,
    "status": handle_status,
    "capture": handle_capture,
    "rtsp_info": handle_rtsp_info,
}


# ── HTTP Handler ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            ok = _client is not None
            err = _client_login_error
            self._respond(200, {
                "ok": True,
                "logged_in": ok,
                "login_error": err,
                "uptime_sec": round(time.time() - _last_login) if _last_login else 0,
            })
        else:
            self._respond(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length)) if length else {}
        except Exception as e:
            self._respond(400, {"ok": False, "error": f"Invalid request: {e}"})
            return

        command = body.get("command", "")
        args = body.get("args", {})

        if not command:
            self._respond(400, {"ok": False, "error": "command is required"})
            return

        if command not in HANDLERS:
            self._respond(400, {"ok": False, "error": f"Unknown command: {command}"})
            return

        try:
            client = get_client()
            handler_fn = HANDLERS[command]
            result = _run_with_timeout(handler_fn, (client, args), HANDLER_TIMEOUT_SEC)
            self._respond(200, {"ok": True, "data": result})
        except TimeoutError as e:
            self._respond(504, {"ok": False, "error": str(e)})
        except Exception as e:
            global _client_login_error, _last_login
            err_msg = str(e)
            # On session error, force re-login next time
            if any(kw in err_msg.lower() for kw in ("session", "token", "expired", "login", "auth")):
                _last_login = 0
                _client_login_error = err_msg
            self._respond(500, {"ok": False, "error": err_msg})

    def _respond(self, code, data):
        body = json.dumps(data, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:
            pass

    def log_message(self, fmt, *args):
        pass


# ── Startup ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"[ezviz-server] Starting on port {PORT}...", flush=True)

    # Try initial login
    try:
        get_client()
    except Exception as e:
        print(f"[ezviz-server] Initial login failed: {e}", flush=True)
        print(f"[ezviz-server] Will retry on first request", flush=True)

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[ezviz-server] Ready on http://127.0.0.1:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("[ezviz-server] Shutting down", flush=True)
        server.shutdown()
