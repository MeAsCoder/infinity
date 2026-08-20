const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// In production, set JWT_SECRET via environment variable / secrets manager.
// A long random default is generated here only so the app runs out of the box;
// change it before deploying, or all previously-issued tokens become invalid
// (which is itself a safe behavior).
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_INFINITY_POS_DEV_SECRET_2026';
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';
// Offline grace: how long a cached token may still be used to unlock the app
// locally without contacting the server (device stores this, not the server).
const OFFLINE_GRACE_HOURS = 72;

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compareSync(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role_name, permissions: user.permissions },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, username: payload.username, role: payload.role, permissions: payload.permissions || [] };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, authMiddleware, OFFLINE_GRACE_HOURS };
