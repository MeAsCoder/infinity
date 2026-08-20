const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { getCustomerBalance, appendCreditLedger, writeAudit } = require('../ledger');

router.use(authMiddleware);

function serializeCustomer(c) {
  return { ...c, balance: getCustomerBalance(c.id) };
}

// GET /api/customers?search=
router.get('/customers', (req, res) => {
  const { search } = req.query;
  let sql = 'SELECT * FROM customers WHERE active = 1';
  const params = [];
  if (search) { sql += ' AND (name LIKE ? OR phone LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY name LIMIT 200';
  res.json(db.prepare(sql).all(...params).map(serializeCustomer));
});

router.post('/customers', (req, res) => {
  const { name, phone, address, creditLimit } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const info = db.prepare('INSERT INTO customers (name, phone, address, credit_limit) VALUES (?, ?, ?, ?)')
    .run(name, phone || null, address || null, creditLimit || 0);
  writeAudit({ event: 'CUSTOMER_CREATED', userId: req.user.id, role: req.user.role, entityType: 'CUSTOMER', entityId: info.lastInsertRowid, newValue: { name, phone } });
  res.status(201).json(serializeCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid)));
});

router.get('/customers/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const ledger = db.prepare('SELECT * FROM credit_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 100').all(c.id);
  res.json({ ...serializeCustomer(c), ledger });
});

// Only admin/manager can change credit-limit or other account terms.
router.put('/customers/:id', requirePermission('credit.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, phone, address, creditLimit, active } = req.body;
  db.prepare('UPDATE customers SET name=?, phone=?, address=?, credit_limit=?, active=? WHERE id = ?')
    .run(name ?? existing.name, phone ?? existing.phone, address ?? existing.address, creditLimit ?? existing.credit_limit, active !== undefined ? (active ? 1 : 0) : existing.active, req.params.id);
  writeAudit({ event: 'CUSTOMER_UPDATED', userId: req.user.id, role: req.user.role, entityType: 'CUSTOMER', entityId: +req.params.id, oldValue: existing, newValue: req.body });
  res.json(serializeCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id)));
});

// POST /api/customers/:id/repay — admin/manager only. Creates a NEW ledger row; the
// original credit sale is never touched.
router.post('/customers/:id/repay', requirePermission('credit.repay'), (req, res) => {
  const { amount, notes, clientUuid } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'positive amount required' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });

  if (clientUuid) {
    const existing = db.prepare(`SELECT id FROM credit_ledger WHERE ref_type = 'REPAYMENT_CLIENT_UUID' AND ref_id IS NULL AND notes LIKE ?`).get(`%${clientUuid}%`);
    if (existing) return res.status(200).json({ idempotent: true });
  }

  const entry = appendCreditLedger({
    customerId: customer.id, type: 'REPAYMENT', amount: -amount, userId: req.user.id, approvedBy: req.user.id,
    notes: (notes || 'Repayment') + (clientUuid ? ` [client:${clientUuid}]` : ''),
  });
  writeAudit({ event: 'CREDIT_REPAYMENT', userId: req.user.id, role: req.user.role, entityType: 'CUSTOMER', entityId: customer.id, newValue: { amount, balanceAfter: entry.balanceAfter } });
  res.status(201).json({ balance: entry.balanceAfter });
});

// POST /api/customers/:id/writeoff — admin only, requires reason
router.post('/customers/:id/writeoff', requirePermission('credit.manage'), (req, res) => {
  const { amount, reason } = req.body;
  if (!amount || amount <= 0 || !reason) return res.status(400).json({ error: 'positive amount and reason required' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Not found' });
  const entry = appendCreditLedger({
    customerId: customer.id, type: 'WRITEOFF', amount: -amount, userId: req.user.id, approvedBy: req.user.id, notes: reason,
  });
  writeAudit({ event: 'DEBT_WRITTEN_OFF', userId: req.user.id, role: req.user.role, entityType: 'CUSTOMER', entityId: customer.id, newValue: { amount, reason }, reason });
  res.status(201).json({ balance: entry.balanceAfter });
});

router.get('/report', requirePermission('reports.view'), (req, res) => {
  const customers = db.prepare('SELECT * FROM customers WHERE active = 1').all();
  const report = customers.map(c => {
    const balance = getCustomerBalance(c.id);
    const oldest = db.prepare(`SELECT created_at FROM credit_ledger WHERE customer_id = ? AND type='SALE' AND balance_after > 0 ORDER BY id ASC LIMIT 1`).get(c.id);
    return { id: c.id, name: c.name, phone: c.phone, balance, creditLimit: c.credit_limit, oldestOpenSale: oldest ? oldest.created_at : null };
  }).filter(c => c.balance !== 0);
  res.json(report);
});

module.exports = router;
