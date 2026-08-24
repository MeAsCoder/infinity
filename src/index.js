// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stockReconciliationRoutes = require('./routes/stockReconciliation');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'infinity-pos-backend', time: new Date().toISOString() }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api', require('./routes/credit'));
app.use('/api/expenses', require('./routes/expenses'));
app.use('/api/users', require('./routes/users'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/sync', require('./routes/sync'));

// NEW: Waiter routes for patterns and dashboard
app.use('/api/waiter', require('./routes/waiter'));
app.use('/api/stock-reconciliation', stockReconciliationRoutes);


// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Infinity POS backend listening on http://localhost:${PORT}`);
  console.log(`Run "npm run seed" once (from backend/) to create default users and the product catalogue.`);
});

// No module.exports needed for index.js - it's the entry point file