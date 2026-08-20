const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { getProductStock, formatStock, writeAudit } = require('../ledger');

router.use(authMiddleware);

function serializeProduct(p) {
  const stock = getProductStock(p.id);
  const units = db.prepare(`
    SELECT su.id, su.name, su.volume_ml, su.active,
           pp.selling_price, pp.cost_price
    FROM selling_units su
    LEFT JOIN product_prices pp ON pp.selling_unit_id = su.id AND pp.active = 1
    WHERE su.product_id = ? ORDER BY su.sort_order
  `).all(p.id);
  return {
    id: p.id, sku: p.sku, barcode: p.barcode, name: p.name, brand: p.brand,
    category: p.category_name, volumeMl: p.volume_ml, active: !!p.active,
    trackInventory: !!p.track_inventory, allowCredit: !!p.allow_credit,
    allowDiscount: !!p.allow_discount, allowServing: !!p.allow_serving,
    minStockLevel: p.min_stock_level, reorderLevel: p.reorder_level,
    stockMl: stock.balanceMl, stockDisplay: formatStock(stock.balanceMl, p.volume_ml),
    avgCostPerMl: stock.avgCostPerMl, lowStock: p.volume_ml > 0 && Math.floor(stock.balanceMl / p.volume_ml) <= p.reorder_level,
    sellingUnits: units.map(u => ({
      id: u.id, name: u.name, volumeMl: u.volume_ml, active: !!u.active,
      price: u.selling_price, cost: u.cost_price,
    })),
  };
}

// GET /api/products?search=&category=&active=1
router.get('/', (req, res) => {
  const { search, active } = req.query;
  let sql = `SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE 1=1`;
  const params = [];
  if (search) { sql += ` AND (p.name LIKE ? OR p.brand LIKE ? OR p.sku LIKE ?)`; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (active !== undefined) { sql += ` AND p.active = ?`; params.push(active === '1' ? 1 : 0); }
  sql += ` ORDER BY p.name LIMIT 500`;
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(serializeProduct));
});

router.get('/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY name').all());
});

router.get('/:id', (req, res) => {
  const p = db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(serializeProduct(p));
});

// POST /api/products  (Super Admin / Admin only)
router.post('/', requirePermission('products.manage'), (req, res) => {
  const b = req.body;
  let categoryId = null;
  if (b.category) {
    const cat = db.prepare('SELECT id FROM categories WHERE name = ?').get(b.category)
      || { id: db.prepare('INSERT INTO categories (name) VALUES (?)').run(b.category).lastInsertRowid };
    categoryId = cat.id;
  }
  const info = db.prepare(`
    INSERT INTO products (sku, barcode, name, brand, category_id, volume_ml, min_stock_level, reorder_level,
      track_inventory, allow_credit, allow_discount, allow_serving, tax_rate, notes, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    b.sku || null, b.barcode || null, b.name, b.brand || null, categoryId, b.volumeMl || 1,
    b.minStockLevel || 0, b.reorderLevel || 0,
    b.trackInventory !== false ? 1 : 0, b.allowCredit !== false ? 1 : 0, b.allowDiscount !== false ? 1 : 0,
    b.allowServing ? 1 : 0, b.taxRate || 0, b.notes || null
  );
  const productId = info.lastInsertRowid;

  const units = b.sellingUnits && b.sellingUnits.length ? b.sellingUnits : [
    { name: b.volumeMl && b.volumeMl > 1 ? 'Bottle' : 'Piece', volumeMl: b.volumeMl || 1, price: b.price || 0, cost: b.cost || 0 },
  ];
  units.forEach((u, idx) => {
    const suInfo = db.prepare(`INSERT INTO selling_units (product_id, name, volume_ml, sort_order) VALUES (?, ?, ?, ?)`)
      .run(productId, u.name, u.volumeMl, idx);
    db.prepare(`INSERT INTO product_prices (selling_unit_id, selling_price, cost_price, changed_by) VALUES (?, ?, ?, ?)`)
      .run(suInfo.lastInsertRowid, u.price || 0, u.cost || 0, req.user.id);
  });

  writeAudit({ event: 'PRODUCT_CREATED', userId: req.user.id, role: req.user.role, entityType: 'PRODUCT', entityId: productId, newValue: b });
  const created = db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`).get(productId);
  res.status(201).json(serializeProduct(created));
});

