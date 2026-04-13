const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  if (req.method === 'GET' && req.path === '/events') {
    return next();
  }
  const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
  if (
    req.method === 'GET' &&
    /^\/api\/ipcam\/(stream|snapshot)\//.test(pathOnly)
  ) {
    return next();
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'visionguard-secret-key');
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = auth;
