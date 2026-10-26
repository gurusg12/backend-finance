const jwt = require('jsonwebtoken');
const Company = require('../lib/company');
const { getTenantDb } = require('../db/tenant');

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const token = auth.split(' ')[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// For every company/agent request:
//   1. checks the company is active
//   2. opens THAT company's own SQLite file and puts it on req.db
// All tenant routes use req.db, so they can only ever touch their own company's data.
function tenantGuard(req, res, next) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role !== 'admin' && user.role !== 'agent') return res.status(403).json({ error: 'Forbidden: tenant access only' });
  if (!user.companyId) return res.status(403).json({ error: 'Company context missing' });
  try {
    const company = Company.findById(user.companyId);
    if (!company || !company.isActive) return res.status(403).json({ error: 'Company suspended or not found' });
    req.companyId = user.companyId;
    req.db = getTenantDb(user.companyId);
    return next();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function companyAdminOnly(req, res, next) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role === 'admin' || user.role === 'superadmin') return next();
  return res.status(403).json({ error: 'Forbidden: admin only' });
}

function superAdminOnly(req, res, next) {
  const user = req.user;
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  if (user.role === 'superadmin') return next();
  return res.status(403).json({ error: 'Forbidden: superadmin only' });
}

module.exports = { authMiddleware, tenantGuard, companyAdminOnly, superAdminOnly };
