const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const Company = require('../lib/company');
const M       = require('../lib/mappers');
const { getTenantDb } = require('../db/tenant');
const { adminSession } = require('../lib/session');

const isSuperAdmin = (u, p) =>
  u === process.env.SUPER_ADMIN_USERNAME && p === process.env.SUPER_ADMIN_PASSWORD;

function superAdminResponse(username) {
  const token = jwt.sign({ role: 'superadmin', username }, process.env.JWT_SECRET, { expiresIn: '24h' });
  return { token, role: 'superadmin', username, companyName: 'Super Admin Panel' };
}

// Find an active agent by username inside ONE company's own database
function findAgent(companyId, username) {
  const db = getTenantDb(companyId);
  const list = M.loadAgents(db, 'WHERE username = ? COLLATE NOCASE AND isActive = 1', [username.trim()], { withHash: true });
  return list[0] || null;
}

function adminLogin(company, password) {
  return bcrypt.compare(password, company.adminPasswordHash).then(match => (match ? adminSession(company) : null));
}

async function agentLogin(company, agent, password) {
  const match = await bcrypt.compare(password, agent.passwordHash);
  if (!match) return null;
  const token = jwt.sign(
    { role: 'agent', companyId: company.id, agentId: agent._id, username: agent.username, companyName: company.name },
    process.env.JWT_SECRET, { expiresIn: '12h' });
  return {
    token, role: 'agent', username: agent.username, agentId: agent._id, companyId: company.id,
    companyName: company.name, logo: company.logo, plan: company.plan,
    daysRemaining: Company.daysRemaining(company), assignedAccounts: agent.assignedAccounts || [],
  };
}

const expired = (res, company) => res.status(403).json({
  error: 'Subscription expired. Please contact support.', code: 'SUBSCRIPTION_EXPIRED', expiredOn: company.subscriptionEnd,
});

// ── Super Admin Login ──────────────────────────────────────────────────────────
router.post('/superadmin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (isSuperAdmin(username, password)) return res.json(superAdminResponse(username));
    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Company Admin / Agent Login ────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { companyId, username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    // 1) Super Admin
    if (isSuperAdmin(username, password)) return res.json(superAdminResponse(username));

    // 2) Company chosen explicitly
    if (companyId) {
      const company = Company.findById(companyId);
      if (!company) return res.status(404).json({ error: 'Company not found' });
      if (!company.isActive) return res.status(403).json({ error: 'Company is suspended. Please contact support.' });
      if (Company.isExpired(company)) return res.status(403).json({ error: 'Subscription expired', code: 'SUBSCRIPTION_EXPIRED', expiredOn: company.subscriptionEnd });

      if (username.trim().toLowerCase() === company.adminUsername.toLowerCase()) {
        const out = await adminLogin(company, password);
        return out ? res.json(out) : res.status(401).json({ error: 'Invalid username or password' });
      }
      const agent = findAgent(company.id, username);
      if (!agent) return res.status(401).json({ error: 'Invalid username or password' });
      const out = await agentLogin(company, agent, password);
      return out ? res.json(out) : res.status(401).json({ error: 'Invalid username or password' });
    }

    // 3) No company given → look the username up everywhere
    //    a) company admin
    const company = Company.findByAdminUsername(username, true);
    if (company) {
      if (Company.isExpired(company)) return expired(res, company);
      const out = await adminLogin(company, password);
      return out ? res.json(out) : res.status(401).json({ error: 'Invalid username or password' });
    }

    //    b) agent — search each company's own database
    for (const c of Company.listAll()) {
      const agent = findAgent(c.id, username);
      if (!agent) continue;
      if (!c.isActive) return res.status(403).json({ error: 'Company account is suspended. Please contact support.' });
      if (Company.isExpired(c)) return expired(res, c);
      const out = await agentLogin(c, agent, password);
      return out ? res.json(out) : res.status(401).json({ error: 'Invalid username or password' });
    }

    return res.status(401).json({ error: 'Invalid username or password' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── List active companies for login dropdown ───────────────────────────────────
router.get('/companies', (req, res) => {
  try {
    res.json(Company.listActive().map(c => ({
      _id: c.id, name: c.name, logo: c.logo, city: c.city, plan: c.plan, daysRemaining: Company.daysRemaining(c),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
