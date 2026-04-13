export function isIpWebcamAddress(addr) {
  const s = String(addr || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(s)) return true;
  if (s.includes('.') || s.includes(':')) return true;
  return false;
}

export function isIpWebcamCamera(cam) {
  return isIpWebcamAddress(cam?.ipAddress);
}

export function isEzvizStyleCamera(cam) {
  const s = String(cam?.ipAddress || '').trim();
  if (!s) return false;
  if (isIpWebcamAddress(s)) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}
