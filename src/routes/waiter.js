// backend/src/routes/waiter.js
const express = require('express');
const router = express.Router();
const db = require('../db');
const { authMiddleware } = require('../auth');
const { requirePermission } = require('../middleware/rbac');
const { writeAudit } = require('../ledger');

router.use(authMiddleware);

// GET /api/waiter/patterns/:waiterId - Get patterns for a specific waiter
router.get('/patterns/:waiterId', (req, res) => {
  try {
    const waiterId = parseInt(req.params.waiterId, 10);
    
    // Check if user is viewing their own patterns or has admin permissions
    if (req.user.id !== waiterId && !req.user.permissions.includes('shifts.view_all') && !req.user.permissions.includes('*')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    
    const patterns = db.prepare(`
      SELECT * FROM waiver_patterns 
      WHERE waiter_id = ? AND resolved_at IS NULL
      ORDER BY detected_at DESC
    `).all(waiterId);
    
    // Get waiter name
    const waiter = db.prepare('SELECT name FROM users WHERE id = ?').get(waiterId);
    
    const result = patterns.map(p => ({
      ...p,
      waiter_name: waiter?.name || 'Unknown'
    }));
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching patterns:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/waiter/patterns/alerts - Get all unresolved patterns (admin only)
router.get('/patterns/alerts', requirePermission('shifts.view_all'), (req, res) => {
  try {
    const patterns = db.prepare(`
      SELECT wp.*, u.name AS waiter_name
      FROM waiver_patterns wp
      JOIN users u ON u.id = wp.waiter_id
      WHERE wp.resolved_at IS NULL
      ORDER BY wp.score DESC, wp.detected_at DESC
      LIMIT 50
    `).all();
    
    res.json(patterns);
  } catch (error) {
    console.error('Error fetching pattern alerts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/waiter/patterns/:patternId/resolve - Resolve a pattern (admin only)
router.post('/patterns/:patternId/resolve', requirePermission('shifts.view_all'), (req, res) => {
  try {
    const patternId = req.params.patternId;
    const { notes } = req.body;
    
    const pattern = db.prepare('SELECT * FROM waiver_patterns WHERE id = ?').get(patternId);
    if (!pattern) {
      return res.status(404).json({ error: 'Pattern not found' });
    }
    
    db.prepare(`
      UPDATE waiver_patterns 
      SET resolved_at = datetime('now'), details = COALESCE(details || ' ', '') || ?
      WHERE id = ?
    `).run(notes || 'Resolved by admin', patternId);
    
    writeAudit({
      event: 'PATTERN_RESOLVED',
      userId: req.user.id,
      role: req.user.role,
      entityType: 'WAIVER_PATTERN',
      entityId: patternId,
      newValue: { notes: notes || null, pattern_type: pattern.pattern_type },
    });
    
    res.json({ success: true, message: 'Pattern resolved successfully' });
  } catch (error) {
    console.error('Error resolving pattern:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;