// reset-and-seed.js
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs'); // Use bcryptjs to match auth.js

// Fix: Use correct paths to src files
const { appendInventoryLedger, writeAudit } = require('./src/ledger');

const DB_PATH = path.join(__dirname, 'infinity.db');
const BACKUP_PATH = path.join(__dirname, `infinity.db.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);

// ============================================================================
// PERMISSIONS
// ============================================================================
const PERMISSIONS = {
  SUPER_ADMIN: ['*'],
  ADMIN: [
    'products.manage', 'stock.receive', 'stock.adjust', 'stock.approve', 'stocktake.manage',
    'sales.view_all', 'sales.refund', 'credit.manage', 'credit.repay', 'credit.create_sale',
    'shifts.view_all', 'shifts.correct', 'reports.view', 'audit.view', 'expenses.manage',
    'suppliers.manage', 'discounts.apply_unlimited', 'corrections.approve',
  ],
  WAITER: [
    'sales.create', 'shifts.own.start', 'shifts.own.end', 'shifts.own.view',
    'credit.create_sale', 'corrections.request',
  ],
};

// ============================================================================
// CATALOGUE DATA
// ============================================================================
const RAW_CATALOGUE = {
  Beer: {
    items: [
      ['Guinness Bottle', []], ['Guinness Can', []],
      ['Tusker Bottle', []], ['Tusker Can', []], ['Tusker Cider Can', []],
      ['Whitecap Bottle', []], ['Whitecap Can', []],
      ['Balozi Bottle', []], ['Balozi Can', []],
      ['Pilsner Can', []],
      ['Faxe Can', []], ['Tusker Malt Can', []], ['Tusker Lite Can', []],
      ['Snapp Can', []], ['Heineken', []], ['Dunhill', []], ['Palmo', []],
    ],
  },
  Spirit: {
    items: [
      ['Gilbeys', [250, 350, 750]],
      ['Gilbeys Flavoured', [250, 350, 750]],
      ['Chrome Vodka', [250, 750]],
      ['Chrome Gin', [250, 750]],
      ['Best Whisky', [250, 750]],
      ['Best Cream', [250]],
      ['KC Ginger', [250, 750]],
      ['Best Dry Gin', [750]],
      ['Club Man', [250, 750]],
      ['Hunters Choice', [250, 350, 750]],
      ['Captain Morgan', [250, 750]],
      ['Konyagi', [250, 500, 750]],
      ['Kibao', [250, 350, 750]],
      ['Blue Ice', [250]],
      ['V&A', [250, 750]],
      ['K.C. Smooth', [250, 350, 750]],
      ['K.C. Pineapple', [250, 750]],
      ['Kenya King', [250]],
      ['Triple Ace', [250]],
      ['General Meakins', [250, 750]],
      ['Napoleon', [250]],
      ['Kane Extra', [250, 750]],
      ['Orijin', [250]],
      ['Richot', [250, 750]],
      ['Black & White', [250, 375, 750]],
      ['Jinro', []],
      ['Viceroy', [250, 350, 750]],
      ['County', [750]],
      ['Smart', []],
      ['All Seasons', [250, 350, 750]],
      ['VAT 69', [250, 375]],
      ['Bond 7', [250]],
      ['Flirt Vodka', [1000]],
      ['Smirnoff Vodka', [250]],
      ['People', [250]],
      ['Manyatta B', []],
      ['Manyatta Can', []],
      ['Best', []],
    ],
  },
  Wine: {
    items: [
      ['Four Cousins Red', [750]], ['Four Cousins White', [750]],
      ['Drostdy Hof Red', [750]], ['Drostdy Hof White', [750]],
      ['Black Bird', [750]],
      ['Cellar Cask Red', []], ['Cellar Cask White', []],
      ['Kingfisher', []],
      ['4th Street Red', [750]], ['4th Street White', [750]],
      ['Caprice Sweet White', []],
    ],
  },
  'Soft Drink / Other': {
    items: [
      ['Atlas Can', []], ['Monster Can', []], ['Gordons Can', []],
      ['OJ Can', []], ['Lemonade Can', []],
      ['Predator', []], ['Dallas', []], ['Ukwaju', []],
      ['Safari H2O', [1000]],
      ['Soda', [300, 350, 500]],
      ['Soda 1.25L', []],
      ['Hunters', []], ['Hunters Gold', []], ['Delmonte', []],
      ['Black Label', []], ['Savannah', []], ['Punch', []], ['Guarana', []],
      ['Black Ice Can', []], ['Red Bull', []], ['Black Label (2)', []],
      ['John Bar', []], ['Sportman', []],
    ],
  },
};

// ============================================================================
// STEP 1: Backup Existing Database
// ============================================================================
function backupDatabase() {
  console.log('📦 Creating backup...');
  
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, BACKUP_PATH);
    console.log(`✅ Backup created: ${BACKUP_PATH}`);
    return true;
  } else {
    console.log('ℹ️ No existing database found. Skipping backup.');
    return false;
  }
}

// ============================================================================
// STEP 2: Delete Existing Database
// ============================================================================
function deleteDatabase() {
  console.log('🗑️ Removing existing database...');
  
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log('✅ Database deleted');
    return true;
  } else {
    console.log('ℹ️ No existing database to delete.');
    return false;
  }
}

// ============================================================================
// STEP 3: Create Fresh Database with Schema
// ============================================================================
function createFreshDatabase() {
  console.log('📊 Creating fresh database...');
  
  // This will run the schema creation from db.js
  require('./src/db');
  
  console.log('✅ Fresh database created with schema');
}

// ============================================================================
// STEP 4: Seed Helper Functions
// ============================================================================
function getDb() {
  return new Database(DB_PATH);
}

function ensureRole(db, name, permissions) {
  const existing = db.prepare('SELECT * FROM roles WHERE name = ?').get(name);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO roles (name, permissions) VALUES (?, ?)').run(name, JSON.stringify(permissions));
  return { id: info.lastInsertRowid, name };
}

function ensureUser(db, name, username, phone, password, roleId, maxDiscount = 0) {
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing) return existing;
  
  // Use bcryptjs to match auth.js
  const passwordHash = bcrypt.hashSync(password, 10);
  
  const info = db.prepare(`
    INSERT INTO users (name, username, phone, password_hash, role_id, max_discount_percent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, username, phone, passwordHash, roleId, maxDiscount);
  return { id: info.lastInsertRowid, username };
}