// PUT /api/products/:id (edit non-price fields; deactivate instead of delete)
router.put('/:id', requirePermission('products.manage'), (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const b = req.body;
  db.prepare(`
    UPDATE products SET name=?, brand=?, sku=?, barcode=?, min_stock_level=?, reorder_level=?,
      track_inventory=?, allow_credit=?, allow_discount=?, allow_serving=?, notes=?, active=?, updated_at=datetime('now')
    WHERE id = ?
  `).run(
    b.name ?? existing.name, b.brand ?? existing.brand, b.sku ?? existing.sku, b.barcode ?? existing.barcode,
    b.minStockLevel ?? existing.min_stock_level, b.reorderLevel ?? existing.reorder_level,
    b.trackInventory !== undefined ? (b.trackInventory ? 1 : 0) : existing.track_inventory,
    b.allowCredit !== undefined ? (b.allowCredit ? 1 : 0) : existing.allow_credit,
    b.allowDiscount !== undefined ? (b.allowDiscount ? 1 : 0) : existing.allow_discount,
    b.allowServing !== undefined ? (b.allowServing ? 1 : 0) : existing.allow_serving,
    b.notes ?? existing.notes,
    b.active !== undefined ? (b.active ? 1 : 0) : existing.active,
    req.params.id
  );
  writeAudit({ event: 'PRODUCT_UPDATED', userId: req.user.id, role: req.user.role, entityType: 'PRODUCT', entityId: +req.params.id, oldValue: existing, newValue: b });
  res.json(serializeProduct(db.prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`).get(req.params.id)));
});

// PUT /api/products/:id/price  — never overwrites history; closes old row + inserts new one
router.put('/:id/units/:unitId/price', requirePermission('products.manage'), (req, res) => {
  const { sellingPrice, costPrice } = req.body;
  const unit = db.prepare('SELECT * FROM selling_units WHERE id = ? AND product_id = ?').get(req.params.unitId, req.params.id);
  if (!unit) return res.status(404).json({ error: 'Selling unit not found' });

  const oldPrice = db.prepare('SELECT * FROM product_prices WHERE selling_unit_id = ? AND active = 1').get(unit.id);
  const tx = db.transaction(() => {
    if (oldPrice) {
      db.prepare(`UPDATE product_prices SET active = 0, effective_to = datetime('now') WHERE id = ?`).run(oldPrice.id);
    }
    db.prepare(`INSERT INTO product_prices (selling_unit_id, selling_price, cost_price, changed_by) VALUES (?, ?, ?, ?)`)
      .run(unit.id, sellingPrice, costPrice != null ? costPrice : (oldPrice ? oldPrice.cost_price : 0), req.user.id);
  });
  tx();
  writeAudit({
    event: 'PRICE_CHANGED', userId: req.user.id, role: req.user.role, entityType: 'SELLING_UNIT', entityId: unit.id,
    oldValue: oldPrice ? { sellingPrice: oldPrice.selling_price, costPrice: oldPrice.cost_price } : null,
    newValue: { sellingPrice, costPrice },
  });
  res.json({ ok: true });
});

// Add / update selling units for a product
router.post('/:id/units', requirePermission('products.manage'), (req, res) => {
  const { name, volumeMl, price, cost } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const suInfo = db.prepare(`INSERT INTO selling_units (product_id, name, volume_ml, sort_order) VALUES (?, ?, ?, 99)`)
    .run(product.id, name, volumeMl);
  db.prepare(`INSERT INTO product_prices (selling_unit_id, selling_price, cost_price, changed_by) VALUES (?, ?, ?, ?)`)
    .run(suInfo.lastInsertRowid, price || 0, cost || 0, req.user.id);
  writeAudit({ event: 'SELLING_UNIT_CREATED', userId: req.user.id, role: req.user.role, entityType: 'PRODUCT', entityId: product.id, newValue: { name, volumeMl, price, cost } });
  res.status(201).json({ ok: true });
});

module.exports = router;
