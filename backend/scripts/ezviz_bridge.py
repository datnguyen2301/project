"""
Bridge script between Node.js backend and pyezviz.
Called via child_process.execFile with JSON args, returns JSON to stdout.

Usage:
  python ezviz_bridge.py <command> <json_args>

Commands:
  devices   - List all cameras
  status    - Get single camera status { serial }
  capture   - Capture image { serial }
  rtsp_info - Get RTSP connection details { serial }
"""

import sys
import json
import os

sys.setrecursionlimit(10000)

from pyezviz import EzvizClient, EzvizCamera
import requests


def _patch_requests_timeout():
    """Patch all HTTP calls with timeouts so calls don't hang forever."""
    _orig_rget = requests.get
    _orig_rpost = requests.post
    _orig_session_get = requests.Session.get
    _orig_session_post = requests.Session.post

    def timed_get(url, **kw):
        kw.setdefault('timeout', 10)
        return _orig_rget(url, **kw)

    def timed_post(url, **kw):
        kw.setdefault('timeout', 10)
        return _orig_rpost(url, **kw)

    def timed_session_get(self, url, **kw):
        kw.setdefault('timeout', 10)
        return _orig_session_get(self, url, **kw)

    def timed_session_post(self, url, **kw):
        kw.setdefault('timeout', 10)
        return _orig_session_post(self, url, **kw)

    requests.get = timed_get
    requests.post = timed_post
    requests.Session.get = timed_session_get
    requests.Session.post = timed_session_post


_patch_requests_timeout()


def get_client():
    email = os.environ.get("EZVIZ_EMAIL", "")
    password = os.environ.get("EZVIZ_PASSWORD", "")
    region = os.environ.get("EZVIZ_REGION", "apiisgp")
    url = f"{region}.ezvizlife.com" if "." not in region else region

    if not email or not password:
        raise ValueError("EZVIZ_EMAIL and EZVIZ_PASSWORD env vars required")

    client = EzvizClient(email, password, url)
    client.login()
    return client


def _good_ip(addr):
    if addr is None:
        return False
    s = str(addr).strip()
    return bool(s) and s != "0.0.0.0"


def _infer_online(info):
    """
    deviceInfos.status: 1 = online, 2 = offline (EZVIZ / pyEzviz).
    Some firmware returns 0 or omits status while CONNECTION/WIFI still shows a real IP.
    """
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


def cmd_devices(client, _args):
    """Get all devices with status info."""
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


def cmd_status(client, args):
    """Get single camera detailed status."""
    serial = args.get("serial", "")
    if not serial:
        raise ValueError("serial is required")
    cam = EzvizCamera(client, serial)
    return cam.status()


def _pic_from_alarm(alarm):
    return alarm.get("picUrl") or alarm.get("alarmPicUrl")


def _is_real_pic_url(url):
    if not url or not str(url).startswith("http"):
        return False
    u = str(url).lower()
    if "ezviz_logo" in u:
        return False
    if "ezvizlife.com/ovs_mall" in u:
        return False
    return True


def _alarm_time_ms(alarm):
    """Best-effort extraction of an alarm's capture time as epoch milliseconds.

    Different EZVIZ regions/devices use different field names/formats; try the
    common numeric epoch fields first, then a "YYYY-MM-DD HH:MM:SS" string.
    Returns None if no time can be parsed.
    """
    for k in ("alarmStartTime", "alarmTime", "startTime", "createTime", "sysTime"):
        v = alarm.get(k)
        if isinstance(v, (int, float)) and v > 0:
            return int(v if v > 1e12 else v * 1000)
        if isinstance(v, str) and v.isdigit():
            n = int(v)
            return n if n > 1e12 else n * 1000
    import datetime
    for k in ("alarmStartTimeStr", "alarmTimeStr", "startTimeStr"):
        s = alarm.get(k)
        if s:
            for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
                try:
                    return int(datetime.datetime.strptime(str(s)[:19], fmt).timestamp() * 1000)
                except Exception:
                    pass
    return None


def _last_alarm_pic_and_time(client, serial, fast=False):
    """Scan recent cloud alarms for a real thumbnail; fallback to EzvizCamera.status.

    Returns (picUrl, picTimeMs). picTimeMs is None when unknown (e.g. the status
    fallback), which callers should treat as "not fresh".
    """
    limits = (5,) if fast else (40, 15, 5)
    for limit in limits:
        data = client.get_alarminfo(serial, limit=limit)
        alarms = data.get("alarms") or []
        for alarm in alarms:
            pic = _pic_from_alarm(alarm)
            if _is_real_pic_url(pic):
                return pic, _alarm_time_ms(alarm)

    cam = EzvizCamera(client, serial)
    st = cam.status()
    pic = st.get("last_alarm_pic") or ""
    if _is_real_pic_url(pic):
        return pic, None

    raise ValueError(
        "EZVIZ không có ảnh cloud hợp lệ. Cần camera cùng LAN: bật RTSP, điền Verify Code "
        "và dùng Capture (hoặc đợi có cảnh báo chuyển động trên app EZVIZ)."
    )


def cmd_capture(client, args):
    """Resolve last cloud image URL for camera (alarm snapshot, not true RTSP live).

    Also returns picTime (epoch ms) so callers can reject a stale alarm image.
    """
    serial = args.get("serial", "")
    if not serial:
        raise ValueError("serial is required")
    url, pic_time = _last_alarm_pic_and_time(client, serial, fast=args.get("fast", False))
    return {"serial": serial, "picUrl": url, "picTime": pic_time}


def cmd_rtsp_info(client, args):
    """Get RTSP connection info for local LAN streaming via FFmpeg."""
    serial = args.get("serial", "")
    if not serial:
        raise ValueError("serial is required")

    cam = EzvizCamera(client, serial)
    st = cam.status()

    local_ip = st.get("local_ip", "0.0.0.0")
    rtsp_port = str(st.get("local_rtsp_port", "554"))
    encrypted = st.get("encrypted", False)
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
        "encrypted": encrypted,
        "camKey": cam_key or "",
        "isLocalIpValid": is_local_ip_valid,
    }


COMMANDS = {
    "devices": cmd_devices,
    "status": cmd_status,
    "capture": cmd_capture,
    "rtsp_info": cmd_rtsp_info,
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ezviz_bridge.py <command> [json_args]"}))
        sys.exit(1)

    command = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

    if command not in COMMANDS:
        print(json.dumps({"error": f"Unknown command: {command}"}))
        sys.exit(1)

    client = None
    try:
        client = get_client()
        result = COMMANDS[command](client, args)
        print(json.dumps({"ok": True, "data": result}, default=str))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)
    finally:
        if client:
            try:
                client.close_session()
            except Exception:
                pass


if __name__ == "__main__":
    main()