function ensureCategory(db, name) {
  const existing = db.prepare('SELECT * FROM categories WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid;
}

function ensureSetting(db, key, value) {
  const existing = db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
  if (existing) return;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// ============================================================================
// STEP 5: Seed Products
// ============================================================================
function seedProducts(db, users) {
  let created = 0;
  
  for (const [categoryName, group] of Object.entries(RAW_CATALOGUE)) {
    const categoryId = ensureCategory(db, categoryName);
    const isSpiritCategory = categoryName === 'Spirit';
    
    for (const [baseName, sizes] of group.items) {
      const sizeList = sizes.length ? sizes : [null];
      
      for (const size of sizeList) {
        const name = size ? `${baseName} ${size}ML` : baseName;
        const existing = db.prepare('SELECT id FROM products WHERE name = ?').get(name);
        if (existing) continue;

        const volumeMl = size || 1;
        const allowServing = isSpiritCategory && size ? 1 : 0;

        // Placeholder pricing
        const costPerMl = isSpiritCategory ? 1.4 : (categoryName === 'Wine' ? 0.6 : 0.3);
        const bottleCost = Math.round(volumeMl * costPerMl) || 80;
        const bottlePrice = Math.round(bottleCost * 1.55) || 150;

        const info = db.prepare(`
          INSERT INTO products
            (sku, name, brand, category_id, volume_ml, min_stock_level, reorder_level,
             track_inventory, allow_credit, allow_discount, allow_serving, active)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 1, ?, 1)
        `).run(
          `SKU-${String(created + 1).padStart(4, '0')}`,
          name, baseName, categoryId, volumeMl, 3, 6, allowServing
        );
        const productId = info.lastInsertRowid;
        created++;

        // Selling units
        const units = [];
        if (volumeMl === 1) {
          units.push({ name: 'Piece', volume_ml: 1, price: bottlePrice, cost: bottleCost, sort: 0 });
        } else {
          units.push({ name: 'Bottle', volume_ml: volumeMl, price: bottlePrice, cost: bottleCost, sort: 0 });
          if (allowServing) {
            const halfMl = Math.round(volumeMl / 2);
            const halfCost = Math.round(bottleCost / 2);
            units.push({ name: 'Half', volume_ml: halfMl, price: Math.round(halfMl / volumeMl * bottlePrice * 1.1), cost: halfCost, sort: 1 });
            const totMl = Math.min(30, Math.floor(volumeMl / 4)) || 15;
            const totCost = Math.round((totMl / volumeMl) * bottleCost);
            units.push({ name: 'Tot', volume_ml: totMl, price: Math.max(Math.round((totMl / volumeMl) * bottlePrice * 1.3), totCost + 10), cost: totCost, sort: 2 });
          }
        }

        for (const u of units) {
          const suInfo = db.prepare(`
            INSERT INTO selling_units (product_id, name, volume_ml, active, sort_order)
            VALUES (?, ?, ?, 1, ?)
          `).run(productId, u.name, u.volume_ml, u.sort);
          db.prepare(`
            INSERT INTO product_prices (selling_unit_id, selling_price, cost_price, changed_by)
            VALUES (?, ?, ?, ?)
          `).run(suInfo.lastInsertRowid, u.price, u.cost, users.superAdmin.id);
        }

        // Use the ledger function from src/ledger
        appendInventoryLedger({
          productId, changeMl: 0, reason: 'ADJUSTMENT', refType: 'SEED', refId: null,
          userId: users.superAdmin.id, notes: 'Initial product creation (opening stock = 0)',
        });
      }
    }
  }
  return created;
}

// ============================================================================
// STEP 6: Main Reset and Seed Function
// ============================================================================
function main() {
  console.log('🔄 Starting database reset and seed...\n');
  
  // Step 1: Backup
  const hasBackup = backupDatabase();
  
  // Step 2: Delete
  deleteDatabase();
  
  // Step 3: Create fresh database
  createFreshDatabase();
  
  // Step 4: Seed data
  console.log('\n🌱 Seeding data...');
  const db = getDb();
  
  // Create roles
  const superAdminRole = ensureRole(db, 'SUPER_ADMIN', PERMISSIONS.SUPER_ADMIN);
  const adminRole = ensureRole(db, 'ADMIN', PERMISSIONS.ADMIN);
  const waiterRole = ensureRole(db, 'WAITER', PERMISSIONS.WAITER);
  
  // Create users
  const superAdmin = ensureUser(db, 'Shop Owner', 'admin', '0700000000', 'ChangeMe123!', superAdminRole.id, 100);
  const waiter1 = ensureUser(db, 'Waiter One', 'waiter1', '0711111111', 'Waiter123!', waiterRole.id, 0);
  const waiter2 = ensureUser(db, 'Waiter Two', 'waiter2', '0722222222', 'Waiter123!', waiterRole.id, 0);
  ensureUser(db, 'Shift Manager', 'manager', '0733333333', 'Manager123!', adminRole.id, 15);
  
  // Create settings
  ensureSetting(db, 'currency', 'KES');
  ensureSetting(db, 'currency_decimals', '0');
  ensureSetting(db, 'default_tot_ml', '30');
  ensureSetting(db, 'default_credit_limit', '5000');
  ensureSetting(db, 'waiter_credit_requires_approval_above', '3000');
  ensureSetting(db, 'business_name', 'Infinity Liquors');
  
  // Seed products
  const created = seedProducts(db, { superAdmin });
  
  // Write audit log
  writeAudit({ 
    event: 'SYSTEM_SEED', 
    userId: superAdmin.id, 
    role: 'SUPER_ADMIN', 
    entityType: 'SYSTEM', 
    reason: `Seeded ${created} products, 3 roles, 4 users` 
  });
  
  db.close();
  
  // ============================================================================
  // STEP 7: Summary
  // ============================================================================
  console.log('\n✅ Seed complete!');
  console.log('=' .repeat(50));
  console.log(`  Roles:   SUPER_ADMIN, ADMIN, WAITER`);
  console.log(`  Users:   admin / ChangeMe123!  (Super Admin)`);
  console.log(`           manager / Manager123! (Admin)`);
  console.log(`           waiter1 / Waiter123!  (Waiter)`);
  console.log(`           waiter2 / Waiter123!  (Waiter)`);
  console.log(`  Products created: ${created}`);
  console.log(`  NOTE: opening stock is 0 for all products and prices are placeholders.`);
  console.log(`  Log in as admin -> Stock Receiving (or Stocktake) to set real starting stock.`);
  console.log(`  Admin -> Products to correct prices before going live.`);
  console.log('=' .repeat(50));
  
  if (hasBackup) {
    console.log(`\n💾 Backup saved at: ${BACKUP_PATH}`);
    console.log('   To restore: copy the backup file to infinity.db');
  }
}

// ============================================================================
// RUN
// ============================================================================
main();