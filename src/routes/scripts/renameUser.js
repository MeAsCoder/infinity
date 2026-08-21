// src/scripts/renameUser.js
//
// Renames an existing user's username/name and resets their password.
// Run this directly against the live database (e.g. via Render's Shell tab) —
// it is NOT part of the seed flow and does not run automatically.
//
// Usage:
//   node src/scripts/renameUser.js <currentUsername> <newUsername> "<newName>" <newPassword>
//
// Example:
//   node src/scripts/renameUser.js janethwambui Moh "Moh" Moh001
//
const db = require('../db');
const { hashPassword } = require('../auth');

const [, , currentUsername, newUsername, newName, newPassword] = process.argv;

if (!currentUsername || !newUsername || !newName || !newPassword) {
  console.error('Usage: node src/scripts/renameUser.js <currentUsername> <newUsername> "<newName>" <newPassword>');
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE username = ?').get(currentUsername);
if (!user) {
  console.error(`No user found with username "${currentUsername}"`);
  process.exit(1);
}

const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(newUsername, user.id);
if (clash) {
  console.error(`Username "${newUsername}" is already taken by user #${clash.id}`);
  process.exit(1);
}

db.prepare('UPDATE users SET username = ?, name = ?, password_hash = ? WHERE id = ?')
  .run(newUsername, newName, hashPassword(newPassword), user.id);

console.log(`Updated user #${user.id}: "${currentUsername}" -> "${newUsername}" (name: "${newName}")`);