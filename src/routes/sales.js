const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { getProductStock, appendInventoryLedger, getCustomerBalance, appendCreditLedger, writeAudit, nextReceiptNumber } = require('../ledger');

router.use(authMiddleware);

function serializeSale(saleId) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return null;
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
  const payments = db.prepare('SELECT * FROM payments WHERE sale_id = ?').all(saleId);
  const balanceDue = sale.total - sale.amount_paid - payments.filter(p => p.method === 'CREDIT').reduce((s, p) => s + p.amount, 0);
  return { ...sale, items, payments, balanceDue };
}

function canActOnShift(req, shift) {
  return shift.user_id === req.user.id || req.user.permissions.includes('sales.view_all') || req.user.permissions.includes('*');
}

function resolveLineItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('items required');
  let subtotal = 0;
  const lineData = [];
  for (const item of items) {
    const su = db.prepare('SELECT * FROM selling_units WHERE id = ? AND product_id = ? AND active = 1').get(item.sellingUnitId, item.productId);
    if (!su) throw new Error(`Invalid selling unit ${item.sellingUnitId} for product ${item.productId}`);
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
    if (!product || !product.active) throw new Error(`Product ${item.productId} not available`);
    const priceRow = db.prepare('SELECT * FROM product_prices WHERE selling_unit_id = ? AND active = 1').get(su.id);
    if (!priceRow) throw new Error(`No active price for selling unit ${su.id}`);

    const qty = item.quantity;
    if (!qty || qty <= 0) throw new Error('Quantity must be positive');
    const volumeNeeded = su.volume_ml * qty;

    if (product.track_inventory) {
      const stock = getProductStock(product.id);
      if (stock.balanceMl < volumeNeeded) {
        throw new Error(`Insufficient stock for ${product.name}: have ${stock.balanceMl}ml, need ${volumeNeeded}ml`);
      }
    }

    const unitPrice = item.overridePrice != null ? item.overridePrice : priceRow.selling_price;
    const stockNow = getProductStock(product.id);
    const unitCost = Math.round(su.volume_ml * (stockNow.avgCostPerMl || (priceRow.cost_price / su.volume_ml)));
    const lineTotal = unitPrice * qty;
    const lineCost = unitCost * qty;
    subtotal += lineTotal;

    lineData.push({ product, su, qty, volumeNeeded, unitPrice, unitCost, lineTotal, lineCost });
  }
  return { subtotal, lineData };
}

