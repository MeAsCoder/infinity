// db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'infinity.db');

// Ensure the directory for the DB file exists before opening it. This matters
// specifically on hosts like Render, where DB_PATH points at a mounted
// persistent disk (e.g. /data/infinity.db). The disk itself exists once
// attached, but this guards against a bad/mistyped path failing silently or
// against the very first boot before the mount is fully ready.
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Logged on every boot so it's immediately visible in Render's log stream
// whether the app is actually writing to the persistent disk or has silently
// fallen back to the ephemeral local path (e.g. because DB_PATH wasn't set).
console.log(`[db] Opening SQLite database at ${DB_PATH}`);

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  permissions TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT UNIQUE NOT NULL,
  phone TEXT,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  max_discount_percent REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  first_seen TEXT DEFAULT (datetime('now')),
  last_seen TEXT DEFAULT (datetime('now')),
  last_user_id INTEGER
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT UNIQUE,
  barcode TEXT,
  name TEXT NOT NULL,
  brand TEXT,
  category_id INTEGER REFERENCES categories(id),
  volume_ml INTEGER NOT NULL DEFAULT 1,
  supplier_id INTEGER REFERENCES suppliers(id),
  min_stock_level INTEGER NOT NULL DEFAULT 0,
  reorder_level INTEGER NOT NULL DEFAULT 0,
  track_inventory INTEGER NOT NULL DEFAULT 1,
  allow_credit INTEGER NOT NULL DEFAULT 1,
  allow_discount INTEGER NOT NULL DEFAULT 1,
  allow_serving INTEGER NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  image_path TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS selling_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  volume_ml INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(product_id, name)
);

CREATE TABLE IF NOT EXISTS product_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  selling_unit_id INTEGER NOT NULL REFERENCES selling_units(id),
  selling_price INTEGER NOT NULL,
  cost_price INTEGER NOT NULL,
  effective_from TEXT DEFAULT (datetime('now')),
  effective_to TEXT,
  changed_by INTEGER REFERENCES users(id),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  change_ml INTEGER NOT NULL,
  balance_after_ml INTEGER NOT NULL,
  weighted_avg_cost_per_ml_after REAL NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  device_id TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  quantity_units INTEGER NOT NULL,
  quantity_ml INTEGER NOT NULL,
  total_cost INTEGER NOT NULL,
  invoice_ref TEXT,
  batch TEXT,
  expiry_date TEXT,
  received_by INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  change_ml INTEGER NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT NOT NULL,
  requested_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'APPROVED',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stocktakes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_by INTEGER REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_at TEXT DEFAULT (datetime('now')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS stocktake_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  system_stock_ml INTEGER NOT NULL,
  physical_stock_ml INTEGER NOT NULL,
  difference_ml INTEGER NOT NULL,
  value_difference INTEGER NOT NULL,
  reason TEXT,
  adjustment_id INTEGER REFERENCES stock_adjustments(id)
);

