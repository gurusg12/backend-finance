const express = require('express');
const router = express.Router();
const Config = require('../lib/config');
const { authMiddleware, tenantGuard, companyAdminOnly } = require('../middleware/auth');

// Everyone in the company (admin + agents) can READ the defaults — the forms use them.
router.get('/', authMiddleware, tenantGuard, (req, res) => {
  try { res.json(Config.getConfig(req.db)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Only the company admin can change them.
router.put('/', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try { res.json(Config.saveConfig(req.db, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

module.exports = router;
