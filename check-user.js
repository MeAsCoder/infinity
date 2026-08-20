const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'infinity.db');
const db = new Database(DB_PATH);

console.log('🔍 Checking database users...\n');

// Check waiter1
const user = db.prepare('SELECT * FROM users WHERE username = ?').get('waiter1');
console.log('User "waiter1" found:', user ? '✅ Yes' : '❌ No');

if (user) {
  console.log('\nUser details:');
  console.log('  ID:', user.id);
  console.log('  Name:', user.name);
  console.log('  Username:', user.username);
  console.log('  Role ID:', user.role_id);
  console.log('  Active:', user.active ? 'Yes' : 'No');
  console.log('  Password hash:', user.password_hash ? 'Present (length: ' + user.password_hash.length + ')' : 'Missing');
  
  const testPassword = 'Waiter123!';
  const isValid = bcrypt.compareSync(testPassword, user.password_hash);
  console.log('\n🔑 Password "' + testPassword + '" is valid:', isValid ? '✅ Yes' : '❌ No');
  
  if (!isValid) {
    console.log('\n🔧 Re-hashing password...');
    const newHash = bcrypt.hashSync(testPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
    console.log('✅ Password updated. Try logging in again.');
  }
} else {
  console.log('\n❌ User "waiter1" not found!');
}

// Check admin
console.log('\n--- Checking Admin ---');
const admin = db.prepare('SELECT * FROM users WHERE username = ?').get('admin');
console.log('User "admin" found:', admin ? '✅ Yes' : '❌ No');

if (admin) {
  const isValid = bcrypt.compareSync('ChangeMe123!', admin.password_hash);
  console.log('🔑 Password "ChangeMe123!" is valid:', isValid ? '✅ Yes' : '❌ No');
  
  if (!isValid) {
    console.log('\n🔧 Re-hashing admin password...');
    const newHash = bcrypt.hashSync('ChangeMe123!', 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, admin.id);
    console.log('✅ Admin password updated.');
  }
}

// List all users
console.log('\n--- All Users in Database ---');
const allUsers = db.prepare('SELECT id, username, name, role_id, active FROM users').all();
console.table(allUsers);

db.close();