-- NEW: Per-unit stocktake details for accurate reconciliation
CREATE TABLE IF NOT EXISTS stocktake_item_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stocktake_item_id INTEGER NOT NULL REFERENCES stocktake_items(id),
  selling_unit_id INTEGER NOT NULL REFERENCES selling_units(id),
  counted_qty INTEGER NOT NULL DEFAULT 0,
  unit_volume_ml INTEGER NOT NULL,
  counted_ml INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(stocktake_item_id, selling_unit_id)
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT,
  address TEXT,
  credit_limit INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  user_id INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS credit_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  sale_id INTEGER REFERENCES sales(id),
  amount INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('DEBT', 'PAYMENT', 'WRITE_OFF', 'ADJUSTMENT')),
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS debt_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER REFERENCES sales(id),
  customer_id INTEGER REFERENCES customers(id),
  waiter_id INTEGER REFERENCES users(id),
  shift_id INTEGER REFERENCES shifts(id),
  amount INTEGER NOT NULL,
  customer_name TEXT,
  customer_phone TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS waiter_stats (
  id TEXT PRIMARY KEY,
  stats TEXT,
  sales TEXT,
  credits TEXT,
  outstandingDebt TEXT,
  allTimeDebts TEXT,
  totalAllTimeDebt TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT,
  opening_float INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'OPEN',
  started_at TEXT DEFAULT (datetime('now')),
  ended_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS shift_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER UNIQUE NOT NULL REFERENCES shifts(id),
  cash_sales INTEGER NOT NULL DEFAULT 0,
  mobile_sales INTEGER NOT NULL DEFAULT 0,
  card_sales INTEGER NOT NULL DEFAULT 0,
  credit_sales INTEGER NOT NULL DEFAULT 0,
  other_sales INTEGER NOT NULL DEFAULT 0,
  cash_expenses INTEGER NOT NULL DEFAULT 0,
  expected_cash INTEGER NOT NULL DEFAULT 0,
  actual_cash INTEGER NOT NULL DEFAULT 0,
  actual_mobile INTEGER NOT NULL DEFAULT 0,
  actual_card INTEGER NOT NULL DEFAULT 0,
  variance INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  submitted_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS shift_recounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  actual_cash INTEGER NOT NULL,
  notes TEXT,
  counted_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS waiver_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waiter_id INTEGER NOT NULL REFERENCES users(id),
  pattern_type TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  details TEXT,
  detected_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE NOT NULL,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  device_id TEXT,
  customer_id INTEGER REFERENCES customers(id),
  tab_label TEXT,
  subtotal INTEGER NOT NULL,
  discount_total INTEGER NOT NULL DEFAULT 0,
  discount_reason TEXT,
  discount_by INTEGER REFERENCES users(id),
  tax_total INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  receipt_number TEXT UNIQUE,
  client_created_at TEXT,
  server_created_at TEXT DEFAULT (datetime('now')),
  settled_at TEXT,
  sync_status TEXT NOT NULL DEFAULT 'SYNCED',
  tip INTEGER NOT NULL DEFAULT 0
);

-- UPDATED: Added product_name column to sale_items
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  selling_unit_id INTEGER NOT NULL REFERENCES selling_units(id),
  unit_name TEXT NOT NULL,
  volume_ml INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  line_total INTEGER NOT NULL,
  line_cost INTEGER NOT NULL,
  product_name TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id),
  method TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reference TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE,
  original_sale_id INTEGER NOT NULL REFERENCES sales(id),
  reason TEXT NOT NULL,
  amount INTEGER NOT NULL,
  requested_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'APPROVED',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refund_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_id INTEGER NOT NULL REFERENCES refunds(id),
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
  quantity INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  volume_ml INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_uuid TEXT UNIQUE,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'CASH',
  description TEXT,
  receipt_ref TEXT,
  shift_id INTEGER REFERENCES shifts(id),
  expense_date TEXT DEFAULT (date('now')),
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS correction_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  requested_by INTEGER REFERENCES users(id),
  reason TEXT NOT NULL,
  proposed_change TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  resolved_by INTEGER REFERENCES users(id),
  resolution_notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  role TEXT,
  entity_type TEXT,
  entity_id INTEGER,
  old_value TEXT,
  new_value TEXT,
  device_id TEXT,
  ip_address TEXT,
  reason TEXT,
  origin TEXT NOT NULL DEFAULT 'SERVER',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_uuid TEXT NOT NULL,
  detail TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  resolved_by INTEGER REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- =============================================
-- STOCK RECONCILIATION TABLES
-- =============================================

CREATE TABLE IF NOT EXISTS stock_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  stocktake_id INTEGER REFERENCES stocktakes(id),
  status TEXT NOT NULL DEFAULT 'PENDING',
  total_expected_revenue INTEGER NOT NULL DEFAULT 0,
  total_actual_stock_value INTEGER NOT NULL DEFAULT 0,
  total_counted_stock_value INTEGER NOT NULL DEFAULT 0,
  total_variance_value INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  reconciled_by INTEGER REFERENCES users(id),
  reconciled_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(shift_id)
);