function writeLineItems(saleId, lineData, { userId, deviceId }) {
  for (const line of lineData) {
    db.prepare(`
      INSERT INTO sale_items (sale_id, product_id, selling_unit_id, unit_name, volume_ml, quantity, unit_price, unit_cost, line_total, line_cost)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(saleId, line.product.id, line.su.id, line.su.name, line.su.volume_ml, line.qty, line.unitPrice, line.unitCost, line.lineTotal, line.lineCost);

    if (line.product.track_inventory) {
      appendInventoryLedger({
        productId: line.product.id, changeMl: -line.volumeNeeded, reason: 'SALE',
        refType: 'SALE', refId: saleId, userId, deviceId, notes: `${line.qty} x ${line.su.name}`,
      });
    }
  }
}

function checkDiscountAuthorized(req, userRow, subtotal, discountTotal) {
  if (discountTotal <= 0) return;
  const maxPct = req.user.permissions.includes('discounts.apply_unlimited') || req.user.permissions.includes('*')
    ? 100 : (userRow ? userRow.max_discount_percent : 0);
  const appliedPct = subtotal > 0 ? (discountTotal / subtotal) * 100 : 0;
  if (appliedPct > maxPct + 0.01) throw new Error(`Discount ${appliedPct.toFixed(1)}% exceeds your authorized limit of ${maxPct}%`);
}

function checkCreditAuthorized(req, customerId, creditAmount) {
  if (!customerId) throw new Error('customerId required for a credit payment');
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer || !customer.active) throw new Error('Invalid customer for credit sale');
  const limit = customer.credit_limit || +(db.prepare('SELECT value FROM settings WHERE key = ?').get('default_credit_limit')?.value || 0);
  const currentBalance = getCustomerBalance(customer.id);
  if (currentBalance + creditAmount > limit && !(req.user.permissions.includes('credit.manage') || req.user.permissions.includes('*'))) {
    throw new Error(`Credit would exceed customer's limit (balance ${currentBalance} + ${creditAmount} > limit ${limit}). Needs admin approval.`);
  }
}

// POST /api/sales - Instant sale
router.post('/', requirePermission('sales.create'), (req, res) => {
  const b = req.body;
  if (!b.uuid) return res.status(400).json({ error: 'uuid required for idempotent sync' });
  if (!Array.isArray(b.payments) || b.payments.length === 0) return res.status(400).json({ error: 'payments required' });

  const already = db.prepare('SELECT id FROM sales WHERE uuid = ?').get(b.uuid);
  if (already) return res.status(200).json({ ...serializeSale(already.id), idempotent: true });

  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(b.shiftId);
  if (!shift) return res.status(400).json({ error: 'Invalid shiftId' });
  if (shift.status !== 'OPEN') return res.status(409).json({ error: 'Shift is not open' });
  if (!canActOnShift(req, shift)) return res.status(403).json({ error: 'Cannot sell against another user\'s shift' });

  const userRow = db.prepare('SELECT max_discount_percent FROM users WHERE id = ?').get(req.user.id);
  const discountTotal = b.discountTotal || 0;

  const result = {};
  const tx = db.transaction(() => {
    const { subtotal, lineData } = resolveLineItems(b.items);
    checkDiscountAuthorized(req, userRow, subtotal, discountTotal);

    const total = subtotal - discountTotal;
    const paymentsTotal = b.payments.reduce((s, p) => s + p.amount, 0);
    if (paymentsTotal !== total) throw new Error(`Payments (${paymentsTotal}) do not match total (${total})`);

    const creditPayment = b.payments.find(p => p.method === 'CREDIT');
    if (creditPayment && creditPayment.amount > 0) checkCreditAuthorized(req, b.customerId, creditPayment.amount);

    const receiptNumber = nextReceiptNumber();
    const saleInfo = db.prepare(`
      INSERT INTO sales (uuid, shift_id, user_id, device_id, customer_id, tab_label, subtotal, discount_total, discount_reason, discount_by, total, amount_paid, status, receipt_number, client_created_at, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      b.uuid, shift.id, req.user.id, b.deviceId || null, b.customerId || null, b.tabLabel || null,
      subtotal, discountTotal, b.discountReason || null, discountTotal > 0 ? req.user.id : null,
      total, paymentsTotal - (creditPayment ? creditPayment.amount : 0), 'COMPLETED', receiptNumber, b.clientCreatedAt || null
    );
    const saleId = saleInfo.lastInsertRowid;

    writeLineItems(saleId, lineData, { userId: req.user.id, deviceId: b.deviceId });
    for (const p of b.payments) {
      db.prepare('INSERT INTO payments (sale_id, method, amount, reference) VALUES (?, ?, ?, ?)').run(saleId, p.method, p.amount, p.reference || null);
    }
    if (creditPayment && creditPayment.amount > 0) {
      appendCreditLedger({ customerId: b.customerId, type: 'SALE', amount: creditPayment.amount, refType: 'SALE', refId: saleId, userId: req.user.id, notes: `Credit sale ${receiptNumber}` });
    }

    writeAudit({
      event: 'SALE_CREATED', userId: req.user.id, role: req.user.role, entityType: 'SALE', entityId: saleId,
      newValue: { receiptNumber, total, items: lineData.length, payments: b.payments }, deviceId: b.deviceId, origin: b.clientCreatedAt ? 'CLIENT' : 'SERVER',
    });
    result.saleId = saleId;
  });

  try { tx(); } catch (e) { return res.status(422).json({ error: e.message }); }
  res.status(201).json(serializeSale(result.saleId));
});

// POST /api/sales/tabs - Open a running tab
router.post('/tabs', requirePermission('sales.create'), (req, res) => {
  const b = req.body;
  if (!b.uuid) return res.status(400).json({ error: 'uuid required for idempotent sync' });

  const already = db.prepare('SELECT id FROM sales WHERE uuid = ?').get(b.uuid);
  if (already) return res.status(200).json({ ...serializeSale(already.id), idempotent: true });

  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(b.shiftId);
  if (!shift) return res.status(400).json({ error: 'Invalid shiftId' });
  if (shift.status !== 'OPEN') return res.status(409).json({ error: 'Shift is not open' });
  if (!canActOnShift(req, shift)) return res.status(403).json({ error: 'Cannot open a tab against another user\'s shift' });

  const items = Array.isArray(b.items) ? b.items : [];
  const result = {};
  const tx = db.transaction(() => {
    const { subtotal, lineData } = items.length ? resolveLineItems(items) : { subtotal: 0, lineData: [] };
    const receiptNumber = nextReceiptNumber();
    const saleInfo = db.prepare(`
      INSERT INTO sales (uuid, shift_id, user_id, device_id, tab_label, subtotal, total, amount_paid, status, receipt_number, client_created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.uuid, shift.id, req.user.id, b.deviceId || null, b.tabLabel || null, 
      subtotal, subtotal, 0, 'OPEN', receiptNumber, b.clientCreatedAt || null
    );
    const saleId = saleInfo.lastInsertRowid;
    writeLineItems(saleId, lineData, { userId: req.user.id, deviceId: b.deviceId });

    writeAudit({ event: 'TAB_OPENED', userId: req.user.id, role: req.user.role, entityType: 'SALE', entityId: saleId, newValue: { tabLabel: b.tabLabel, items: lineData.length }, deviceId: b.deviceId, origin: b.clientCreatedAt ? 'CLIENT' : 'SERVER' });
    result.saleId = saleId;
  });

  try { tx(); } catch (e) { return res.status(422).json({ error: e.message }); }
  res.status(201).json(serializeSale(result.saleId));
});

// GET /api/sales/open - Lists running tabs
router.get('/open', (req, res) => {
  let shiftId = req.query.shiftId;
  if (!shiftId) {
    const own = db.prepare('SELECT id FROM shifts WHERE user_id = ? AND status = ?').get(req.user.id, 'OPEN');
    shiftId = own ? own.id : null;
  } else {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
    if (!shift || !canActOnShift(req, shift)) return res.status(403).json({ error: 'Forbidden' });
  }
  if (!shiftId) return res.json([]);
  const rows = db.prepare('SELECT * FROM sales WHERE shift_id = ? AND status = ? ORDER BY id DESC').all(shiftId, 'OPEN');
  res.json(rows.map(s => serializeSale(s.id)));
});

// POST /api/sales/:id/items - Add items to an open tab
router.post('/:id/items', requirePermission('sales.create'), (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Tab not found' });
  if (sale.status !== 'OPEN') return res.status(409).json({ error: 'This tab is not open (already settled/voided)' });
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(sale.shift_id);
  if (!canActOnShift(req, shift)) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body;
  if (b.uuid) {
    const already = db.prepare('SELECT id FROM audit_logs WHERE event = ? AND reason = ?').get('TAB_ITEMS_ADDED', b.uuid);
    if (already) return res.status(200).json({ ...serializeSale(sale.id), idempotent: true });
  }

  const result = {};
  const tx = db.transaction(() => {
    const { subtotal: addedSubtotal, lineData } = resolveLineItems(b.items);
    writeLineItems(sale.id, lineData, { userId: req.user.id, deviceId: b.deviceId });
    const newSubtotal = sale.subtotal + addedSubtotal;
    const newTotal = newSubtotal - sale.discount_total;
    db.prepare('UPDATE sales SET subtotal = ?, total = ? WHERE id = ?').run(newSubtotal, newTotal, sale.id);
    writeAudit({ event: 'TAB_ITEMS_ADDED', userId: req.user.id, role: req.user.role, entityType: 'SALE', entityId: sale.id, newValue: { addedSubtotal, items: lineData.length }, deviceId: b.deviceId, reason: b.uuid || null });
    result.ok = true;
  });

  try { tx(); } catch (e) { return res.status(422).json({ error: e.message }); }
  res.status(201).json(serializeSale(sale.id));
});

// POST /api/sales/:id/debt - Walk-out debt recording
router.post('/:id/debt', requirePermission('sales.create'), (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Tab not found' });
  if (sale.status !== 'OPEN') return res.status(409).json({ error: 'Tab is already closed or settled' });
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(sale.shift_id);
  if (!canActOnShift(req, shift)) return res.status(403).json({ error: 'Forbidden' });

  const { customerName, customerPhone, notes } = req.body;
  if (!customerName || !customerName.trim()) return res.status(400).json({ error: 'customerName is required' });

  const result = {};
  const tx = db.transaction(() => {
    let customer = customerPhone
      ? db.prepare('SELECT * FROM customers WHERE phone = ? AND active = ?').get(customerPhone.trim(), 1)
      : null;
    if (!customer) customer = db.prepare('SELECT * FROM customers WHERE name = ? AND active = ?').get(customerName.trim(), 1);
    if (!customer) {
      const info = db.prepare('INSERT INTO customers (name, phone, active) VALUES (?, ?, ?)')
        .run(customerName.trim(), customerPhone ? customerPhone.trim() : null, 1);
      customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    }

    const limit = customer.credit_limit || +(db.prepare('SELECT value FROM settings WHERE key = ?').get('default_credit_limit')?.value || 0);
    const currentBalance = getCustomerBalance(customer.id);
    const overLimit = (currentBalance + sale.total) > limit;

    db.prepare("UPDATE sales SET status = ?, amount_paid = ?, customer_id = ?, settled_at = datetime('now') WHERE id = ?")
      .run('COMPLETED', 0, customer.id, sale.id);
    db.prepare('INSERT INTO payments (sale_id, method, amount, reference) VALUES (?, ?, ?, ?)')
      .run(sale.id, 'CREDIT', sale.total, 'Customer left without paying');
    appendCreditLedger({
      customerId: customer.id, type: 'SALE', amount: sale.total, refType: 'SALE', refId: sale.id,
      userId: req.user.id, notes: notes || `Walk-out debt${customerPhone ? ` (${customerPhone})` : ''}`,
    });

    writeAudit({
      event: 'WALKOUT_DEBT_RECORDED', userId: req.user.id, role: req.user.role, entityType: 'SALE', entityId: sale.id,
      newValue: { customerId: customer.id, customerName, amount: sale.total, overLimit, notes: notes || null },
      reason: overLimit ? 'Recorded over the customer\'s credit limit' : null,
    });
    result.customerId = customer.id;
    result.overLimit = overLimit;
  });

  try { tx(); } catch (e) { return res.status(422).json({ error: e.message }); }
  res.status(200).json({ ...serializeSale(sale.id), overLimit: result.overLimit });
});

// POST /api/sales/:id/settle - Full or partial settlement
router.post('/:id/settle', requirePermission('sales.create'), (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Tab not found' });
  if (sale.status !== 'OPEN') {
    if (sale.status === 'COMPLETED') return res.status(200).json({ ...serializeSale(sale.id), idempotent: true });
    return res.status(409).json({ error: `Tab cannot be settled (status: ${sale.status})` });
  }
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(sale.shift_id);
  if (!canActOnShift(req, shift)) return res.status(403).json({ error: 'Forbidden' });

  const b = req.body;
  if (!Array.isArray(b.payments) || b.payments.length === 0) return res.status(400).json({ error: 'payments required' });

  const userRow = db.prepare('SELECT max_discount_percent FROM users WHERE id = ?').get(req.user.id);
  const discountTotal = b.discountTotal || 0;

  const result = {};
  const tx = db.transaction(() => {
    checkDiscountAuthorized(req, userRow, sale.subtotal, discountTotal);
    const total = sale.subtotal - discountTotal;

    const explicitPaymentsTotal = b.payments.reduce((s, p) => s + p.amount, 0);
    const shortfall = total - explicitPaymentsTotal;
    let payments = [...b.payments];

    if (shortfall > 0) {
      if (!b.customerId) throw new Error(`Payments (${explicitPaymentsTotal}) are short of the total (${total}) by ${shortfall}. Select a customer to put the remainder on credit.`);
      checkCreditAuthorized(req, b.customerId, shortfall);
      payments.push({ method: 'CREDIT', amount: shortfall, reference: 'Auto: balance remaining after partial settlement' });
    } else if (shortfall < 0) {
      throw new Error(`Payments (${explicitPaymentsTotal}) exceed the total (${total})`);
    }

    if (discountTotal > 0) {
      db.prepare('UPDATE sales SET discount_total = ?, discount_reason = ?, discount_by = ?, total = ? WHERE id = ?')
        .run(discountTotal, b.discountReason || null, req.user.id, total, sale.id);
    }

    const nonCreditPaid = payments.filter(p => p.method !== 'CREDIT').reduce((s, p) => s + p.amount, 0);
    db.prepare("UPDATE sales SET status = ?, amount_paid = ?, total = ?, customer_id = COALESCE(customer_id, ?), settled_at = datetime('now') WHERE id = ?")
      .run('COMPLETED', nonCreditPaid, total, b.customerId || null, sale.id);

    for (const p of payments) {
      db.prepare('INSERT INTO payments (sale_id, method, amount, reference) VALUES (?, ?, ?, ?)').run(sale.id, p.method, p.amount, p.reference || null);
    }
    const creditPortion = payments.find(p => p.method === 'CREDIT');
    if (creditPortion && creditPortion.amount > 0) {
      appendCreditLedger({ customerId: b.customerId, type: 'SALE', amount: creditPortion.amount, refType: 'SALE', refId: sale.id, userId: req.user.id, notes: `Tab settlement ${sale.receipt_number}${shortfall > 0 ? ' (partial payment, remainder on credit)' : ''}` });
    }

    writeAudit({
      event: 'TAB_SETTLED', userId: req.user.id, role: req.user.role, entityType: 'SALE', entityId: sale.id,
      newValue: { total, payments, partial: shortfall > 0, customerId: b.customerId || null },
    });
    result.ok = true;
  });

  try { tx(); } catch (e) { return res.status(422).json({ error: e.message }); }
  res.status(200).json(serializeSale(sale.id));
});

// POST /api/sales/:id/void
router.post('/:id/void', requirePermission('sales.refund'), (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  if (sale.status !== 'OPEN') return res.status(409).json({ error: 'Only an OPEN tab can be voided; use /refund for a completed sale' });
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: 'reason required' });

  const tx = db.transaction(() => {
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
    for (const it of items) {
      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(it.product_id);
      if (product.track_inventory) {
        appendInventoryLedger({ productId: product.id, changeMl: it.volume_ml * it.quantity, reason: 'REFUND', refType: 'SALE_VOID', refId: sale.id, userId: req.user.id, notes: `Void of tab ${sale.receipt_number}: ${reason}` });
      }
    }
    db.prepare('UPDATE sales SET status = ? WHERE id = ?').run('VOIDED', sale.id);
    writeAudit({ event: 'TAB_VOIDED', userId: req.user.id, role: req.user.role, entityType: 'SALE', entityId: sale.id, reason });
  });
  tx();
  res.json({ ok: true });
});

