const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { writeAudit } = require('../ledger');

router.use(authMiddleware);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
});

router.put('/:key', requirePermission('settings.manage', '*'), (req, res) => {
  const { value } = req.body;
  const existing = db.prepare('SELECT * FROM settings WHERE key = ?').get(req.params.key);
  if (existing) {
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), req.params.key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(req.params.key, String(value));
  }
  writeAudit({ event: 'SETTING_CHANGED', userId: req.user.id, role: req.user.role, entityType: 'SETTING', entityId: null, oldValue: existing?.value, newValue: value, reason: req.params.key });
  res.json({ ok: true });
});

module.exports = router;
