const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyPassword, signToken, authMiddleware } = require('../auth');
const { writeAudit } = require('../ledger');

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password, deviceId, deviceName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });

  const user = db.prepare(`
    SELECT u.*, r.name AS role_name, r.permissions AS permissions_json
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.username = ?
  `).get(username);

  if (!user || !user.active) {
    writeAudit({ event: 'LOGIN_FAILED', reason: `unknown or inactive user: ${username}`, deviceId, ipAddress: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (!verifyPassword(password, user.password_hash)) {
    writeAudit({ event: 'LOGIN_FAILED', userId: user.id, role: user.role_name, reason: 'bad password', deviceId, ipAddress: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (deviceId) {
    db.prepare(`
      INSERT INTO devices (id, name, last_user_id) VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now'), last_user_id = excluded.last_user_id, name = COALESCE(excluded.name, devices.name)
    `).run(deviceId, deviceName || null, user.id);
  }

  const permissions = JSON.parse(user.permissions_json);
  const token = signToken({ id: user.id, username: user.username, role_name: user.role_name, permissions });

  writeAudit({ event: 'LOGIN_SUCCESS', userId: user.id, role: user.role_name, deviceId, ipAddress: req.ip });

  res.json({
    token,
    user: {
      id: user.id, name: user.name, username: user.username, role: user.role_name,
      permissions, maxDiscountPercent: user.max_discount_percent,
    },
  });
});

// GET /api/auth/me  — also how a device validates a cached token still maps to an active user
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare(`
    SELECT u.*, r.name AS role_name, r.permissions AS permissions_json
    FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?
  `).get(req.user.id);
  if (!user || !user.active) return res.status(401).json({ error: 'Account disabled' });
  res.json({
    id: user.id, name: user.name, username: user.username, role: user.role_name,
    permissions: JSON.parse(user.permissions_json), maxDiscountPercent: user.max_discount_percent,
  });
});

router.post('/logout', authMiddleware, (req, res) => {
  writeAudit({ event: 'LOGOUT', userId: req.user.id, role: req.user.role });
  res.json({ ok: true });
});

module.exports = router;
