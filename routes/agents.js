const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const M = require('../lib/mappers');
const { newId, nowISO, todayStr, placeholders } = require('../db/driver');
const { nextAgentCode } = require('../lib/agentCode');
const { authMiddleware, tenantGuard, companyAdminOnly } = require('../middleware/auth');

const cleanCommissions = list =>
  Array.isArray(list)
    ? list.filter(r => r.typeName).map(r => ({ typeName: r.typeName, rate: parseFloat(r.rate) || 0 }))
    : [];

const getAgent = (db, id) => M.loadAgents(db, 'WHERE id = ?', [id])[0] || null;

// GET all active agents
router.get('/', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    res.json(M.loadAgents(req.db, 'WHERE isActive = 1 ORDER BY rowid'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create agent
router.post('/', authMiddleware, tenantGuard, companyAdminOnly, async (req, res) => {
  try {
    const { username, password, mobile, address } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    if (req.db.get('SELECT id FROM agents WHERE username = ? COLLATE NOCASE', username.trim()))
      return res.status(400).json({ error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const id = newId();
    req.db.tx(() => {
      req.db.run(
        `INSERT INTO agents (id, agentCode, username, passwordHash, name, email, mobile, address, typeCommissions,
                             validFrom, validTill, durationValue, durationType, isActive, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        id, nextAgentCode(req.db), username.trim(), hash, req.body.name || '', req.body.email || '', mobile || '', address || '',
        JSON.stringify(cleanCommissions(req.body.typeCommissions)),
        req.body.validFrom || null, req.body.validTill || null,
        parseInt(req.body.duration?.value) || 1, req.body.duration?.type || 'years', nowISO());
    });
    res.status(201).json(getAgent(req.db, id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update agent
router.put('/:id', authMiddleware, tenantGuard, companyAdminOnly, async (req, res) => {
  try {
    const db = req.db;
    const existing = db.get('SELECT * FROM agents WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const { username, password, mobile, address } = req.body;
    const newUsername = username ? username.trim() : existing.username;
    if (db.get('SELECT id FROM agents WHERE id <> ? AND username = ? COLLATE NOCASE', existing.id, newUsername))
      return res.status(400).json({ error: 'Username already exists' });

    const hash = password ? await bcrypt.hash(password, 10) : existing.passwordHash;
    db.run(
      `UPDATE agents SET username = ?, passwordHash = ?, name = ?, email = ?, mobile = ?, address = ?,
              typeCommissions = ?, validFrom = ?, validTill = ?, durationValue = ?, durationType = ? WHERE id = ?`,
      newUsername, hash, req.body.name || '', req.body.email || '',
      mobile !== undefined ? mobile : existing.mobile, address !== undefined ? address : existing.address,
      JSON.stringify(cleanCommissions(req.body.typeCommissions)),
      req.body.validFrom || null, req.body.validTill || null,
      parseInt(req.body.duration?.value) || 1, req.body.duration?.type || 'years', existing.id);
    res.json(getAgent(db, existing.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE agent (deactivate)
router.delete('/:id', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    req.db.run('UPDATE agents SET isActive = 0 WHERE id = ?', req.params.id);
    res.json({ message: 'Agent deactivated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT assign accounts to agent
router.put('/:id/assign', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const db = req.db;
    const agent = db.get('SELECT id FROM agents WHERE id = ?', req.params.id);
    if (!agent) return res.status(404).json({ error: 'Not found' });

    const ids = Array.isArray(req.body.accountIds) ? req.body.accountIds : [];
    db.tx(() => {
      if (ids.length) {
        const valid = db.all(`SELECT id FROM accounts WHERE id IN ${placeholders(ids)}`, ...ids).map(a => a.id);
        valid.forEach(accId => db.run('INSERT OR IGNORE INTO agent_accounts (agentId, accountId) VALUES (?,?)', agent.id, accId));
      }
    });
    res.json(getAgent(db, agent.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET agent cash holding
router.get('/:id/cash', authMiddleware, tenantGuard, (req, res) => {
  try {
    // An agent may only check their OWN cash holding
    if (req.user.role === 'agent' && req.params.id !== req.user.agentId)
      return res.status(403).json({ error: "Not authorized to view this agent's cash" });

    const rows = req.db.all('SELECT type, amt FROM transactions WHERE agentId = ?', req.params.id);
    let balance = 0;
    rows.forEach(t => {
      if (['deposit', 'repay_princ'].includes(t.type)) balance += t.amt;
      else if (['withdraw', 'disburse', 'agent_handover'].includes(t.type)) balance -= t.amt;
    });
    res.json({ balance });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST agent handover — commission is calculated per account type
router.post('/handover', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const db = req.db;
    const { agentId, amt, date, accountId } = req.body;
    const amount = parseFloat(amt);
    if (isNaN(amount) || amount < 0.01) return res.status(400).json({ error: 'Invalid amount' });

    const agent = getAgent(db, agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    // The account this handover is about; falls back to the cash account
    const targetAccount = accountId
      ? db.get('SELECT * FROM accounts WHERE id = ?', accountId)
      : db.get("SELECT * FROM accounts WHERE type = 'cash' ORDER BY rowid LIMIT 1");
    if (!targetAccount) return res.status(400).json({ error: 'Target calculation account not found' });

    // Commission % configured for this account type (0 when not configured)
    const matching = (agent.typeCommissions || []).find(
      tc => (tc.typeName || '').toLowerCase() === (targetAccount.type || '').toLowerCase());
    const rate = matching ? matching.rate : 0;
    const commission = (amount * rate) / 100;

    const cashAcc = db.get("SELECT * FROM accounts WHERE type = 'cash' ORDER BY rowid LIMIT 1");
    const id = newId();

    db.tx(() => {
      if (cashAcc) db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', amount, cashAcc.id);
      db.run(
        `INSERT INTO transactions (id, date, accId, secAccId, type, amt, description, byRole, agentId, comm, createdAt)
         VALUES (?,?,?,?, 'agent_handover', ?,?, 'admin', ?,?,?)`,
        id, date || todayStr(), targetAccount.id, cashAcc ? cashAcc.id : targetAccount.id, amount,
        `Agent Handover (Type: ${targetAccount.type || 'N/A'}, Rate: ${rate}%)`, agentId, commission, nowISO());
    });

    const transaction = M.transactionBase(db.get('SELECT * FROM transactions WHERE id = ?', id));
    res.status(201).json({ transaction, commission });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
