function isIpWebcamAddress(ipAddress) {
  const s = String(ipAddress || '').trim();
  if (!s) return false;
  if (/^https?:\/\//i.test(s)) return true;
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(s)) return true;
  if (s.includes('.') || s.includes(':')) return true;
  return false;
}

function isEzvizSerialAddress(ipAddress) {
  const s = String(ipAddress || '').trim();
  if (!s) return false;
  if (isIpWebcamAddress(s)) return false;
  return /^[A-Za-z0-9_-]+$/.test(s);
}

module.exports = { isIpWebcamAddress, isEzvizSerialAddress };
