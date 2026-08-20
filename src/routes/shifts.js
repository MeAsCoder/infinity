const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { writeAudit } = require('../ledger');

router.use(authMiddleware);

function canSeeShift(req, shift) {
  return shift.user_id === req.user.id || req.user.permissions.includes('shifts.view_all') || req.user.permissions.includes('*');
}

// POST /api/shifts/start
router.post('/start', requirePermission('shifts.own.start'), (req, res) => {
  const { openingFloat, deviceId, clientUuid } = req.body;
  if (clientUuid) {
    const existing = db.prepare('SELECT * FROM shifts WHERE client_uuid = ?').get(clientUuid);
    if (existing) return res.status(200).json({ ...existing, idempotent: true });
  }
  const open = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'OPEN'").get(req.user.id);
  if (open) return res.status(409).json({ error: 'You already have an open shift', shift: open });

  const info = db.prepare(`
    INSERT INTO shifts (client_uuid, user_id, device_id, opening_float, status) VALUES (?, ?, ?, ?, 'OPEN')
  `).run(clientUuid || null, req.user.id, deviceId || null, openingFloat || 0);

  writeAudit({ event: 'SHIFT_OPENED', userId: req.user.id, role: req.user.role, entityType: 'SHIFT', entityId: info.lastInsertRowid, newValue: { openingFloat }, deviceId });

  res.status(201).json(db.prepare('SELECT * FROM shifts WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/current', (req, res) => {
  try {
    const shift = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'OPEN'").get(req.user.id);
    res.json(shift || null);
  } catch (error) {
    console.error('Error fetching current shift:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/mine/reconciliations', (req, res) => {
  const { from, to, limit } = req.query;
  let sql = `
    SELECT sh.id, sh.started_at, sh.ended_at, sh.opening_float,
           sr.cash_sales, sr.mobile_sales, sr.card_sales, sr.credit_sales, sr.other_sales,
           sr.cash_expenses, sr.expected_cash, sr.actual_cash, sr.actual_mobile, sr.actual_card,
           sr.variance, sr.notes AS reconciliation_notes, sr.submitted_at
    FROM shifts sh
    JOIN shift_reconciliations sr ON sr.shift_id = sh.id
    WHERE sh.user_id = ? AND sh.status = 'CLOSED'`;
  const params = [req.user.id];
  if (from) { sql += ' AND sr.submitted_at >= ?'; params.push(from); }
  if (to) { sql += ' AND sr.submitted_at <= ?'; params.push(to); }
  sql += ' ORDER BY sr.submitted_at DESC LIMIT ?'; params.push(+(limit || 200));
  res.json(db.prepare(sql).all(...params));
});

// GET /api/shifts/patterns/flagged - admin dashboard: waiters with recent flagged
// cash-variance patterns (surplus and shortage patterns carry equal weight; see
// checkWaiterPatterns below). Must be declared before the generic /:id route or
// Express will try to treat "patterns" as a shift id.
router.get('/patterns/flagged', requirePermission('shifts.view_all'), (req, res) => {
  try {
    const { limit } = req.query;
    const rows = db.prepare(`
      SELECT wp.id, wp.waiter_id, u.name AS waiter_name, wp.pattern_type, wp.score, wp.details
      FROM waiver_patterns wp
      JOIN users u ON u.id = wp.waiter_id
      ORDER BY wp.id DESC
      LIMIT ?
    `).all(+(limit || 100));

    const byWaiter = {};
    rows.forEach(r => {
      if (!byWaiter[r.waiter_id]) {
        byWaiter[r.waiter_id] = { waiterId: r.waiter_id, waiterName: r.waiter_name, totalScore: 0, patterns: [] };
      }
      byWaiter[r.waiter_id].totalScore += r.score;
      byWaiter[r.waiter_id].patterns.push({ type: r.pattern_type, score: r.score, detail: r.details });
    });

    res.json(Object.values(byWaiter).sort((a, b) => b.totalScore - a.totalScore));
  } catch (error) {
    console.error('Error fetching flagged patterns:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
  if (!shift) return res.status(404).json({ error: 'Not found' });
  if (!canSeeShift(req, shift)) return res.status(403).json({ error: 'Forbidden' });
  const reconciliation = db.prepare('SELECT * FROM shift_reconciliations WHERE shift_id = ?').get(shift.id);
  res.json({ ...shift, reconciliation: reconciliation || null });
});

router.get('/', requirePermission('shifts.view_all'), (req, res) => {
  const { status, userId, limit } = req.query;
  let sql = 'SELECT * FROM shifts WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  sql += ' ORDER BY id DESC LIMIT ?'; params.push(+(limit || 100));
  res.json(db.prepare(sql).all(...params));
});

function computeShiftTotals(shiftId) {
  const rows = db.prepare(`
    SELECT p.method, SUM(p.amount) AS total
    FROM payments p JOIN sales s ON s.id = p.sale_id
    WHERE s.shift_id = ? AND s.status != 'VOIDED'
    GROUP BY p.method
  `).all(shiftId);
  const totals = { CASH: 0, MOBILE: 0, CARD: 0, CREDIT: 0, OTHER: 0 };
  rows.forEach(r => { totals[r.method] = r.total; });

  const expenseRow = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE shift_id = ? AND payment_method = 'CASH'
  `).get(shiftId);

  const txCountRow = db.prepare("SELECT COUNT(*) AS c FROM sales WHERE shift_id = ? AND status != 'VOIDED'").get(shiftId);

  return {
    cashSales: totals.CASH, mobileSales: totals.MOBILE, cardSales: totals.CARD,
    creditSales: totals.CREDIT, otherSales: totals.OTHER,
    cashExpenses: expenseRow.total, transactionCount: txCountRow.c,
  };
}

// Configurable threshold above which a shift-close variance requires a written
// note. Falls back to KES 500 if the setting hasn't been configured yet.
function getVarianceThreshold() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('variance_note_threshold');
  return row ? +row.value : 500;
}

function checkWaiterPatterns(waiterId) {
  const history = db.prepare(`
    SELECT variance FROM shift_reconciliations sr
    JOIN shifts sh ON sh.id = sr.shift_id
    WHERE sh.user_id = ?
    ORDER BY sh.ended_at DESC
    LIMIT 10
  `).all(waiterId);

  let surplusCount = 0, shortageCount = 0;
  let totalVariance = 0;

  history.forEach(h => {
    if (h.variance > 0) surplusCount++;
    if (h.variance < 0) shortageCount++;
    totalVariance += h.variance;
  });

  const patterns = [];

  // A pattern of surpluses is flagged with the SAME weight as a pattern of
  // shortages. Consistent "extra" cash can indicate skimming during the shift
  // that gets papered over at close, so it's not treated as good news.
  if (surplusCount > 3 && surplusCount > shortageCount) {
    patterns.push({ type: 'CONSISTENT_SURPLUS', score: 20, detail: `${surplusCount} surpluses vs ${shortageCount} shortages` });
  }
  if (shortageCount > 3 && shortageCount > surplusCount) {
    patterns.push({ type: 'CONSISTENT_SHORTAGE', score: 20, detail: `${shortageCount} shortages vs ${surplusCount} surpluses` });
  }
  if (Math.abs(totalVariance) > 5000) {
    patterns.push({ type: 'HIGH_CUMULATIVE_VARIANCE', score: 15, detail: `Cumulative variance: ${totalVariance}` });
  }
  if (history.some(h => Math.abs(h.variance) > 1000)) {
    patterns.push({ type: 'LARGE_SINGLE_VARIANCE', score: 10, detail: 'Variance exceeding KES 1000 detected' });
  }

  return patterns;
}

// POST /api/shifts/:id/end
router.post('/:id/end', requirePermission('shifts.own.end'), (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Not found' });
    if (shift.user_id !== req.user.id && !req.user.permissions.includes('*')) return res.status(403).json({ error: 'Forbidden' });
    if (shift.status !== 'OPEN') return res.status(409).json({ error: 'Shift already closed' });

    const openTabs = db.prepare("SELECT id, tab_label, total, receipt_number FROM sales WHERE shift_id = ? AND status = 'OPEN'").all(shift.id);
    if (openTabs.length > 0) {
      return res.status(409).json({
        error: `You still have ${openTabs.length} open tab(s). Settle them or transfer them to another shift before closing.`,
        openTabs,
      });
    }

    const { actualCash, actualMobile, actualCard, notes } = req.body;
    if (actualCash == null) return res.status(400).json({ error: 'actualCash (physical cash count) is required' });

    const totals = computeShiftTotals(shift.id);
    const expectedCash = shift.opening_float + totals.cashSales - totals.cashExpenses;
    const variance = actualCash - expectedCash;

    const patterns = checkWaiterPatterns(req.user.id);
    const hasSuspiciousPattern = patterns.length > 0;
    const isLargeVariance = Math.abs(variance) > getVarianceThreshold();

    if ((isLargeVariance || hasSuspiciousPattern) && !notes) {
      return res.status(400).json({ 
        error: 'Please explain the variance (required for amounts > KES 500 or suspicious patterns)'
      });
    }

    const tx = db.transaction(() => {
      db.prepare("UPDATE shifts SET status = 'CLOSED', ended_at = datetime('now'), closed_by = ? WHERE id = ?").run(req.user.id, shift.id);
      
      const varianceNotes = notes || 
        (isLargeVariance ? `Variance of ${variance} recorded` : 'No notes provided') +
        (hasSuspiciousPattern ? ` | Patterns detected: ${patterns.map(p => p.type).join(', ')}` : '');
      
      db.prepare(`
        INSERT INTO shift_reconciliations
          (shift_id, cash_sales, mobile_sales, card_sales, credit_sales, other_sales, cash_expenses,
           expected_cash, actual_cash, actual_mobile, actual_card, variance, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        shift.id, totals.cashSales, totals.mobileSales, totals.cardSales, totals.creditSales, totals.otherSales,
        totals.cashExpenses, expectedCash, actualCash, actualMobile || 0, actualCard || 0, variance, varianceNotes
      );
      
      patterns.forEach(pattern => {
        db.prepare(`
          INSERT INTO waiver_patterns (waiter_id, pattern_type, score, details)
          VALUES (?, ?, ?, ?)
        `).run(req.user.id, pattern.type, pattern.score, pattern.detail);
      });

      writeAudit({
        event: 'SHIFT_CLOSED',
        userId: req.user.id,
        role: req.user.role,
        entityType: 'SHIFT',
        entityId: shift.id,
        newValue: { expectedCash, actualCash, variance, ...totals, patterns },
        reason: variance < 0 ? `Shortage of ${-variance}` : variance > 0 ? `Surplus of ${variance}` : 'Balanced',
      });
    });
    tx();

    res.json({
      shiftId: shift.id, status: 'CLOSED', expectedCash, actualCash, variance,
      varianceType: variance < 0 ? 'SHORTAGE' : variance > 0 ? 'SURPLUS' : 'BALANCED',
      patterns: patterns,
      ...totals,
    });
  } catch (error) {
    console.error('Error closing shift:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/shifts/:id/recount
router.post('/:id/recount', requirePermission('shifts.correct'), (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    
    const { actualCash, notes } = req.body;
    if (actualCash == null) return res.status(400).json({ error: 'actualCash is required' });
    
    const original = db.prepare('SELECT actual_cash FROM shift_reconciliations WHERE shift_id = ?').get(shift.id);
    
    db.prepare(`
      INSERT INTO shift_recounts (shift_id, actual_cash, notes, counted_by)
      VALUES (?, ?, ?, ?)
    `).run(shift.id, actualCash, notes || null, req.user.id);
    
    const discrepancy = original ? actualCash - original.actual_cash : null;
    
    writeAudit({
      event: 'SHIFT_RECOUNT',
      userId: req.user.id,
      role: req.user.role,
      entityType: 'SHIFT',
      entityId: shift.id,
      newValue: { actualCash, originalCash: original?.actual_cash, discrepancy },
    });
    
    res.json({
      original: original?.actual_cash || null,
      recount: actualCash,
      discrepancy: discrepancy,
      matched: discrepancy === 0
    });
  } catch (error) {
    console.error('Error recounting shift:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/shifts/:id/report
router.get('/:id/report', (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Not found' });
    if (!canSeeShift(req, shift)) return res.status(403).json({ error: 'Forbidden' });

    const reconciliation = db.prepare('SELECT * FROM shift_reconciliations WHERE shift_id = ?').get(shift.id);
    const sales = db.prepare("SELECT * FROM sales WHERE shift_id = ? AND status != 'VOIDED'").all(shift.id);
    const saleIds = sales.map(s => s.id);

    let revenue = 0, cogs = 0, discounts = 0;
    const itemAgg = {};
    if (saleIds.length) {
      const placeholders = saleIds.map(() => '?').join(',');
      const items = db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${placeholders})`).all(...saleIds);
      for (const it of items) {
        revenue += it.line_total; cogs += it.line_cost;
        itemAgg[it.unit_name + ':' + it.product_id] = itemAgg[it.unit_name + ':' + it.product_id] || { name: it.unit_name, productId: it.product_id, qty: 0, volumeMl: 0 };
        itemAgg[it.unit_name + ':' + it.product_id].qty += it.quantity;
        itemAgg[it.unit_name + ':' + it.product_id].volumeMl += it.volume_ml * it.quantity;
      }
      discounts = sales.reduce((s, sale) => s + sale.discount_total, 0);
    }

    const user = db.prepare('SELECT id, name, username FROM users WHERE id = ?').get(shift.user_id);
    const grossProfit = revenue - cogs;

    const debts = db.prepare(`
      SELECT cl.id, cl.amount, cl.notes, cl.created_at, c.name AS customer_name
      FROM credit_ledger cl
      JOIN sales s ON s.id = cl.ref_id AND cl.ref_type = 'SALE'
      JOIN customers c ON c.id = cl.customer_id
      WHERE cl.type = 'SALE' AND s.shift_id = ?
      ORDER BY cl.id DESC
    `).all(shift.id);
    const totalDebts = debts.reduce((sum, d) => sum + d.amount, 0);

    const recounts = db.prepare('SELECT * FROM shift_recounts WHERE shift_id = ? ORDER BY created_at DESC').all(shift.id);

    // Recent flagged cash-variance patterns for this waiter, so admins reviewing
    // a single shift's report can see it in context of their broader history.
    const flags = db.prepare(`
      SELECT pattern_type, score, details FROM waiver_patterns
      WHERE waiter_id = ? ORDER BY id DESC LIMIT 20
    `).all(shift.user_id);

    res.json({
      shift, user, reconciliation,
      sales: { count: sales.length, revenue, discounts },
      profitability: { revenue, cogs, grossProfit, grossMarginPct: revenue > 0 ? (grossProfit / revenue) * 100 : 0 },
      consumption: Object.values(itemAgg),
      debts: { count: debts.length, total: totalDebts, items: debts },
      recounts: recounts,
      flags: flags,
      audit: {
        startedAt: shift.started_at, endedAt: shift.ended_at, closedBy: shift.closed_by,
      },
    });
  } catch (error) {
    console.error('Error getting shift report:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin-only shift correction
router.post('/:id/correction', requirePermission('shifts.correct'), (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Not found' });
    const { reason, notes } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });
    writeAudit({
      event: 'SHIFT_CORRECTION', userId: req.user.id, role: req.user.role, entityType: 'SHIFT', entityId: shift.id,
      oldValue: { status: shift.status }, newValue: { notes }, reason,
    });
    res.json({ ok: true, message: 'Correction note recorded against this shift. Original figures are unchanged.' });
  } catch (error) {
    console.error('Error recording shift correction:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;