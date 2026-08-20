const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { writeAudit } = require('../ledger');

router.use(authMiddleware);

// GET /api/audit — immutable trail; read-only, no update/delete endpoints exist anywhere in this API.
router.get('/', requirePermission('audit.view', '*'), (req, res) => {
  const { entityType, entityId, userId, event, limit } = req.query;
  let sql = `
    SELECT al.*, u.name AS user_name FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id WHERE 1=1
  `;
  const params = [];
  if (entityType) { sql += ' AND al.entity_type = ?'; params.push(entityType); }
  if (entityId) { sql += ' AND al.entity_id = ?'; params.push(entityId); }
  if (userId) { sql += ' AND al.user_id = ?'; params.push(userId); }
  if (event) { sql += ' AND al.event = ?'; params.push(event); }
  sql += ' ORDER BY al.id DESC LIMIT ?'; params.push(+(limit || 300));
  res.json(db.prepare(sql).all(...params));
});

// ---- Correction requests: how a waiter reports a mistake without being able to fix it themselves ----
router.post('/corrections', requirePermission('corrections.request', '*'), (req, res) => {
  const { type, refType, refId, reason, proposedChange } = req.body;
  if (!type || !refType || !refId || !reason) return res.status(400).json({ error: 'type, refType, refId, reason required' });
  const info = db.prepare(`
    INSERT INTO correction_requests (type, ref_type, ref_id, requested_by, reason, proposed_change)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(type, refType, refId, req.user.id, reason, proposedChange ? JSON.stringify(proposedChange) : null);
  writeAudit({ event: 'CORRECTION_REQUESTED', userId: req.user.id, role: req.user.role, entityType: refType, entityId: refId, reason });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.get('/corrections', requirePermission('corrections.approve', '*'), (req, res) => {
  const { status } = req.query;
  let sql = `SELECT cr.*, u.name AS requested_by_name FROM correction_requests cr JOIN users u ON u.id = cr.requested_by WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND cr.status = ?'; params.push(status); }
  sql += ' ORDER BY cr.id DESC LIMIT 200';
  res.json(db.prepare(sql).all(...params));
});

// Approving/rejecting NEVER edits the original entity — it's the admin's job to then
// perform the actual correction via the normal audited endpoint (refund, adjustment, etc.)
router.post('/corrections/:id/resolve', requirePermission('corrections.approve', '*'), (req, res) => {
  const { status, resolutionNotes } = req.body; // status: APPROVED | REJECTED
  if (!['APPROVED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'status must be APPROVED or REJECTED' });
  const cr = db.prepare('SELECT * FROM correction_requests WHERE id = ?').get(req.params.id);
  if (!cr) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE correction_requests SET status=?, resolved_by=?, resolution_notes=?, resolved_at=datetime('now') WHERE id=?`)
    .run(status, req.user.id, resolutionNotes || null, cr.id);
  writeAudit({ event: 'CORRECTION_RESOLVED', userId: req.user.id, role: req.user.role, entityType: cr.ref_type, entityId: cr.ref_id, newValue: { status, resolutionNotes } });
  res.json({ ok: true });
});

module.exports = router;
