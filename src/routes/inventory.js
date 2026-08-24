const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { getProductStock, appendInventoryLedger, formatStock, writeAudit } = require('../ledger');

router.use(authMiddleware);

// POST /api/inventory/receive
router.post('/receive', requirePermission('stock.receive'), (req, res) => {
  const { productId, supplierId, quantityUnits, totalCost, invoiceRef, batch, expiryDate, notes, clientUuid } = req.body;
  if (!productId || !quantityUnits || quantityUnits <= 0) return res.status(400).json({ error: 'productId and positive quantityUnits required' });

  if (clientUuid) {
    const existing = db.prepare('SELECT id FROM stock_receipts WHERE client_uuid = ?').get(clientUuid);
    if (existing) return res.status(200).json({ id: existing.id, idempotent: true });
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const quantityMl = quantityUnits * product.volume_ml;

  const result = {};
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO stock_receipts (client_uuid, product_id, supplier_id, quantity_units, quantity_ml, total_cost, invoice_ref, batch, expiry_date, received_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(clientUuid || null, productId, supplierId || null, quantityUnits, quantityMl, totalCost || 0, invoiceRef || null, batch || null, expiryDate || null, req.user.id, notes || null);
    result.id = info.lastInsertRowid;

    appendInventoryLedger({
      productId, changeMl: quantityMl, reason: 'RECEIPT', refType: 'STOCK_RECEIPT', refId: result.id,
      userId: req.user.id, notes: `Received ${quantityUnits} units`, incomingTotalCost: totalCost || 0,
    });

    writeAudit({ event: 'STOCK_RECEIVED', userId: req.user.id, role: req.user.role, entityType: 'PRODUCT', entityId: productId, newValue: { quantityUnits, quantityMl, totalCost } });
  });
  tx();

  res.status(201).json({ id: result.id, quantityMl, stock: getProductStock(productId) });
});

router.get('/receipts', requirePermission('stock.receive'), (req, res) => {
  res.json(db.prepare(`
    SELECT sr.*, p.name AS product_name, s.name AS supplier_name, u.name AS received_by_name
    FROM stock_receipts sr
    JOIN products p ON p.id = sr.product_id
    LEFT JOIN suppliers s ON s.id = sr.supplier_id
    LEFT JOIN users u ON u.id = sr.received_by
    ORDER BY sr.id DESC LIMIT 200
  `).all());
});

// POST /api/inventory/adjust — waiters CANNOT call this (no 'stock.adjust' permission granted to WAITER role)
router.post('/adjust', requirePermission('stock.adjust'), (req, res) => {
  const { productId, changeMl, reason, notes, clientUuid } = req.body;
  if (!productId || !changeMl || !reason || !notes) {
    return res.status(400).json({ error: 'productId, changeMl, reason, and notes are all required (no silent stock changes)' });
  }
  if (clientUuid) {
    const existing = db.prepare('SELECT id FROM stock_adjustments WHERE client_uuid = ?').get(clientUuid);
    if (existing) return res.status(200).json({ id: existing.id, idempotent: true });
  }

  const result = {};
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO stock_adjustments (client_uuid, product_id, change_ml, reason, notes, requested_by, approved_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'APPROVED')
    `).run(clientUuid || null, productId, changeMl, reason, notes, req.user.id, req.user.id);
    result.id = info.lastInsertRowid;

    appendInventoryLedger({
      productId, changeMl, reason: 'ADJUSTMENT', refType: 'STOCK_ADJUSTMENT', refId: result.id,
      userId: req.user.id, notes: `${reason}: ${notes}`,
    });

    writeAudit({ event: 'STOCK_ADJUSTED', userId: req.user.id, role: req.user.role, entityType: 'PRODUCT', entityId: productId, newValue: { changeMl, reason, notes } });
  });
  tx();

  res.status(201).json({ id: result.id, stock: getProductStock(productId) });
});

router.get('/ledger/:productId', (req, res) => {
  const rows = db.prepare(`
    SELECT il.*, u.name AS user_name FROM inventory_ledger il LEFT JOIN users u ON u.id = il.user_id
    WHERE product_id = ? ORDER BY il.id DESC LIMIT 200
  `).all(req.params.productId);
  res.json(rows);
});

// ---- Stocktaking ----
router.post('/stocktake', requirePermission('stocktake.manage'), (req, res) => {
  const info = db.prepare(`INSERT INTO stocktakes (started_by, status) VALUES (?, 'OPEN')`).run(req.user.id);
  writeAudit({ event: 'STOCKTAKE_STARTED', userId: req.user.id, role: req.user.role, entityType: 'STOCKTAKE', entityId: info.lastInsertRowid });
  res.status(201).json({ id: info.lastInsertRowid });
});

router.post('/stocktake/:id/count', requirePermission('stocktake.manage'), (req, res) => {
  const { productId, physicalStockUnits } = req.body;
  const stocktake = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(req.params.id);
  if (!stocktake || stocktake.status !== 'OPEN') return res.status(400).json({ error: 'Stocktake not open' });
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const stock = getProductStock(productId);
  const physicalMl = physicalStockUnits * product.volume_ml;
  const differenceMl = physicalMl - stock.balanceMl;
  const valueDifference = Math.round(differenceMl * (stock.avgCostPerMl || 0));

  const info = db.prepare(`
    INSERT INTO stocktake_items (stocktake_id, product_id, system_stock_ml, physical_stock_ml, difference_ml, value_difference)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(stocktake.id, productId, stock.balanceMl, physicalMl, differenceMl, valueDifference);

  res.status(201).json({
    id: info.lastInsertRowid, systemStockMl: stock.balanceMl, physicalStockMl: physicalMl,
    differenceMl, valueDifference, systemDisplay: formatStock(stock.balanceMl, product.volume_ml),
  });
});

