const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');

router.use(authMiddleware);

// Lightweight endpoint the client polls to detect connectivity + do a clock check.
// The actual sync of each transaction type happens by POSTing to its normal
// (idempotent, client_uuid-keyed) REST endpoint — see frontend/src/db/sync.js.
router.get('/ping', (req, res) => {
  res.json({ ok: true, serverTime: new Date().toISOString() });
});

router.get('/conflicts', (req, res) => {
  res.json(db.prepare(`SELECT * FROM sync_conflicts WHERE status = 'OPEN' ORDER BY id DESC`).all());
});

module.exports = router;
