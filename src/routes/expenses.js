const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { writeAudit } = require('../ledger');

router.use(authMiddleware);

// A waiter can log a CASH expense against their OWN open shift (e.g. bought
// cleaning supplies from the till) — it reduces expected cash at shift close.
// Anything else (category management, non-shift expenses) needs expenses.manage.
router.post('/', (req, res) => {
  const { category, amount, paymentMethod, description, receiptRef, shiftId, clientUuid } = req.body;
  if (!category || !amount) return res.status(400).json({ error: 'category and amount required' });

  const isOwnShiftCashExpense = shiftId && paymentMethod === 'CASH';
  if (isOwnShiftCashExpense) {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
    if (!shift || shift.user_id !== req.user.id || shift.status !== 'OPEN') {
      return res.status(403).json({ error: 'Can only log a cash expense against your own open shift' });
    }
  } else if (!req.user.permissions.includes('expenses.manage') && !req.user.permissions.includes('*')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (clientUuid) {
    const existing = db.prepare('SELECT id FROM expenses WHERE client_uuid = ?').get(clientUuid);
    if (existing) return res.status(200).json({ id: existing.id, idempotent: true });
  }

  const info = db.prepare(`
    INSERT INTO expenses (client_uuid, category, amount, payment_method, description, receipt_ref, shift_id, created_by, approved_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(clientUuid || null, category, amount, paymentMethod || 'CASH', description || null, receiptRef || null, shiftId || null, req.user.id, isOwnShiftCashExpense ? null : req.user.id);

  writeAudit({ event: 'EXPENSE_CREATED', userId: req.user.id, role: req.user.role, entityType: 'EXPENSE', entityId: info.lastInsertRowid, newValue: { category, amount, shiftId } });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.get('/', requirePermission('expenses.manage'), (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT e.*, u.name AS created_by_name FROM expenses e LEFT JOIN users u ON u.id = e.created_by WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND expense_date >= ?'; params.push(from); }
  if (to) { sql += ' AND expense_date <= ?'; params.push(to); }
  sql += ' ORDER BY e.id DESC LIMIT 300';
  res.json(db.prepare(sql).all(...params));
});

router.get('/suppliers', (req, res) => res.json(db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name').all()));

router.post('/suppliers', requirePermission('suppliers.manage'), (req, res) => {
  const { name, phone, address, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO suppliers (name, phone, address, notes) VALUES (?, ?, ?, ?)').run(name, phone || null, address || null, notes || null);
  writeAudit({ event: 'SUPPLIER_CREATED', userId: req.user.id, role: req.user.role, entityType: 'SUPPLIER', entityId: info.lastInsertRowid, newValue: { name } });
  res.status(201).json(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid));
});

module.exports = router;