// POST /api/sales/:id/transfer
router.post('/:id/transfer', requirePermission('shifts.correct'), (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  if (sale.status !== 'OPEN') return res.status(409).json({ error: 'Only an open tab can be transferred' });
  const { toShiftId } = req.body;
  const toShift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(toShiftId);
  if (!toShift || toShift.status !== 'OPEN') return res.status(400).json({ error: 'Target shift must be open' });

  db.prepare('UPDATE sales SET shift_id = ? WHERE id = ?').run(toShiftId, sale.id);
  writeAudit({
    event: 'TAB_TRANSFERRED', userId: req.user.id, role: req.user.role, entityType: 'SALE', entityId: sale.id,
    oldValue: { shiftId: sale.shift_id }, newValue: { shiftId: toShiftId },
  });
  res.json({ ok: true });
});

// GET /api/sales - Admin only
router.get('/', requirePermission('sales.view_all'), (req, res) => {
  const { shiftId, from, to, customerId, status, limit } = req.query;
  let sql = 'SELECT * FROM sales WHERE 1=1';
  const params = [];
  if (shiftId) { sql += ' AND shift_id = ?'; params.push(shiftId); }
  if (customerId) { sql += ' AND customer_id = ?'; params.push(customerId); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (from) { sql += ' AND server_created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND server_created_at <= ?'; params.push(to); }
  sql += ' ORDER BY id DESC LIMIT ?'; params.push(+(limit || 200));
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// GET /api/sales/my-shift/:shiftId
router.get('/my-shift/:shiftId', (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.shiftId);
  if (!shift) return res.status(404).json({ error: 'Not found' });
  if (!canActOnShift(req, shift)) return res.status(403).json({ error: 'Forbidden' });
  const sales = db.prepare('SELECT * FROM sales WHERE shift_id = ? ORDER BY id DESC').all(req.params.shiftId);
  res.json(sales.map(s => serializeSale(s.id)));
});

// GET /api/sales/waiter/history
router.get('/waiter/history', (req, res) => {
  const { from, to, limit } = req.query;
  const shifts = db.prepare('SELECT id FROM shifts WHERE user_id = ?').all(req.user.id);
  if (shifts.length === 0) return res.json([]);
  const shiftIds = shifts.map(s => s.id).join(',');
  let sql = `SELECT * FROM sales WHERE shift_id IN (${shiftIds})`;
  const params = [];
  if (from) { sql += ' AND server_created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND server_created_at <= ?'; params.push(to); }
  sql += ' ORDER BY server_created_at DESC';
  if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit, 10)); }
  res.json(db.prepare(sql).all(...params).map(s => serializeSale(s.id)));
});