// Approving a stocktake creates the actual (audited) stock_adjustments + ledger entries.
// This also works unchanged for a waiter's shift-close stocktake (status =
// 'SUBMITTED') — there's no status check here, so admin can approve either
// an ad-hoc manual stocktake or a shift-linked one through this same route.
router.post('/stocktake/:id/approve', requirePermission('stock.approve'), (req, res) => {
  const stocktake = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(req.params.id);
  if (!stocktake) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id = ?').all(stocktake.id);

  const tx = db.transaction(() => {
    for (const item of items) {
      if (item.difference_ml === 0) continue;
      const adjInfo = db.prepare(`
        INSERT INTO stock_adjustments (product_id, change_ml, reason, notes, requested_by, approved_by, status)
        VALUES (?, ?, 'STOCKTAKE_CORRECTION', ?, ?, ?, 'APPROVED')
      `).run(item.product_id, item.difference_ml, `Stocktake #${stocktake.id} variance`, stocktake.started_by, req.user.id);
      appendInventoryLedger({
        productId: item.product_id, changeMl: item.difference_ml, reason: 'STOCKTAKE',
        refType: 'STOCKTAKE', refId: stocktake.id, userId: req.user.id, notes: `Stocktake #${stocktake.id}`,
      });
      db.prepare('UPDATE stocktake_items SET adjustment_id = ? WHERE id = ?').run(adjInfo.lastInsertRowid, item.id);
    }
    db.prepare(`UPDATE stocktakes SET status = 'APPROVED', approved_by = ?, approved_at = datetime('now') WHERE id = ?`).run(req.user.id, stocktake.id);
    writeAudit({ event: 'STOCKTAKE_APPROVED', userId: req.user.id, role: req.user.role, entityType: 'STOCKTAKE', entityId: stocktake.id, newValue: { itemsAdjusted: items.filter(i => i.difference_ml !== 0).length } });
  });
  tx();
  res.json({ ok: true });
});

// GET /api/inventory/stocktake/discrepancies — cross-waiter view of every
// shift-linked stock count with a nonzero difference, for admin review. This
// must be declared BEFORE the generic /stocktake/:id route below, or Express
// will try to treat "discrepancies" as a stocktake id.
//
// Ad-hoc admin stocktakes (shift_id IS NULL) are excluded — those already
// have their own detail view via GET /stocktake/:id.
router.get('/stocktake/discrepancies', requirePermission('stock.approve'), (req, res) => {
  try {
    const { limit } = req.query;
    const rows = db.prepare(`
      SELECT sti.id, sti.stocktake_id, sti.product_id, p.name AS product_name,
             sti.system_stock_ml, sti.physical_stock_ml, sti.difference_ml, sti.value_difference,
             sti.adjustment_id,
             st.shift_id, st.status AS stocktake_status, st.created_at,
             u.id AS waiter_id, u.name AS waiter_name
      FROM stocktake_items sti
      JOIN stocktakes st ON st.id = sti.stocktake_id
      JOIN products p ON p.id = sti.product_id
      JOIN users u ON u.id = st.started_by
      WHERE st.shift_id IS NOT NULL AND sti.difference_ml != 0
      ORDER BY ABS(sti.value_difference) DESC
      LIMIT ?
    `).all(+(limit || 200));
    res.json(rows);
  } catch (error) {
    console.error('Error fetching stock discrepancies:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/stocktake/:id', (req, res) => {
  const stocktake = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(req.params.id);
  if (!stocktake) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare(`
    SELECT sti.*, p.name AS product_name FROM stocktake_items sti JOIN products p ON p.id = sti.product_id WHERE stocktake_id = ?
  `).all(stocktake.id);
  res.json({ ...stocktake, items });
});

router.get('/low-stock', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active = 1 AND track_inventory = 1').all();
  const low = products.map(p => ({ ...p, stock: getProductStock(p.id) }))
    .filter(p => Math.floor(p.stock.balanceMl / p.volume_ml) <= p.reorder_level)
    .map(p => ({ id: p.id, name: p.name, currentUnits: Math.floor(p.stock.balanceMl / p.volume_ml), reorderLevel: p.reorder_level }));
  res.json(low);
});

module.exports = router;