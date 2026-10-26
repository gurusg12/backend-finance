const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const Company  = require('../lib/company');
const M        = require('../lib/mappers');
const { newId, nowISO } = require('../db/driver');
const { getTenantDb, tenantFile } = require('../db/tenant');
const { seedTenant } = require('../lib/seed');
const Config   = require('../lib/config');
const { nextAgentCode } = require('../lib/agentCode');
const { authMiddleware, superAdminOnly } = require('../middleware/auth');

const PLAN_LIMITS = {
  trial:    { maxAgents: 2,   maxCustomers: 100,   label: 'Trial (20 days)' },
  basic:    { maxAgents: 5,   maxCustomers: 500,   label: 'Basic' },
  standard: { maxAgents: 15,  maxCustomers: 2000,  label: 'Standard' },
  premium:  { maxAgents: 100, maxCustomers: 99999, label: 'Premium' },
};
const PLAN_DURATIONS = { trial: 20, basic: 365, standard: 365, premium: 365 };

// GET all companies
router.get('/', authMiddleware, superAdminOnly, (req, res) => {
  try { res.json(Company.listAll().map(c => Company.toJSON(c))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /activity/reports — platform-wide analytics (Super Admin)
// (declared before '/:id' so "activity" is never mistaken for an id)
// ─────────────────────────────────────────────────────────────────────────
router.get('/activity/reports', authMiddleware, superAdminOnly, (req, res) => {
  try {
    const companies = Company.listAll();

    const planDistribution = {};
    companies.forEach(c => { planDistribution[c.plan] = (planDistribution[c.plan] || 0) + 1; });

    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        label: d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }), count: 0,
      });
    }
    companies.forEach(c => {
      const d = new Date(c.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const m = months.find(m => m.key === key);
      if (m) m.count++;
    });

    // Each company has its own database → count inside each one and add up
    let totalCustomers = 0, totalTransactions = 0, totalAgents = 0;
    const perCompany = companies.map(c => {
      const db = getTenantDb(c.id);
      const tx = db.get('SELECT COUNT(*) AS n, COALESCE(SUM(amt),0) AS vol FROM transactions');
      totalCustomers    += db.get('SELECT COUNT(*) AS n FROM customers').n;
      totalAgents       += db.get('SELECT COUNT(*) AS n FROM agents WHERE isActive = 1').n;
      totalTransactions += tx.n;
      return { name: c.name, plan: c.plan, transactions: tx.n, volume: tx.vol };
    });
    const topCompanies = perCompany
      .filter(c => c.transactions > 0)
      .sort((a, b) => b.transactions - a.transactions)
      .slice(0, 5);

    res.json({
      planDistribution, signupsTrend: months, topCompanies,
      totals: { companies: companies.length, customers: totalCustomers, transactions: totalTransactions, agents: totalAgents },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /activity/usage — one row per company: size, activity and book totals
// (feeds the Tenant Usage / Inactive Tenants / Trial Tracker reports)
// ─────────────────────────────────────────────────────────────────────────
router.get('/activity/usage', authMiddleware, superAdminOnly, (req, res) => {
  try {
    const rows = Company.listAll().map(c => {
      const db = getTenantDb(c.id);
      const one = (sql) => db.get(sql);
      const tx = one('SELECT COUNT(*) AS n, MAX(date) AS lastDate, MAX(createdAt) AS lastAt, COALESCE(SUM(amt),0) AS volume FROM transactions');
      const book = type => one(
        `SELECT COUNT(*) AS n, COALESCE(SUM(a.balance),0) AS total FROM accounts a
           JOIN groups g ON g.name = a.grp
          WHERE a.category = 'customer' AND a.status = 'active' AND g.type = '${type}'`);
      const loans = book('Asset'), deposits = book('Liability');
      let dbSize = 0;
      try { dbSize = fs.statSync(tenantFile(c.id)).size; } catch (_) {}
      return {
        _id: c.id, name: c.name, plan: c.plan, isActive: c.isActive, city: c.city,
        email: c.email, emailVerified: !!c.emailVerified, createdAt: c.createdAt,
        subscriptionEnd: c.subscriptionEnd, daysRemaining: Company.daysRemaining(c),
        selfRegistered: /Self-registered/.test(c.notes || ''),
        grandTotal: c.billing.grandTotal, paidAmount: c.paidAmount, paymentStatus: c.paymentStatus,
        customers: one('SELECT COUNT(*) AS n FROM customers').n,
        agents: one('SELECT COUNT(*) AS n FROM agents WHERE isActive = 1').n,
        loanAccounts: loans.n, loanOutstanding: loans.total,
        depositAccounts: deposits.n, depositBalance: deposits.total,
        transactions: tx.n, txVolume: tx.volume, lastTxDate: tx.lastDate, lastActivityAt: tx.lastAt,
        dbSizeKB: Math.round(dbSize / 1024),
      };
    });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single company
router.get('/:id', authMiddleware, superAdminOnly, (req, res) => {
  try {
    const company = Company.findById(req.params.id);
    if (!company) return res.status(404).json({ error: 'Not found' });
    res.json(Company.toJSON(company));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET company stats
router.get('/:id/stats', authMiddleware, superAdminOnly, (req, res) => {
  try {
    if (!Company.findById(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const db = getTenantDb(req.params.id);
    res.json({
      customers:    db.get('SELECT COUNT(*) AS n FROM customers').n,
      transactions: db.get('SELECT COUNT(*) AS n FROM transactions').n,
      agents:       db.get('SELECT COUNT(*) AS n FROM agents WHERE isActive = 1').n,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET / PUT /:id/config — a company's default loan / deposit / pigmy terms (interest, late fee, grace …)
router.get('/:id/config', authMiddleware, superAdminOnly, (req, res) => {
  try {
    if (!Company.findById(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(Config.getConfig(getTenantDb(req.params.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.put('/:id/config', authMiddleware, superAdminOnly, (req, res) => {
  try {
    if (!Company.findById(req.params.id)) return res.status(404).json({ error: 'Not found' });
    res.json(Config.saveConfig(getTenantDb(req.params.id), req.body || {}));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// GET /:id/backup — download a consistent copy of the company's SQLite database
router.get('/:id/backup', authMiddleware, superAdminOnly, (req, res) => {
  try {
    const company = Company.findById(req.params.id);
    if (!company) return res.status(404).json({ error: 'Not found' });
    const tmp = path.join(os.tmpdir(), `finsphere-${company.id}-${Date.now()}.db`);
    getTenantDb(company.id).exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);   // safe even while the app is running
    const safe = company.name.replace(/[^A-Za-z0-9_-]+/g, '_');
    res.download(tmp, `${safe}-${new Date().toISOString().slice(0, 10)}.db`, () => fs.unlink(tmp, () => {}));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create company  → also creates the company's OWN database file
router.post('/', authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { name, adminUsername, adminPassword, email, mobile, address, city,
            state, pincode, website, adminName, businessType, plan, notes,
            subscriptionDays, billing } = req.body;

    if (!name || !adminUsername || !adminPassword)
      return res.status(400).json({ error: 'Name, username and password are required' });
    if (Company.findByName(name)) return res.status(400).json({ error: 'Company name already exists' });
    if (Company.findByAdminUsername(adminUsername)) return res.status(400).json({ error: 'Admin username already used by another company' });
    if (email && Company.findByEmail(email)) return res.status(400).json({ error: 'This email is already used by another company' });

    const selectedPlan = plan || 'trial';
    const limits = PLAN_LIMITS[selectedPlan] || PLAN_LIMITS.trial;
    const days   = subscriptionDays ? parseInt(subscriptionDays) : PLAN_DURATIONS[selectedPlan];
    const hash   = await bcrypt.hash(adminPassword, 10);

    const company = Company.insert({
      name: name.trim(), adminUsername, adminPasswordHash: hash,
      email: email || '', mobile: mobile || '', address: address || '', city: city || '',
      state: state || '', pincode: pincode || '', website: website || '', adminName: adminName || '',
      businessType: businessType || 'Finance', plan: selectedPlan,
      subscriptionStart: nowISO(),
      subscriptionEnd: new Date(Date.now() + days * 86400000).toISOString(),
      maxAgents: limits.maxAgents, maxCustomers: limits.maxCustomers,
      notes: notes || '', billing: billing || {},
    });

    // Create this company's private database file and put the default data in it
    seedTenant(getTenantDb(company.id));

    res.status(201).json({ message: 'Company created successfully', company: Company.toJSON(company) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update company
router.put('/:id', authMiddleware, superAdminOnly, async (req, res) => {
  try {
    const { name, adminUsername, adminPassword, email, mobile, address, city,
            state, pincode, website, adminName, businessType, isActive,
            suspendReason, notes, billing } = req.body;

    const company = Company.findById(req.params.id);
    if (!company) return res.status(404).json({ error: 'Not found' });

    if (name !== undefined) {
      const dup = Company.findByName(name);
      if (dup && dup.id !== company.id) return res.status(400).json({ error: 'Company name already exists' });
    }
    if (adminUsername !== undefined) {
      const dup = Company.findByAdminUsername(adminUsername);
      if (dup && dup.id !== company.id) return res.status(400).json({ error: 'Admin username already used by another company' });
    }

    if (email !== undefined && String(email).trim().toLowerCase() !== String(company.email || '').toLowerCase()) {
      const dup = Company.findByEmail(email);
      if (dup && dup.id !== company.id) return res.status(400).json({ error: 'This email is already used by another company' });
      company.emailVerified = false;                // a new address must be verified again
    }

    const update = { name, adminUsername, email, mobile, address, city, state,
                     pincode, website, adminName, businessType, isActive, suspendReason, notes };
    Object.keys(update).forEach(k => { if (update[k] !== undefined) company[k] = update[k]; });

    // Partial billing updates are merged into the existing billing data
    if (billing) company.billing = { ...company.billing, ...billing };
    if (adminPassword) company.adminPasswordHash = await bcrypt.hash(adminPassword, 10);

    const saved = Company.save(company);   // recalculates grandTotal / paymentStatus
    res.json({ message: 'Updated successfully', company: Company.toJSON(saved) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT renew / change subscription
//   { plan, days }     → extend from current expiry (or today if expired) by N days
//   { plan, endDate }  → set subscriptionEnd to this exact date
router.put('/:id/subscription', authMiddleware, superAdminOnly, (req, res) => {
  try {
    const { plan, days, endDate } = req.body;
    const company = Company.findById(req.params.id);
    if (!company) return res.status(404).json({ error: 'Not found' });

    const selectedPlan = plan || company.plan;
    const limits = PLAN_LIMITS[selectedPlan] || PLAN_LIMITS.basic;
    const wasExpired = Company.isExpired(company);

    let newEnd;
    if (endDate) {
      newEnd = new Date(endDate);
      if (isNaN(newEnd.getTime())) return res.status(400).json({ error: 'Invalid endDate' });
    } else {
      const addDays = parseInt(days) || PLAN_DURATIONS[selectedPlan];
      const base = wasExpired ? new Date() : new Date(company.subscriptionEnd);
      newEnd = new Date(base.getTime() + addDays * 86400000);
    }

    company.plan = selectedPlan;
    company.subscriptionEnd = newEnd.toISOString();
    if (wasExpired) company.subscriptionStart = nowISO();
    company.maxAgents = limits.maxAgents;
    company.maxCustomers = limits.maxCustomers;
    company.isActive = true;
    company.suspendReason = '';
    const saved = Company.save(company);

    res.json({ message: `Subscription renewed until ${newEnd.toLocaleDateString()}`, company: Company.toJSON(saved) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE (soft deactivate — the company's database file is kept)
router.delete('/:id', authMiddleware, superAdminOnly, (req, res) => {
  try {
    const company = Company.findById(req.params.id);
    if (!company) return res.status(404).json({ error: 'Not found' });
    company.isActive = false;
    company.suspendReason = (req.body && req.body.reason) || 'Suspended by admin';
    Company.save(company);
    res.json({ message: 'Company suspended' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /:id/billing-payment
// Records a Receipt/Payment against a company's platform Fixed Balance.
router.post('/:id/billing-payment', authMiddleware, superAdminOnly, (req, res) => {
  try {
    const { type, amount, mode, remarks, date } = req.body;
    if (!['receipt', 'payment'].includes(type)) return res.status(400).json({ error: 'type must be receipt or payment' });
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const company = Company.findById(req.params.id);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    company.paidAmount = (company.paidAmount || 0) + (type === 'receipt' ? amt : -amt);
    if (company.paidAmount < 0) company.paidAmount = 0;

    company.billing.paymentHistory.push({
      type, amount: amt, mode: mode || 'cash', remarks: remarks || '',
      date: date || nowISO(), recordedAt: nowISO(),
    });

    const saved = Company.save(company);
    const json = Company.toJSON(saved);
    res.json({
      message: `${type === 'receipt' ? 'Receipt' : 'Payment'} of ₹${amt} recorded`,
      paidAmount: json.paidAmount, remainingAmount: json.remainingAmount, paymentStatus: json.paymentStatus,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /companies/:id/agents
// Super Admin creates an agent inside a company's own database.
router.post('/:id/agents', authMiddleware, superAdminOnly, async (req, res) => {
  try {
    if (!Company.findById(req.params.id)) return res.status(404).json({ error: 'Company not found' });
    const db = getTenantDb(req.params.id);

    const { username, password, name, email, mobile, address, typeCommissions, validFrom, validTill, duration } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    if (db.get('SELECT id FROM agents WHERE username = ? COLLATE NOCASE', username.trim()))
      return res.status(400).json({ error: 'Username already exists for this company' });

    const passwordHash = await bcrypt.hash(password, 10);
    const id = newId();
    db.tx(() => {
      db.run(
        `INSERT INTO agents (id, agentCode, username, passwordHash, name, email, mobile, address, typeCommissions,
                             validFrom, validTill, durationValue, durationType, isActive, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        id, nextAgentCode(db), username.trim(), passwordHash, name || '', email || '', mobile || '', address || '',
        JSON.stringify(Array.isArray(typeCommissions)
          ? typeCommissions.filter(r => r.typeName).map(r => ({ typeName: r.typeName, rate: parseFloat(r.rate) || 0 })) : []),
        validFrom || nowISO(), validTill || null,
        parseInt(duration?.value) || 1, duration?.type || 'years', nowISO());
    });
    res.status(201).json(M.loadAgents(db, 'WHERE id = ?', [id])[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
