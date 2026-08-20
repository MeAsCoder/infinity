const db = require('./db');

/** Current stock (ml) + weighted avg cost per ml, derived from the ledger's last row. */
function getProductStock(productId) {
  const row = db.prepare(
    `SELECT balance_after_ml, weighted_avg_cost_per_ml_after
     FROM inventory_ledger WHERE product_id = ? ORDER BY id DESC LIMIT 1`
  ).get(productId);
  return row
    ? { balanceMl: row.balance_after_ml, avgCostPerMl: row.weighted_avg_cost_per_ml_after }
    : { balanceMl: 0, avgCostPerMl: 0 };
}

/**
 * Append a movement to the inventory ledger. Never mutates prior rows.
 * On stock-IN (reason=RECEIPT) with a known cost, recomputes the weighted
 * average cost per ml. On stock-OUT, the average cost carries forward
 * unchanged (COGS for the sale is computed from the average cost at the
 * moment of sale, BEFORE this call, by the caller).
 */
function appendInventoryLedger({ productId, changeMl, reason, refType, refId, userId, deviceId, notes, incomingTotalCost }) {
  const current = getProductStock(productId);
  const newBalance = current.balanceMl + changeMl;
  let newAvgCost = current.avgCostPerMl;

  if (reason === 'RECEIPT' && changeMl > 0 && typeof incomingTotalCost === 'number') {
    const existingValue = current.balanceMl * current.avgCostPerMl;
    const incomingValue = incomingTotalCost; // total cost (cents) for the whole receipt, in ml terms
    const totalMl = newBalance;
    newAvgCost = totalMl > 0 ? (existingValue + incomingValue) / totalMl : 0;
  }

  const stmt = db.prepare(`
    INSERT INTO inventory_ledger
      (product_id, change_ml, balance_after_ml, weighted_avg_cost_per_ml_after, reason, ref_type, ref_id, user_id, device_id, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(productId, changeMl, newBalance, newAvgCost, reason, refType || null, refId || null, userId || null, deviceId || null, notes || null);
  return { id: info.lastInsertRowid, balanceMl: newBalance, avgCostPerMl: newAvgCost };
}

/** Current outstanding balance for a customer (cents), derived from the ledger. */
function getCustomerBalance(customerId) {
  const row = db.prepare(
    `SELECT balance_after FROM credit_ledger WHERE customer_id = ? ORDER BY id DESC LIMIT 1`
  ).get(customerId);
  return row ? row.balance_after : 0;
}

function appendCreditLedger({ customerId, type, amount, refType, refId, userId, approvedBy, notes }) {
  const current = getCustomerBalance(customerId);
  const newBalance = current + amount;
  const stmt = db.prepare(`
    INSERT INTO credit_ledger (customer_id, type, amount, balance_after, ref_type, ref_id, user_id, approved_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(customerId, type, amount, newBalance, refType || null, refId || null, userId || null, approvedBy || null, notes || null);
  return { id: info.lastInsertRowid, balanceAfter: newBalance };
}

function writeAudit({ event, userId, role, entityType, entityId, oldValue, newValue, deviceId, ipAddress, reason, origin }) {
  db.prepare(`
    INSERT INTO audit_logs (event, user_id, role, entity_type, entity_id, old_value, new_value, device_id, ip_address, reason, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event, userId || null, role || null, entityType || null, entityId || null,
    oldValue != null ? JSON.stringify(oldValue) : null,
    newValue != null ? JSON.stringify(newValue) : null,
    deviceId || null, ipAddress || null, reason || null, origin || 'SERVER'
  );
}

/** Human-friendly "bottles + ml remaining" display for a product's stock. */
function formatStock(balanceMl, bottleVolumeMl) {
  if (!bottleVolumeMl || bottleVolumeMl <= 1) return `${balanceMl} pcs`;
  const bottles = Math.floor(balanceMl / bottleVolumeMl);
  const rest = balanceMl - bottles * bottleVolumeMl;
  return rest > 0 ? `${bottles} bottles + ${rest}ml` : `${bottles} bottles`;
}

function nextReceiptNumber() {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM sales`).get();
  const n = (row.c || 0) + 1;
  const date = new Date();
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `INF-${ymd}-${String(n).padStart(5, '0')}`;
}

module.exports = {
  getProductStock,
  appendInventoryLedger,
  getCustomerBalance,
  appendCreditLedger,
  writeAudit,
  formatStock,
  nextReceiptNumber,
};