CREATE TABLE IF NOT EXISTS stock_reconciliation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id INTEGER NOT NULL REFERENCES stock_reconciliations(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  selling_unit_id INTEGER NOT NULL REFERENCES selling_units(id),
  actual_stock INTEGER NOT NULL DEFAULT 0,
  counted_stock INTEGER NOT NULL DEFAULT 0,
  variance INTEGER NOT NULL DEFAULT 0,
  expected_quantity INTEGER NOT NULL DEFAULT 0,
  expected_revenue INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_inventory_ledger_product ON inventory_ledger(product_id);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_customer ON credit_ledger(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id);
CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_debt_logs_sale ON debt_logs(sale_id);
CREATE INDEX IF NOT EXISTS idx_debt_logs_customer ON debt_logs(customer_id);
CREATE INDEX IF NOT EXISTS idx_debt_logs_waiter ON debt_logs(waiter_id);
CREATE INDEX IF NOT EXISTS idx_debt_logs_status ON debt_logs(status);
CREATE INDEX IF NOT EXISTS idx_debt_logs_created ON debt_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_customer ON credit_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_sale ON credit_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_waiter_stats_updated ON waiter_stats(updated_at);
CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_shift_recounts_shift ON shift_recounts(shift_id);
CREATE INDEX IF NOT EXISTS idx_waiver_patterns_waiter ON waiver_patterns(waiter_id);
CREATE INDEX IF NOT EXISTS idx_waiver_patterns_resolved ON waiver_patterns(resolved_at);
CREATE INDEX IF NOT EXISTS idx_stocktakes_shift ON stocktakes(shift_id);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliations_shift ON stock_reconciliations(shift_id);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliations_status ON stock_reconciliations(status);
CREATE INDEX IF NOT EXISTS idx_stock_reconciliation_items_product ON stock_reconciliation_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stocktake_item_units_item ON stocktake_item_units(stocktake_item_id);
`);

// ---------------------------------------------------------------------------
// MIGRATIONS - SAFELY HANDLE EXISTING TABLES AND COLUMNS
// ---------------------------------------------------------------------------

// Safe alter function that handles both duplicate column and missing table errors
function safeAlter(sql) {
  try { 
    db.exec(sql); 
  } catch (e) { 
    // Check if the error is about duplicate column or missing table
    if (!/duplicate column name/i.test(e.message) && !/no such table/i.test(e.message)) {
      throw e; 
    }
    // Silently skip duplicate column or missing table errors
  }
}

// Safe create function for tables
function safeCreate(sql) {
  try { 
    db.exec(sql); 
  } catch (e) { 
    if (!/already exists/i.test(e.message)) {
      throw e; 
    }
  }
}

// Existing migrations with safe handling
safeAlter(`ALTER TABLE sales ADD COLUMN tab_label TEXT`);
safeAlter(`ALTER TABLE sales ADD COLUMN amount_paid INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE sales ADD COLUMN settled_at TEXT`);
safeAlter(`ALTER TABLE customers ADD COLUMN notes TEXT`);
safeAlter(`ALTER TABLE customers ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))`);
safeAlter(`ALTER TABLE customers ADD COLUMN balance INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE shifts ADD COLUMN closed_by INTEGER REFERENCES users(id)`);
safeAlter(`ALTER TABLE shifts ADD COLUMN notes TEXT`);
safeAlter(`ALTER TABLE sales ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'SYNCED'`);
safeAlter(`ALTER TABLE debt_logs ADD COLUMN updated_at TEXT DEFAULT (datetime('now'))`);
safeAlter(`ALTER TABLE sales ADD COLUMN tip INTEGER NOT NULL DEFAULT 0`);
safeAlter(`ALTER TABLE stocktake_items ADD COLUMN selling_unit_id INTEGER REFERENCES selling_units(id)`);

// NEW: Add product_name column to sale_items
safeAlter(`ALTER TABLE sale_items ADD COLUMN product_name TEXT`);

// FIXED: Only add shift_id if the stocktakes table exists
try {
  // Check if stocktakes table exists
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='stocktakes'"
  ).get();
  
  if (tableCheck) {
    safeAlter(`ALTER TABLE stocktakes ADD COLUMN shift_id INTEGER REFERENCES shifts(id)`);
  }
} catch (e) {
  console.log('Note: Could not add shift_id to stocktakes - table may not exist yet');
}

// Create new tables for enhanced features (if they don't exist)
safeCreate(`
  CREATE TABLE IF NOT EXISTS shift_recounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id INTEGER NOT NULL REFERENCES shifts(id),
    actual_cash INTEGER NOT NULL,
    notes TEXT,
    counted_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

safeCreate(`
  CREATE TABLE IF NOT EXISTS waiver_patterns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    waiter_id INTEGER NOT NULL REFERENCES users(id),
    pattern_type TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    details TEXT,
    detected_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT
  )
`);

// Safely create indexes
try {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shift_recounts_shift ON shift_recounts(shift_id);
    CREATE INDEX IF NOT EXISTS idx_waiver_patterns_waiter ON waiver_patterns(waiter_id);
    CREATE INDEX IF NOT EXISTS idx_waiver_patterns_resolved ON waiver_patterns(resolved_at);
  `);
} catch (e) {
  console.log('Note: Some indexes already exist');
}

module.exports = db;