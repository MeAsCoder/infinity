const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware, hashPassword } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { writeAudit } = require('../ledger');

router.use(authMiddleware);
router.use(requirePermission('users.manage', '*'));

// GET /api/users - Get all users with optional role filter
router.get('/', (req, res) => {
  const { role } = req.query;
  let sql = `
    SELECT u.id, u.name, u.username, u.phone, u.active, u.max_discount_percent, r.name AS role
    FROM users u 
    JOIN roles r ON r.id = u.role_id 
    WHERE 1=1
  `;
  const params = [];
  
  if (role) {
    sql += ` AND r.name = ?`;
    params.push(role);
  }
  
  sql += ` ORDER BY u.name`;
  
  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// GET /api/users/roles
router.get('/roles', (req, res) => {
  res.json(db.prepare('SELECT id, name, permissions FROM roles').all().map(r => ({ ...r, permissions: JSON.parse(r.permissions) })));
});

// GET /api/users/:id - Get a specific user
router.get('/:id', (req, res) => {
  const user = db.prepare(`
    SELECT u.id, u.name, u.username, u.phone, u.active, u.max_discount_percent, r.name AS role, r.permissions
    FROM users u 
    JOIN roles r ON r.id = u.role_id 
    WHERE u.id = ?
  `).get(req.params.id);
  
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  user.permissions = JSON.parse(user.permissions || '[]');
  res.json(user);
});

// POST /api/users - Create a new user
router.post('/', (req, res) => {
  const { name, username, phone, password, roleName, maxDiscountPercent } = req.body;
  if (!name || !username || !password || !roleName) return res.status(400).json({ error: 'name, username, password, roleName required' });
  const role = db.prepare('SELECT * FROM roles WHERE name = ?').get(roleName);
  if (!role) return res.status(400).json({ error: 'Unknown role' });
  try {
    const info = db.prepare(`
      INSERT INTO users (name, username, phone, password_hash, role_id, max_discount_percent) VALUES (?, ?, ?, ?, ?, ?)
    `).run(name, username, phone || null, hashPassword(password), role.id, maxDiscountPercent || 0);
    writeAudit({ event: 'USER_CREATED', userId: req.user.id, role: req.user.role, entityType: 'USER', entityId: info.lastInsertRowid, newValue: { name, username, roleName } });
    res.status(201).json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(409).json({ error: 'Username already exists' });
  }
});

// PUT /api/users/:id - Update a user
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, phone, active, maxDiscountPercent, roleName, password } = req.body;
  let roleId = existing.role_id;
  if (roleName) {
    const role = db.prepare('SELECT * FROM roles WHERE name = ?').get(roleName);
    if (!role) return res.status(400).json({ error: 'Unknown role' });
    roleId = role.id;
  }
  db.prepare(`
    UPDATE users SET name=?, phone=?, active=?, max_discount_percent=?, role_id=${password ? ', password_hash=?' : ''} WHERE id = ?
  `).run(
    ...(password
      ? [name ?? existing.name, phone ?? existing.phone, active !== undefined ? (active ? 1 : 0) : existing.active, maxDiscountPercent ?? existing.max_discount_percent, roleId, hashPassword(password), req.params.id]
      : [name ?? existing.name, phone ?? existing.phone, active !== undefined ? (active ? 1 : 0) : existing.active, maxDiscountPercent ?? existing.max_discount_percent, roleId, req.params.id])
  );
  writeAudit({ event: 'USER_UPDATED', userId: req.user.id, role: req.user.role, entityType: 'USER', entityId: +req.params.id, oldValue: { active: existing.active, role_id: existing.role_id }, newValue: req.body });
  res.json({ ok: true });
});

// DELETE /api/users/:id - Delete a user (soft delete by setting active=0)
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  
  // Prevent deleting yourself
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  writeAudit({ event: 'USER_DELETED', userId: req.user.id, role: req.user.role, entityType: 'USER', entityId: +req.params.id });
  res.json({ ok: true });
});

module.exports = router;