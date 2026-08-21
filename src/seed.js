/**
 * Seeds roles, default users, categories, and the product catalogue
 * transcribed from the "Infinity Liquors" manual stock book photos.
 *
 * IMPORTANT: prices below are PLACEHOLDERS (a simple formula based on
 * bottle size), because the stock book photos record quantities, not
 * prices. The margin scribbles in the photo (1000, 350, 150, 660...) are
 * not reliably attributable to specific product rows, so they were not
 * used. Update real prices from Admin -> Products before going live.
 *
 * NOTE: this only runs on a fresh database (no .seeded marker on disk,
 * per the Dockerfile's boot sequence). It does NOT rename or update users
 * that already exist — for renaming an already-seeded live user, use
 * src/scripts/renameUser.js instead.
 *
 * Run: npm run seed   (safe to re-run; it skips rows that already exist)
 */
const db = require('./db');
const { hashPassword } = require('./auth');
const { appendInventoryLedger, writeAudit } = require('./ledger');

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

function ensureRole(name, permissions) {
  const existing = db.prepare('SELECT * FROM roles WHERE name = ?').get(name);
  if (existing) return existing;
  const info = db.prepare('INSERT INTO roles (name, permissions) VALUES (?, ?)').run(name, JSON.stringify(permissions));
  return { id: info.lastInsertRowid, name };
}

function ensureUser(name, username, phone, password, roleId, maxDiscount = 0) {
  const existing = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (existing) return existing;
  const info = db.prepare(`
    INSERT INTO users (name, username, phone, password_hash, role_id, max_discount_percent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, username, phone, hashPassword(password), roleId, maxDiscount);
  return { id: info.lastInsertRowid, username };
}

function ensureCategory(name) {
  const existing = db.prepare('SELECT * FROM categories WHERE name = ?').get(name);
  if (existing) return existing.id;
  return db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid;
}

function ensureSetting(key, value) {
  const existing = db.prepare('SELECT * FROM settings WHERE key = ?').get(key);
  if (existing) return;
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// name -> [sizes in ml] ; sizes = [] means "piece" (no declared volume in the book)
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
      ['Richot', []],
      ['Richot', [250, 750]],
      ['Black & White', [250, 375, 750]],
      ['Jinro', []],
      ['Viceroy', [250, 350, 750]],
      ['County', []],
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

function seedProducts(users) {
  let created = 0;
  for (const [categoryName, group] of Object.entries(RAW_CATALOGUE)) {
    const categoryId = ensureCategory(categoryName);
    const isSpiritCategory = categoryName === 'Spirit';
    for (const [baseName, sizes] of group.items) {
      const sizeList = sizes.length ? sizes : [null]; // null = "piece" product
      for (const size of sizeList) {
        const name = size ? `${baseName} ${size}ML` : baseName;
        const existing = db.prepare('SELECT id FROM products WHERE name = ?').get(name);
        if (existing) continue;

        const volumeMl = size || 1;
        const allowServing = isSpiritCategory && size ? 1 : 0;

        // Placeholder pricing formula (documented above) — admin must correct.
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

        // Opening stock = 0. Admin should do an initial stock receipt / stocktake
        // to bring the digital ledger in line with the physical shop count.
        appendInventoryLedger({
          productId, changeMl: 0, reason: 'ADJUSTMENT', refType: 'SEED', refId: null,
          userId: users.superAdmin.id, notes: 'Initial product creation (opening stock = 0, set via stock receipt or stocktake)',
        });
      }
    }
  }
  return created;
}

function main() {
  const superAdminRole = ensureRole('SUPER_ADMIN', PERMISSIONS.SUPER_ADMIN);
  const adminRole = ensureRole('ADMIN', PERMISSIONS.ADMIN);
  const waiterRole = ensureRole('WAITER', PERMISSIONS.WAITER);

  // Create users with real names as usernames
  const superAdmin = ensureUser('Moh', 'Moh', '0700000000', 'Moh001', superAdminRole.id, 100);
  const admin = ensureUser('Agnes Mweni', 'agnesmweni', '0733333333', 'Manager123!', adminRole.id, 15);
  const waiter1 = ensureUser('Dama', 'Dama', '0711111111', 'Dama123', waiterRole.id, 0);
  const waiter2 = ensureUser('Joy', 'Joy', '0722222222', 'Joy254', waiterRole.id, 0);

  ensureSetting('currency', 'KES');
  ensureSetting('currency_decimals', '0');
  ensureSetting('default_tot_ml', '30');
  ensureSetting('default_credit_limit', '5000');
  ensureSetting('waiter_credit_requires_approval_above', '3000');
  ensureSetting('business_name', 'Infinity Liquors');

  const created = seedProducts({ superAdmin });

  writeAudit({ event: 'SYSTEM_SEED', userId: superAdmin.id, role: 'SUPER_ADMIN', entityType: 'SYSTEM', reason: `Seeded ${created} products, ${3} roles, ${4} users` });

  console.log(`Seed complete.`);
  console.log(`  Roles:   SUPER_ADMIN, ADMIN, WAITER`);
  console.log(`  Users:   Moh / Moh001            (Super Admin)`);
  console.log(`           agnesmweni / Manager123! (Admin)`);
  console.log(`           Dama / Dama123           (Waiter)`);
  console.log(`           Joy / Joy254              (Waiter)`);
  console.log(`  Products created: ${created}`);
  console.log(`  NOTE: opening stock is 0 for all products and prices are placeholders.`);
  console.log(`  Log in as admin -> Stock Receiving (or Stocktake) to set real starting stock,`);
  console.log(`  and Admin -> Products to correct prices before going live.`);
}

main();