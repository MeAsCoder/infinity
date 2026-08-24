// backend/src/routes/stockReconciliation.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { writeAudit, decomposeMlIntoUnits, decomposeMlIntoUnitsExcluding } = require('../ledger');

router.use(authMiddleware);

// ============================================================================
// IMPORTANT: For 750ml products, we only want FULL BOTTLE and TOT units.
// Half (375ml) should NOT exist for 750ml products.
// ============================================================================
function getValidSellingUnits(productId, productVolumeMl) {
  let units = db.prepare(`
    SELECT id, name, volume_ml FROM selling_units 
    WHERE product_id = ? AND active = 1 
    ORDER BY volume_ml DESC
  `).all(productId);
  
  // For 750ml products, remove any "Half" unit (375ml)
  if (productVolumeMl >= 750) {
    units = units.filter(u => {
      // Keep Full Bottle (750ml) and Tot (30ml), remove Half (375ml)
      return u.volume_ml === productVolumeMl || u.volume_ml === 30 || u.volume_ml === 50;
    });
  }
  
  // For 250ml products, keep Full (250ml) and Half (125ml) - no tots
  if (productVolumeMl === 250) {
    units = units.filter(u => {
      return u.volume_ml === 250 || u.volume_ml === 125;
    });
  }
  
  return units;
}

