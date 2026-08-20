/**
 * Server-side, permission-based authorization.
 * Every protected route declares the permission string it needs; the
 * frontend hiding a button is a UX nicety only — this is what actually
 * stops a malicious/curious user from calling the API directly.
 */
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const has = permissions.some(p => req.user.permissions.includes(p) || req.user.permissions.includes('*'));
    if (!has) {
      return res.status(403).json({ error: 'Forbidden: missing permission', required: permissions });
    }
    next();
  };
}

module.exports = { requirePermission };
