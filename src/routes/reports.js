const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { getProductStock, getCustomerBalance } = require('../ledger');

router.use(authMiddleware);
router.use(requirePermission('reports.view', '*'));

// GET /api/reports/dashboard
router.get('/dashboard', (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    
    let dateFilter = '';
    let params = [];
    if (date) {
      dateFilter = 'AND DATE(server_created_at) = ?';
      params.push(date);
    } else if (startDate && endDate) {
      dateFilter = 'AND DATE(server_created_at) BETWEEN ? AND ?';
      params.push(startDate, endDate);
    } else {
      dateFilter = "AND DATE(server_created_at) = DATE('now')";
    }

    const salesData = db.prepare(`
      SELECT COALESCE(SUM(total),0) AS revenue, COUNT(*) AS count, COALESCE(SUM(discount_total),0) AS total_discounts
      FROM sales WHERE status != 'VOIDED' ${dateFilter}
    `).get(...params);

    const cogsData = db.prepare(`
      SELECT COALESCE(SUM(si.line_cost),0) AS cogs
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status != 'VOIDED' ${dateFilter}
    `).get(...params);

    const allSales = db.prepare(`
      SELECT * FROM sales WHERE status != 'VOIDED' ${dateFilter} ORDER BY server_created_at DESC
    `).all(...params);

    const openShifts = db.prepare("SELECT COUNT(*) AS c FROM shifts WHERE status = 'OPEN'").get().c;

    let shortageFilter = '';
    let shortageParams = [];
    if (date) {
      shortageFilter = 'AND DATE(submitted_at) = ?';
      shortageParams.push(date);
    } else if (startDate && endDate) {
      shortageFilter = 'AND DATE(submitted_at) BETWEEN ? AND ?';
      shortageParams.push(startDate, endDate);
    } else {
      shortageFilter = "AND DATE(submitted_at) = DATE('now')";
    }

    const shortagesData = db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN variance < 0 THEN -variance ELSE 0 END),0) AS shortages,
        COALESCE(SUM(CASE WHEN variance > 0 THEN variance ELSE 0 END),0) AS surpluses,
        COALESCE(SUM(expected_cash),0) AS expected
      FROM shift_reconciliations WHERE 1=1 ${shortageFilter}
    `).get(...shortageParams);

    const creditOutstanding = db.prepare(`
      SELECT customer_id, MAX(id) AS last_id FROM credit_ledger GROUP BY customer_id
    `).all().reduce((sum, row) => {
      const bal = db.prepare('SELECT balance_after FROM credit_ledger WHERE id = ?').get(row.last_id).balance_after;
      return sum + Math.max(bal, 0);
    }, 0);

    const products = db.prepare('SELECT * FROM products WHERE active = 1 AND track_inventory = 1').all();
    let stockValue = 0, lowStockCount = 0, outOfStockCount = 0;
    for (const p of products) {
      const stock = getProductStock(p.id);
      stockValue += Math.round(stock.balanceMl * stock.avgCostPerMl);
      if (stock.balanceMl <= 0) outOfStockCount++;
      else if (Math.floor(stock.balanceMl / p.volume_ml) <= p.reorder_level) lowStockCount++;
    }

    const pendingSync = db.prepare("SELECT COUNT(*) AS c FROM sales WHERE sync_status != 'SYNCED'").get().c;

    const recentStockMoves = db.prepare(`
      SELECT il.*, p.name AS product_name FROM inventory_ledger il JOIN products p ON p.id = il.product_id ORDER BY il.id DESC LIMIT 10
    `).all();

    const topProducts = db.prepare(`
      SELECT p.id, p.name, COALESCE(SUM(si.quantity),0) as quantity_sold, COALESCE(SUM(si.line_total),0) as total_revenue
      FROM sale_items si JOIN products p ON p.id = si.product_id JOIN sales s ON s.id = si.sale_id
      WHERE s.status != 'VOIDED' ${dateFilter} GROUP BY p.id ORDER BY quantity_sold DESC LIMIT 10
    `).all(...params);

    const paymentMethods = db.prepare(`
      SELECT p.method, COALESCE(SUM(p.amount),0) as total
      FROM payments p JOIN sales s ON s.id = p.sale_id
      WHERE s.status != 'VOIDED' ${dateFilter} GROUP BY p.method ORDER BY total DESC
    `).all(...params);

    const uniqueCustomers = db.prepare(`
      SELECT COUNT(DISTINCT customer_id) as count
      FROM sales WHERE status != 'VOIDED' AND customer_id IS NOT NULL ${dateFilter}
    `).get(...params);

    const avgTransaction = salesData.count > 0 ? salesData.revenue / salesData.count : 0;

    let shiftFilter = '';
    let shiftParams = [];
    if (date) {
      shiftFilter = 'WHERE DATE(ended_at) = ?';
      shiftParams.push(date);
    } else if (startDate && endDate) {
      shiftFilter = 'WHERE DATE(ended_at) BETWEEN ? AND ?';
      shiftParams.push(startDate, endDate);
    } else {
      shiftFilter = "WHERE DATE(ended_at) = DATE('now')";
    }
    const closedShifts = db.prepare(`SELECT COUNT(*) AS c FROM shifts ${shiftFilter}`).get(...shiftParams).c;

    res.json({
      todayRevenue: salesData.revenue,
      todayTransactionCount: salesData.count,
      todayGrossProfit: salesData.revenue - cogsData.cogs,
      todayEstimatedNetProfit: salesData.revenue - cogsData.cogs,
      stockValue, lowStockCount, outOfStockCount,
      creditOutstanding,
      openShifts, closedTodayShifts: closedShifts,
      todayCashExpected: shortagesData.expected,
      todayShortages: shortagesData.shortages,
      todaySurpluses: shortagesData.surpluses,
      pendingSync,
      recentSales: allSales.slice(0, 10),
      allSales: allSales,
      recentStockMoves: recentStockMoves,
      topProducts: topProducts,
      paymentMethods: paymentMethods,
      totalTransactions: salesData.count,
      averageTransaction: avgTransaction,
      totalDiscounts: salesData.total_discounts,
      uniqueCustomers: uniqueCustomers?.count || 0,
      period: { date: date || null, startDate: startDate || null, endDate: endDate || null }
    });
  } catch (error) {
    console.error('Error in dashboard:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard data' });
  }
});

// GET /api/reports/operations - live view for the admin: who currently has a
// shift open and their running totals, the most recently closed shifts with
// their cash variance, and any waiters with flagged surplus/shortage patterns.
router.get('/operations', (req, res) => {
  try {
    const activeShiftRows = db.prepare(`
      SELECT sh.id, sh.user_id, u.name AS waiter_name, sh.started_at, sh.opening_float
      FROM shifts sh JOIN users u ON u.id = sh.user_id
      WHERE sh.status = 'OPEN'
      ORDER BY sh.started_at ASC
    `).all();

    const activeShifts = activeShiftRows.map(sh => {
      const totals = db.prepare(`
        SELECT p.method, SUM(p.amount) AS total
        FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.shift_id = ? AND s.status != 'VOIDED'
        GROUP BY p.method
      `).all(sh.id);
      const byMethod = { CASH: 0, MOBILE: 0, CARD: 0, CREDIT: 0, OTHER: 0 };
      totals.forEach(t => { byMethod[t.method] = t.total; });

      const expenseRow = db.prepare(`
        SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE shift_id = ? AND payment_method = 'CASH'
      `).get(sh.id);

      const txCountRow = db.prepare(`
        SELECT COUNT(*) AS c FROM sales WHERE shift_id = ? AND status != 'VOIDED'
      `).get(sh.id);

      const openTabsRow = db.prepare(`
        SELECT COUNT(*) AS c FROM sales WHERE shift_id = ? AND status = 'OPEN'
      `).get(sh.id);

      const expectedCashSoFar = sh.opening_float + byMethod.CASH - expenseRow.total;

      return {
        shiftId: sh.id,
        waiterId: sh.user_id,
        waiterName: sh.waiter_name,
        startedAt: sh.started_at,
        openingFloat: sh.opening_float,
        cashSales: byMethod.CASH,
        mobileSales: byMethod.MOBILE,
        cardSales: byMethod.CARD,
        creditSales: byMethod.CREDIT,
        otherSales: byMethod.OTHER,
        cashExpenses: expenseRow.total,
        expectedCashSoFar,
        transactionCount: txCountRow.c,
        openTabs: openTabsRow.c,
      };
    });

    const recentClosedShifts = db.prepare(`
      SELECT sh.id, sh.user_id, u.name AS waiter_name, sh.started_at, sh.ended_at,
             sr.expected_cash, sr.actual_cash, sr.variance, sr.notes
      FROM shifts sh
      JOIN users u ON u.id = sh.user_id
      LEFT JOIN shift_reconciliations sr ON sr.shift_id = sh.id
      WHERE sh.status = 'CLOSED'
      ORDER BY sh.ended_at DESC
      LIMIT 15
    `).all();

    const flaggedRows = db.prepare(`
      SELECT wp.id, wp.waiter_id, u.name AS waiter_name, wp.pattern_type, wp.score, wp.details
      FROM waiver_patterns wp
      JOIN users u ON u.id = wp.waiter_id
      ORDER BY wp.id DESC
      LIMIT 100
    `).all();
    const flaggedByWaiter = {};
    flaggedRows.forEach(r => {
      if (!flaggedByWaiter[r.waiter_id]) {
        flaggedByWaiter[r.waiter_id] = { waiterId: r.waiter_id, waiterName: r.waiter_name, totalScore: 0, patterns: [] };
      }
      flaggedByWaiter[r.waiter_id].totalScore += r.score;
      flaggedByWaiter[r.waiter_id].patterns.push({ type: r.pattern_type, score: r.score, detail: r.details });
    });

    res.json({
      activeShifts,
      recentClosedShifts,
      flaggedWaiters: Object.values(flaggedByWaiter).sort((a, b) => b.totalScore - a.totalScore),
    });
  } catch (error) {
    console.error('Error in operations report:', error);
    res.status(500).json({ error: 'Failed to fetch operations data' });
  }
});

// GET /api/reports/sales
router.get('/sales', (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    let sql = `SELECT date(server_created_at) AS day, COUNT(*) AS transactions, SUM(total) AS revenue, SUM(discount_total) AS discounts
               FROM sales WHERE status != 'VOIDED'`;
    const params = [];
    if (date) { sql += ' AND DATE(server_created_at) = ?'; params.push(date); }
    else if (startDate && endDate) { sql += ' AND DATE(server_created_at) BETWEEN ? AND ?'; params.push(startDate, endDate); }
    sql += ' GROUP BY day ORDER BY day DESC LIMIT 90';
    res.json(db.prepare(sql).all(...params));
  } catch (error) {
    console.error('Error in sales report:', error);
    res.status(500).json({ error: 'Failed to fetch sales report' });
  }
});

// GET /api/reports/products
router.get('/products', (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    let sql = `
      SELECT p.id, p.name, SUM(si.quantity) AS unitsSold, SUM(si.line_total) AS revenue, SUM(si.line_cost) AS cogs
      FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
      WHERE s.status != 'VOIDED'`;
    const params = [];
    if (date) { sql += ' AND DATE(s.server_created_at) = ?'; params.push(date); }
    else if (startDate && endDate) { sql += ' AND DATE(s.server_created_at) BETWEEN ? AND ?'; params.push(startDate, endDate); }
    sql += ' GROUP BY p.id ORDER BY revenue DESC LIMIT 200';
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(r => ({ ...r, grossProfit: r.revenue - r.cogs, marginPct: r.revenue ? ((r.revenue - r.cogs) / r.revenue) * 100 : 0 })));
  } catch (error) {
    console.error('Error in products report:', error);
    res.status(500).json({ error: 'Failed to fetch products report' });
  }
});

// GET /api/reports/waiters
router.get('/waiters', (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    let sql = `
      SELECT u.id, u.name, COUNT(DISTINCT s.id) AS transactions, COALESCE(SUM(s.total),0) AS revenue,
        COALESCE(SUM(CASE WHEN p.method='CASH' THEN p.amount ELSE 0 END),0) AS cashRevenue,
        COALESCE(SUM(CASE WHEN p.method='MOBILE' THEN p.amount ELSE 0 END),0) AS mobileRevenue,
        COALESCE(SUM(CASE WHEN p.method='CARD' THEN p.amount ELSE 0 END),0) AS cardRevenue,
        COALESCE(SUM(CASE WHEN p.method='CREDIT' THEN p.amount ELSE 0 END),0) AS creditRevenue
      FROM users u
      LEFT JOIN sales s ON s.user_id = u.id AND s.status != 'VOIDED'
      LEFT JOIN payments p ON p.sale_id = s.id WHERE 1=1`;
    const params = [];
    if (date) { sql += ' AND (s.server_created_at IS NULL OR DATE(s.server_created_at) = ?)'; params.push(date); }
    else if (startDate && endDate) { sql += ' AND (s.server_created_at IS NULL OR DATE(s.server_created_at) BETWEEN ? AND ?)'; params.push(startDate, endDate); }
    sql += ' GROUP BY u.id ORDER BY revenue DESC';
    const perf = db.prepare(sql).all(...params);

    let varianceSql = `
      SELECT sh.user_id, COALESCE(SUM(CASE WHEN sr.variance < 0 THEN -sr.variance ELSE 0 END),0) AS shortages,
        COALESCE(SUM(CASE WHEN sr.variance > 0 THEN sr.variance ELSE 0 END),0) AS surpluses
      FROM shift_reconciliations sr JOIN shifts sh ON sh.id = sr.shift_id WHERE 1=1`;
    const varianceParams = [];
    if (date) { varianceSql += ' AND DATE(sr.submitted_at) = ?'; varianceParams.push(date); }
    else if (startDate && endDate) { varianceSql += ' AND DATE(sr.submitted_at) BETWEEN ? AND ?'; varianceParams.push(startDate, endDate); }
    varianceSql += ' GROUP BY sh.user_id';
    const variance = db.prepare(varianceSql).all(...varianceParams);
    const varianceMap = Object.fromEntries(variance.map(v => [v.user_id, v]));

    res.json(perf.map(p => ({
      ...p,
      avgTransaction: p.transactions ? Math.round(p.revenue / p.transactions) : 0,
      shortages: varianceMap[p.id]?.shortages || 0,
      surpluses: varianceMap[p.id]?.surpluses || 0,
    })));
  } catch (error) {
    console.error('Error in waiters report:', error);
    res.status(500).json({ error: 'Failed to fetch waiters report' });
  }
});

// GET /api/reports/waiters-performance
router.get('/waiters-performance', (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    
    const waiters = db.prepare(`
      SELECT u.id, u.name, u.username, u.phone
      FROM users u JOIN roles r ON r.id = u.role_id
      WHERE r.name = 'WAITER' AND u.active = 1 ORDER BY u.name
    `).all();

    if (waiters.length === 0) return res.json([]);

    const result = waiters.map(waiter => {
      try {
        let salesSql = `
          SELECT COUNT(*) as transactions, COALESCE(SUM(total), 0) as revenue,
            COALESCE(AVG(total), 0) as avg_transaction, COALESCE(SUM(discount_total), 0) as total_discounts
          FROM sales WHERE user_id = ? AND status != 'VOIDED'
        `;
        let salesParams = [waiter.id];
        if (date) { salesSql += ` AND DATE(server_created_at) = ?`; salesParams.push(date); }
        else if (startDate && endDate) { salesSql += ` AND DATE(server_created_at) BETWEEN ? AND ?`; salesParams.push(startDate, endDate); }
        const sales = db.prepare(salesSql).get(...salesParams);

        // Debt/credit data comes from credit_ledger — the actual system sales.js
        // writes to on a credit sale or a walk-out debt. There is no separate
        // "debt_logs" table in this schema; querying credit_ledger here keeps
        // this route consistent with what /api/sales/waiter/:id/debts already
        // returns on the waiter's own dashboard.
        //
        // IMPORTANT: this nets PAYMENT/WRITE_OFF entries (written by
        // /api/sales/debts/:id/resolve) against the original SALE entry, per
        // sale, and only counts/sums sales that still have a positive balance.
        // A naive SUM(amount) WHERE type='SALE' (the old version of this
        // query) reports lifetime gross debt ever incurred and never reflects
        // a debt being marked paid or written off — this fixes that.
        const debtAgg = db.prepare(`
          WITH sale_balances AS (
            SELECT cl.ref_id AS sale_id, COALESCE(SUM(cl.amount), 0) AS balance
            FROM credit_ledger cl
            JOIN sales s ON s.id = cl.ref_id AND cl.ref_type = 'SALE'
            WHERE s.user_id = ?
            GROUP BY cl.ref_id
          )
          SELECT
            COALESCE(SUM(CASE WHEN balance > 0 THEN balance ELSE 0 END), 0) AS total_debt,
            COUNT(CASE WHEN balance > 0 THEN 1 END) AS debt_count
          FROM sale_balances
        `).get(waiter.id);

        // Same netting logic as debtAgg above, applied per-sale so only
        // still-owing debts show up in the detail list (not resolved ones).
        const allDebts = db.prepare(`
          SELECT s.id AS sale_id, s.receipt_number, s.tab_label, c.name AS customer_name,
                 MAX(cl.created_at) AS created_at,
                 COALESCE(SUM(cl.amount), 0) AS amount
          FROM credit_ledger cl
          JOIN sales s ON s.id = cl.ref_id AND cl.ref_type = 'SALE'
          JOIN customers c ON c.id = cl.customer_id
          WHERE s.user_id = ?
          GROUP BY s.id, c.name, s.receipt_number, s.tab_label
          HAVING amount > 0
          ORDER BY s.id DESC LIMIT 50
        `).all(waiter.id);

        const shortages = db.prepare(`
          SELECT COALESCE(SUM(CASE WHEN sr.variance < 0 THEN -sr.variance ELSE 0 END), 0) as total_shortages,
            COUNT(CASE WHEN sr.variance < 0 THEN 1 END) as shortage_count
          FROM shift_reconciliations sr JOIN shifts sh ON sh.id = sr.shift_id WHERE sh.user_id = ?
        `).get(waiter.id);

        let tipsTotal = 0;
        try {
          const tips = db.prepare(`
            SELECT COALESCE(SUM(tip), 0) as total_tips
            FROM sales WHERE user_id = ? AND status != 'VOIDED' AND tip > 0
          `).get(waiter.id);
          tipsTotal = tips?.total_tips || 0;
        } catch (e) {}

        // Pattern scores — waiver_patterns only has id/waiter_id/pattern_type/
        // score/details (see shifts.js), so this orders by id rather than a
        // timestamp column that doesn't exist on this table.
        const patterns = db.prepare(`
          SELECT pattern_type, score, details FROM waiver_patterns
          WHERE waiter_id = ? ORDER BY id DESC LIMIT 5
        `).all(waiter.id);

        return {
          id: waiter.id,
          name: waiter.name,
          username: waiter.username,
          phone: waiter.phone,
          transactions: sales?.transactions || 0,
          revenue: sales?.revenue || 0,
          avgTransaction: Math.round(sales?.avg_transaction || 0),
          totalDiscounts: sales?.total_discounts || 0,
          outstandingDebt: debtAgg?.total_debt || 0,
          debtCount: debtAgg?.debt_count || 0,
          debts: allDebts || [],
          shortages: shortages?.total_shortages || 0,
          shortageCount: shortages?.shortage_count || 0,
          tips: tipsTotal,
          patterns: patterns || []
        };
      } catch (error) {
        console.error(`Error processing waiter ${waiter.id}:`, error);
        return { id: waiter.id, name: waiter.name, username: waiter.username, phone: waiter.phone,
          transactions: 0, revenue: 0, avgTransaction: 0, totalDiscounts: 0,
          outstandingDebt: 0, debtCount: 0, debts: [], shortages: 0, shortageCount: 0, tips: 0, patterns: [] };
      }
    });

    res.json(result);
  } catch (error) {
    console.error('Error in waiters-performance:', error);
    res.status(500).json({ error: 'Failed to fetch waiter performance data' });
  }
});

// GET /api/reports/profit
router.get('/profit', (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    let salesSql = `SELECT COALESCE(SUM(total),0) AS revenue FROM sales WHERE status != 'VOIDED'`;
    let cogsSql = `SELECT COALESCE(SUM(si.line_cost),0) AS cogs FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status != 'VOIDED'`;
    let expSql = `SELECT COALESCE(SUM(amount),0) AS total FROM expenses WHERE 1=1`;
    const p1 = [], p2 = [], p3 = [];
    if (date) {
      salesSql += ' AND DATE(server_created_at) = ?'; p1.push(date);
      cogsSql += ' AND DATE(s.server_created_at) = ?'; p2.push(date);
      expSql += ' AND DATE(expense_date) = ?'; p3.push(date);
    } else if (startDate && endDate) {
      salesSql += ' AND DATE(server_created_at) BETWEEN ? AND ?'; p1.push(startDate, endDate);
      cogsSql += ' AND DATE(s.server_created_at) BETWEEN ? AND ?'; p2.push(startDate, endDate);
      expSql += ' AND DATE(expense_date) BETWEEN ? AND ?'; p3.push(startDate, endDate);
    }
    const revenue = db.prepare(salesSql).get(...p1).revenue;
    const cogs = db.prepare(cogsSql).get(...p2).cogs;
    const expenses = db.prepare(expSql).get(...p3).total;
    const grossProfit = revenue - cogs;
    const netProfit = grossProfit - expenses;
    res.json({
      revenue, cogs, grossProfit, grossMarginPct: revenue ? (grossProfit / revenue) * 100 : 0,
      expenses, netProfit, netMarginPct: revenue ? (netProfit / revenue) * 100 : 0,
    });
  } catch (error) {
    console.error('Error in profit report:', error);
    res.status(500).json({ error: 'Failed to fetch profit report' });
  }
});

// GET /api/reports/stock
router.get('/stock', (req, res) => {
  try {
    const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
    res.json(products.map(p => {
      const stock = getProductStock(p.id);
      return {
        id: p.id, name: p.name, volumeMl: p.volume_ml, stockMl: stock.balanceMl,
        stockUnits: p.volume_ml > 0 ? Math.floor(stock.balanceMl / p.volume_ml) : stock.balanceMl,
        avgCostPerMl: stock.avgCostPerMl, stockValue: Math.round(stock.balanceMl * stock.avgCostPerMl),
        reorderLevel: p.reorder_level, lowStock: p.volume_ml > 0 && Math.floor(stock.balanceMl / p.volume_ml) <= p.reorder_level,
      };
    }));
  } catch (error) {
    console.error('Error in stock report:', error);
    res.status(500).json({ error: 'Failed to fetch stock report' });
  }
});

// GET /api/reports/credit
router.get('/credit', (req, res) => {
  try {
    const customers = db.prepare('SELECT * FROM customers WHERE active = 1').all();
    res.json(customers.map(c => ({ id: c.id, name: c.name, phone: c.phone, balance: getCustomerBalance(c.id), creditLimit: c.credit_limit })).filter(c => c.balance > 0));
  } catch (error) {
    console.error('Error in credit report:', error);
    res.status(500).json({ error: 'Failed to fetch credit report' });
  }
});

// GET /api/reports/export
router.get('/export', (req, res) => {
  try {
    const { date, startDate, endDate } = req.query;
    let dateFilter = '';
    let params = [];
    if (date) {
      dateFilter = 'AND DATE(server_created_at) = ?';
      params.push(date);
    } else if (startDate && endDate) {
      dateFilter = 'AND DATE(server_created_at) BETWEEN ? AND ?';
      params.push(startDate, endDate);
    } else {
      dateFilter = "AND DATE(server_created_at) = DATE('now')";
    }

    const sales = db.prepare(`SELECT * FROM sales WHERE status != 'VOIDED' ${dateFilter} ORDER BY server_created_at DESC`).all(...params);
    const saleItems = db.prepare(`SELECT si.*, s.receipt_number FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.status != 'VOIDED' ${dateFilter}`).all(...params);
    const payments = db.prepare(`SELECT p.*, s.receipt_number FROM payments p JOIN sales s ON s.id = p.sale_id WHERE s.status != 'VOIDED' ${dateFilter}`).all(...params);

    let shiftFilter = '';
    let shiftParams = [];
    if (date) {
      shiftFilter = 'WHERE DATE(submitted_at) = ?';
      shiftParams.push(date);
    } else if (startDate && endDate) {
      shiftFilter = 'WHERE DATE(submitted_at) BETWEEN ? AND ?';
      shiftParams.push(startDate, endDate);
    } else {
      shiftFilter = "WHERE DATE(submitted_at) = DATE('now')";
    }
    const reconciliations = db.prepare(`SELECT * FROM shift_reconciliations ${shiftFilter}`).all(...shiftParams);

    let expFilter = '';
    let expParams = [];
    if (date) {
      expFilter = 'WHERE DATE(expense_date) = ?';
      expParams.push(date);
    } else if (startDate && endDate) {
      expFilter = 'WHERE DATE(expense_date) BETWEEN ? AND ?';
      expParams.push(startDate, endDate);
    } else {
      expFilter = "WHERE DATE(expense_date) = DATE('now')";
    }
    const expenses = db.prepare(`SELECT * FROM expenses ${expFilter}`).all(...expParams);

    // Debt export now reads credit_ledger (the real system sales.js writes to)
    // instead of the non-existent "debt_logs" table the original code queried.
    let debtFilter = '';
    let debtParams = [];
    if (date) {
      debtFilter = 'AND DATE(cl.created_at) = ?';
      debtParams.push(date);
    } else if (startDate && endDate) {
      debtFilter = 'AND DATE(cl.created_at) BETWEEN ? AND ?';
      debtParams.push(startDate, endDate);
    } else {
      debtFilter = "AND DATE(cl.created_at) = DATE('now')";
    }
    const debts = db.prepare(`
      SELECT cl.*, c.name AS customer_name, s.receipt_number
      FROM credit_ledger cl
      JOIN sales s ON s.id = cl.ref_id AND cl.ref_type = 'SALE'
      JOIN customers c ON c.id = cl.customer_id
      WHERE cl.type = 'SALE' ${debtFilter}
    `).all(...debtParams);

    const totalRevenue = sales.reduce((sum, s) => sum + s.total, 0);
    const totalDiscounts = sales.reduce((sum, s) => sum + s.discount_total, 0);
    const totalTransactions = sales.length;
    const totalDebts = debts.reduce((sum, d) => sum + d.amount, 0);

    res.json({
      period: { date: date || null, startDate: startDate || null, endDate: endDate || null, exportedAt: new Date().toISOString() },
      summary: { totalRevenue, totalDiscounts, totalTransactions, averageTransaction: totalTransactions > 0 ? totalRevenue / totalTransactions : 0, totalDebts, debtCount: debts.length },
      sales, saleItems, payments, reconciliations, expenses, debts
    });
  } catch (error) {~~
    console.error('Error in export:', error);
    res.status(500).json({ error: 'Failed to export report' });
  }
});

module.exports = router;