// GET /api/stock-reconciliation/shift/:shiftId
router.get('/shift/:shiftId', requirePermission('sales.view_all'), (req, res) => {
    try {
        const shiftId = parseInt(req.params.shiftId, 10);
        
        const shift = db.prepare(`
            SELECT sh.*, u.name AS waiter_name
            FROM shifts sh
            JOIN users u ON u.id = sh.user_id
            WHERE sh.id = ?
        `).get(shiftId);
        
        if (!shift) {
            return res.status(404).json({ error: 'Shift not found' });
        }

        const stockTake = db.prepare(`
            SELECT * FROM stocktakes 
            WHERE shift_id = ? 
            ORDER BY id DESC LIMIT 1
        `).get(shiftId);

        const trackedProducts = db.prepare(`
            SELECT id, name, volume_ml FROM products WHERE active = 1 AND track_inventory = 1 ORDER BY name
        `).all();
        
        if (trackedProducts.length === 0) {
            return res.status(404).json({ 
                error: 'No tracked products configured', 
                shift_id: shiftId, 
                waiter_name: shift.waiter_name 
            });
        }

        const shiftEndTime = shift.ended_at || new Date().toISOString();

        let stocktakeItemsByProduct = {};
        if (stockTake) {
            const items = db.prepare(`
                SELECT * FROM stocktake_items WHERE stocktake_id = ?
            `).all(stockTake.id);
            
            items.forEach(item => {
                const units = db.prepare(`
                    SELECT selling_unit_id, counted_qty, unit_volume_ml, counted_ml 
                    FROM stocktake_item_units 
                    WHERE stocktake_item_id = ?
                `).all(item.id);
                stocktakeItemsByProduct[item.product_id] = { ...item, units };
            });
        }

        const reconciliationItems = [];
        let totalExpectedRevenue = 0;
        let totalActualStockValue = 0;
        let totalCountedStockValue = 0;
        let totalVarianceValue = 0;
        let totalVarianceUnits = 0;
        let totalCostOfSales = 0;
        let totalPotentialFraudValue = 0;
        let missingStockItems = 0;

        for (const product of trackedProducts) {
            // Get valid selling units for this product
            const sellingUnits = getValidSellingUnits(product.id, product.volume_ml);
            
            if (sellingUnits.length === 0) continue;

            // Get actual stock from ledger at shift end (in ml)
            const ledgerRow = db.prepare(`
                SELECT COALESCE(SUM(change_ml), 0) as total_change 
                FROM inventory_ledger 
                WHERE product_id = ? AND created_at <= ?
            `).get(product.id, shiftEndTime);
            const actualStockMl = ledgerRow?.total_change || 0;
            
            // Decompose actual stock into valid units
            const { breakdown: actualBreakdown } = decomposeMlIntoUnits(actualStockMl, sellingUnits);
            const actualByUnit = Object.fromEntries(actualBreakdown.map(b => [b.sellingUnitId, b.qty]));

            const stockTakeItem = stocktakeItemsByProduct[product.id];
            const countedByUnit = {};
            if (stockTakeItem) {
                stockTakeItem.units.forEach(u => {
                    countedByUnit[u.selling_unit_id] = u.counted_qty;
                });
            }

            // Get sales by unit
            const salesByUnit = {};
            db.prepare(`
                SELECT si.selling_unit_id, 
                       COALESCE(SUM(si.quantity), 0) AS qty, 
                       COALESCE(SUM(si.line_total), 0) AS revenue,
                       COALESCE(SUM(si.line_cost), 0) AS cost, 
                       COALESCE(AVG(si.unit_price), 0) AS avg_price, 
                       COALESCE(AVG(si.unit_cost), 0) AS avg_cost
                FROM sale_items si 
                JOIN sales s ON s.id = si.sale_id
                WHERE s.shift_id = ? AND s.status != 'VOIDED' AND si.product_id = ?
                GROUP BY si.selling_unit_id
            `).all(shiftId, product.id).forEach(r => {
                salesByUnit[r.selling_unit_id] = r;
            });

            for (const unit of sellingUnits) {
                const actualStockUnits = actualByUnit[unit.id] ?? 0;
                const wasCounted = !!stockTakeItem;
                const countedStockUnits = countedByUnit[unit.id] ?? 0;
                const sale = salesByUnit[unit.id];

                const priceRow = db.prepare(`
                    SELECT selling_price, cost_price 
                    FROM product_prices 
                    WHERE selling_unit_id = ? AND active = 1 
                    ORDER BY effective_from DESC LIMIT 1
                `).get(unit.id);
                const unitPrice = priceRow?.selling_price || sale?.avg_price || 0;
                const unitCost = priceRow?.cost_price || sale?.avg_cost || 0;

                const expectedRevenue = sale?.revenue || 0;
                const costOfSales = sale?.cost || ((sale?.qty || 0) * unitCost);

                // Calculate variance
                const variance = wasCounted ? actualStockUnits - countedStockUnits : 0;
                const varianceValue = wasCounted ? variance * unitPrice : 0;
                const variancePercentage = wasCounted
                    ? (actualStockUnits > 0 ? Math.round((variance / actualStockUnits) * 100) : (countedStockUnits > 0 ? -100 : 0))
                    : 0;
                
                // Suspicious: variance > 0 (waiter counted less) AND significant
                const isSuspicious = wasCounted && variance > 0 && (variance > 2 || variancePercentage > 20);

                totalExpectedRevenue += expectedRevenue;
                totalCostOfSales += costOfSales;
                totalActualStockValue += actualStockUnits * unitPrice;
                if (wasCounted) totalCountedStockValue += countedStockUnits * unitPrice;
                totalVarianceValue += varianceValue;
                totalVarianceUnits += Math.abs(variance);
                if (wasCounted && variance > 0) {
                    totalPotentialFraudValue += varianceValue;
                    missingStockItems++;
                }

                reconciliationItems.push({
                    product_id: product.id,
                    product_name: product.name,
                    selling_unit_id: unit.id,
                    unit_name: unit.name,
                    volume_ml: unit.volume_ml,
                    actual_stock: actualStockUnits,
                    counted_stock: countedStockUnits,
                    variance: variance,
                    variance_percentage: variancePercentage,
                    variance_value: varianceValue,
                    quantity_sold: sale?.qty || 0,
                    unit_price: unitPrice,
                    unit_cost: unitCost,
                    expected_revenue: expectedRevenue,
                    cost_of_sales: costOfSales,
                    gross_profit: expectedRevenue - costOfSales,
                    is_suspicious: isSuspicious,
                    was_counted: wasCounted,
                });
            }
        }

        if (reconciliationItems.length === 0) {
            return res.status(404).json({ 
                error: 'No sellable units configured for tracked products', 
                shift_id: shiftId, 
                waiter_name: shift.waiter_name 
            });
        }

        let status = !stockTake ? 'PENDING' : 'RECONCILED';
        const hasSuspicious = stockTake && reconciliationItems.some(item => item.is_suspicious);
        const hasVariance = stockTake && reconciliationItems.some(item => Math.abs(item.variance) > 0);
        if (hasSuspicious) {
            status = 'SUSPICIOUS';
        } else if (hasVariance) {
            status = 'DISCREPANCY';
        }

        let existingRecon = db.prepare('SELECT id FROM stock_reconciliations WHERE shift_id = ?').get(shiftId);
        let reconciliationId = existingRecon?.id;

        if (reconciliationId) {
            db.prepare(`
                UPDATE stock_reconciliations 
                SET 
                    stocktake_id = ?,
                    status = ?,
                    total_expected_revenue = ?,
                    total_actual_stock_value = ?,
                    total_counted_stock_value = ?,
                    total_variance_value = ?,
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(
                stockTake?.id || null,
                status,
                totalExpectedRevenue,
                totalActualStockValue,
                totalCountedStockValue,
                totalVarianceValue,
                reconciliationId
            );
        } else {
            const reconInfo = db.prepare(`
                INSERT INTO stock_reconciliations (
                    shift_id, stocktake_id, status, 
                    total_expected_revenue, total_actual_stock_value, 
                    total_counted_stock_value, total_variance_value,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            `).run(
                shiftId,
                stockTake?.id || null,
                status,
                totalExpectedRevenue,
                totalActualStockValue,
                totalCountedStockValue,
                totalVarianceValue
            );
            reconciliationId = reconInfo.lastInsertRowid;
        }

        if (reconciliationId) {
            db.prepare('DELETE FROM stock_reconciliation_items WHERE reconciliation_id = ?').run(reconciliationId);
            
            const insertStmt = db.prepare(`
                INSERT INTO stock_reconciliation_items (
                    reconciliation_id, product_id, selling_unit_id,
                    actual_stock, counted_stock, variance,
                    expected_quantity, expected_revenue, unit_price,
                    notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            `);
            
            for (const item of reconciliationItems) {
                insertStmt.run(
                    reconciliationId,
                    item.product_id,
                    item.selling_unit_id,
                    item.actual_stock,
                    item.counted_stock,
                    item.variance,
                    item.quantity_sold,
                    item.expected_revenue,
                    item.unit_price,
                    !item.was_counted ? 'Not yet counted' :
                        item.is_suspicious ? 
                            `SUSPICIOUS: Variance ${item.variance} units (${item.variance_percentage}%), Value: KES ${item.variance_value}` : 
                            item.variance !== 0 ? 
                                `Variance: ${item.variance} units (${item.variance_percentage}%)` : 
                                null
                );
            }
        }

        writeAudit({
            event: 'STOCK_RECONCILIATION_VIEWED',
            userId: req.user.id,
            role: req.user.role,
            entityType: 'STOCK_RECONCILIATION',
            entityId: reconciliationId,
            newValue: { 
                shift_id: shiftId, 
                status, 
                totalVarianceUnits, 
                missingStockItems,
                totalPotentialFraudValue
            }
        });

        const suspiciousItems = reconciliationItems.filter(item => item.is_suspicious);

        res.json({
            shift_id: shift.id,
            waiter_name: shift.waiter_name,
            shift_start: shift.started_at,
            shift_end: shift.ended_at,
            status: status,
            items: reconciliationItems,
            total_expected_revenue: totalExpectedRevenue,
            total_cost_of_sales: totalCostOfSales,
            total_gross_profit: totalExpectedRevenue - totalCostOfSales,
            total_actual_stock_value: totalActualStockValue,
            total_counted_stock_value: totalCountedStockValue,
            total_variance_value: totalVarianceValue,
            total_variance_units: totalVarianceUnits,
            total_potential_fraud_value: totalPotentialFraudValue,
            missing_stock_items: missingStockItems,
            suspicious_items_count: suspiciousItems.length,
            has_suspicious: hasSuspicious,
            stocktake_submitted: !!stockTake,
        });

    } catch (error) {
        console.error('Error in stock reconciliation:', error);
        res.status(500).json({ error: 'Failed to fetch stock reconciliation data: ' + error.message });
    }
});

// POST /api/stock-reconciliation/save-notes
router.post('/save-notes', requirePermission('sales.view_all'), (req, res) => {
    try {
        const { shift_id, notes } = req.body;
        
        if (!shift_id) {
            return res.status(400).json({ error: 'shift_id required' });
        }
        
        db.prepare(`
            UPDATE stock_reconciliations 
            SET notes = ?, reconciled_by = ?, reconciled_at = datetime('now')
            WHERE shift_id = ?
        `).run(notes || null, req.user.id, shift_id);
        
        db.prepare('UPDATE shifts SET notes = COALESCE(notes || ?, ?) WHERE id = ?')
            .run('\nReconciliation notes: ' + (notes || ''), notes || '', shift_id);
        
        writeAudit({
            event: 'STOCK_RECONCILIATION_NOTES_SAVED',
            userId: req.user.id,
            role: req.user.role,
            entityType: 'SHIFT',
            entityId: shift_id,
            newValue: { notes }
        });
        
        res.json({ success: true, message: 'Notes saved successfully' });
    } catch (error) {
        console.error('Error saving reconciliation notes:', error);
        res.status(500).json({ error: 'Failed to save notes' });
    }
});

// GET /api/stock-reconciliation/recent
router.get('/recent', requirePermission('sales.view_all'), (req, res) => {
    try {
        const { limit = 20 } = req.query;
        
        const reconciliations = db.prepare(`
            SELECT 
                sr.*,
                sh.user_id as waiter_id,
                u.name as waiter_name,
                sh.started_at,
                sh.ended_at
            FROM stock_reconciliations sr
            JOIN shifts sh ON sh.id = sr.shift_id
            JOIN users u ON u.id = sh.user_id
            ORDER BY sr.created_at DESC
            LIMIT ?
        `).all(parseInt(limit));
        
        res.json(reconciliations);
    } catch (error) {
        console.error('Error fetching recent reconciliations:', error);
        res.status(500).json({ error: 'Failed to fetch recent reconciliations' });
    }
});

// POST /api/stock-reconciliation/update-status
router.post('/update-status', requirePermission('stock.approve'), (req, res) => {
    try {
        const { shift_id, status } = req.body;
        
        if (!shift_id || !status) {
            return res.status(400).json({ error: 'shift_id and status required' });
        }
        
        if (!['RECONCILED', 'DISCREPANCY', 'SUSPICIOUS', 'PENDING'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        db.prepare(`
            UPDATE stock_reconciliations 
            SET status = ?, reconciled_by = ?, reconciled_at = datetime('now')
            WHERE shift_id = ?
        `).run(status, req.user.id, shift_id);
        
        writeAudit({
            event: 'STOCK_RECONCILIATION_STATUS_UPDATED',
            userId: req.user.id,
            role: req.user.role,
            entityType: 'SHIFT',
            entityId: shift_id,
            newValue: { status }
        });
        
        res.json({ success: true, message: 'Status updated successfully' });
    } catch (error) {
        console.error('Error updating reconciliation status:', error);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

module.exports = router;