// GET /api/sales/waiter/:waiterId/debts
router.get('/waiter/:waiterId/debts', (req, res) => {
  const waiterId = parseInt(req.params.waiterId, 10);
  if (req.user.id !== waiterId && !req.user.permissions.includes('sales.view_all') && !req.user.permissions.includes('*')) {
    return res.status(403).json({ error: 'Forbidden: you can only view your own debts' });
  }
  const { from, to } = req.query;
  let sql = `
    SELECT cl.id, cl.customer_id, c.name AS customer_name, c.phone AS customer_phone,
           cl.amount, cl.notes, cl.created_at, s.id AS sale_id, s.receipt_number, s.tab_label
    FROM credit_ledger cl
    JOIN sales s ON s.id = cl.ref_id AND cl.ref_type = ?
    JOIN customers c ON c.id = cl.customer_id
    WHERE cl.type = ? AND s.user_id = ?`;
  const params = ['SALE', 'SALE', waiterId];
  if (from) { sql += ' AND cl.created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND cl.created_at <= ?'; params.push(to); }
  sql += ' ORDER BY cl.id DESC LIMIT 300';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...r, customerCurrentBalance: getCustomerBalance(r.customer_id) })));
});

// GET /api/sales/waiter/:waiterId/debts/summary
router.get('/waiter/:waiterId/debts/summary', (req, res) => {
  const waiterId = parseInt(req.params.waiterId, 10);
  if (req.user.id !== waiterId && !req.user.permissions.includes('sales.view_all') && !req.user.permissions.includes('*')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const row = db.prepare(`
    SELECT COUNT(*) AS totalDebts, COALESCE(SUM(cl.amount),0) AS totalRecorded
    FROM credit_ledger cl JOIN sales s ON s.id = cl.ref_id AND cl.ref_type = ?
    WHERE cl.type = ? AND s.user_id = ?
  `).get('SALE', 'SALE', waiterId);
  res.json(row);
});

// GET /api/sales/debts - Admin view
router.get('/debts', requirePermission('sales.view_all'), (req, res) => {
  const { from, to, limit } = req.query;
  let sql = `
    SELECT cl.id, cl.customer_id, c.name AS customer_name, cl.amount, cl.notes, cl.created_at,
           s.id AS sale_id, s.receipt_number, s.tab_label, u.id AS waiter_id, u.name AS waiter_name
    FROM credit_ledger cl
    JOIN sales s ON s.id = cl.ref_id AND cl.ref_type = ?
    JOIN customers c ON c.id = cl.customer_id
    JOIN users u ON u.id = s.user_id
    WHERE cl.type = ?`;
  const params = ['SALE', 'SALE'];
  if (from) { sql += ' AND cl.created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND cl.created_at <= ?'; params.push(to); }
  sql += ' ORDER BY cl.id DESC LIMIT ?'; params.push(+(limit || 300));
  res.json(db.prepare(sql).all(...params));
});

// POST /api/sales/debts/:id/resolve - Admin marks a specific credit-ledger SALE
// entry as paid or written off. Resolves only THIS entry's own amount, not the
// customer's total outstanding balance, so resolving one debt among several
// doesn't over-correct the others.
router.post('/debts/:id/resolve', requirePermission('credit.manage'), (req, res) => {
  const ledgerEntry = db.prepare("SELECT * FROM credit_ledger WHERE id = ? AND type = 'SALE'").get(req.params.id);
  if (!ledgerEntry) return res.status(404).json({ error: 'Debt entry not found' });

  const { action, notes } = req.body;
  if (!['PAID', 'WRITE_OFF'].includes(action)) return res.status(400).json({ error: "action must be 'PAID' or 'WRITE_OFF'" });

  const result = {};
  const tx = db.transaction(() => {
    appendCreditLedger({
      customerId: ledgerEntry.customer_id,
      type: action === 'PAID' ? 'PAYMENT' : 'WRITE_OFF',
      amount: -ledgerEntry.amount,
      refType: 'SALE',
      refId: ledgerEntry.ref_id,
      userId: req.user.id,
      approvedBy: req.user.id,
      notes: notes || (action === 'PAID' ? `Marked paid by admin (offsets ledger #${ledgerEntry.id})` : `Written off by admin (offsets ledger #${ledgerEntry.id})`),
    });

    writeAudit({
      event: action === 'PAID' ? 'DEBT_MARKED_PAID' : 'DEBT_WRITTEN_OFF',
      userId: req.user.id, role: req.user.role, entityType: 'CREDIT_LEDGER', entityId: ledgerEntry.id,
      newValue: { customerId: ledgerEntry.customer_id, amount: ledgerEntry.amount, notes: notes || null },
    });
    result.customerId = ledgerEntry.customer_id;
  });

  try { tx(); } catch (e) { return res.status(422).json({ error: e.message }); }
  res.json({ ok: true, customerId: result.customerId, resolvedAmount: ledgerEntry.amount });
});

// GET /api/sales/:id
router.get('/:id', requirePermission('sales.view_all'), (req, res) => {
  const sale = serializeSale(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Not found' });
  res.json(sale);
});

// POST /api/sales/:id/refund
router.post('/:id/refund', requirePermission('sales.refund'), (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return res.status(404).json({ error: 'Sale not found' });
  const { items, reason } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'items required' });
  if (!reason) return res.status(400).json({ error: 'reason required' });

  const result = {};
  const tx = db.transaction(() => {
    const refundInfo = db.prepare(`
      INSERT INTO refunds (client_uuid, original_sale_id, reason, amount, requested_by, approved_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.body.clientUuid || null, 
      sale.id, 
      reason, 
      0, 
      req.user.id, 
      req.user.id,
      'APPROVED'
    );
    const refundId = refundInfo.lastInsertRowid;

    let totalRefund = 0;
    for (const it of items) {
      const saleItem = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(it.saleItemId, sale.id);
      if (!saleItem) throw new Error('Invalid sale item for this sale');
      const qty = it.quantity;
      if (qty <= 0 || qty > saleItem.quantity) throw new Error('Invalid refund quantity');
      const amount = Math.round((saleItem.line_total / saleItem.quantity) * qty);
      const volumeMl = saleItem.volume_ml * qty;
      totalRefund += amount;

      db.prepare('INSERT INTO refund_items (refund_id, sale_item_id, quantity, amount, volume_ml) VALUES (?, ?, ?, ?, ?)')
        .run(refundId, saleItem.id, qty, amount, volumeMl);

      const product = db.prepare('SELECT * FROM products WHERE id = ?').get(saleItem.product_id);
      if (product.track_inventory) {
        appendInventoryLedger({
          productId: product.id, changeMl: volumeMl, reason: 'REFUND', refType: 'REFUND', refId: refundId,
          userId: req.user.id, notes: `Refund of sale ${sale.receipt_number}`,
        });
      }
    }

    db.prepare('UPDATE refunds SET amount = ? WHERE id = ?').run(totalRefund, refundId);
    const newStatus = totalRefund >= sale.total ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    db.prepare('UPDATE sales SET status = ? WHERE id = ?').run(newStatus, sale.id);

    if (sale.customer_id) {
      const creditPayment = db.prepare('SELECT * FROM payments WHERE sale_id = ? AND method = ?').get(sale.id, 'CREDIT');
      if (creditPayment) {
        const creditShare = Math.round((totalRefund / sale.total) * creditPayment.amount);
        if (creditShare > 0) {
          appendCreditLedger({
            customerId: sale.customer_id, type: 'ADJUSTMENT', amount: -creditShare,
            refType: 'REFUND', refId: refundId, userId: req.user.id, approvedBy: req.user.id,
            notes: `Debt reduced due to refund of sale ${sale.receipt_number}`,
          });
        }
      }
    }

    writeAudit({
      event: 'SALE_REFUNDED', userId: req.user.id, role: req.user.role, entityType: 'SALE', entityId: sale.id,
      oldValue: { status: sale.status }, newValue: { status: newStatus, refundAmount: totalRefund }, reason,
    });

    result.refundId = refundId;
    result.amount = totalRefund;
  });

  try { tx(); } catch (e) { return res.status(422).json({ error: e.message }); }
  res.status(201).json(result);
});

module.exports = router;