const express = require('express');
const router = express.Router();
const M = require('../lib/mappers');
const { newId, nowISO, todayStr, placeholders } = require('../db/driver');
const { authMiddleware, tenantGuard } = require('../middleware/auth');
const Config = require('../lib/config');

const assignedIds = (db, agentId) =>
  db.all('SELECT accountId FROM agent_accounts WHERE agentId = ?', agentId).map(r => r.accountId);

// opening date + N days/months/years  →  'YYYY-MM-DD'
function addPeriod(dateStr, n, type) {
  const d = new Date(dateStr);
  const k = parseInt(n, 10);
  if (isNaN(d.getTime()) || isNaN(k)) return null;
  if (type === 'days') d.setDate(d.getDate() + k);
  else if (type === 'years') d.setFullYear(d.getFullYear() + k);
  else d.setMonth(d.getMonth() + k);
  return d.toISOString().split('T')[0];
}

// '' / null → null (empty), otherwise a real number — never store '' in a numeric column
function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Interest rate and duration must be valid numbers'), { status: 400 });
  return n;
}

// account JSON that keeps custId as a plain id (like create/update always did) + agent assignment
const accountOut = (db, id) => M.attachAgents(db, [M.account(db.get('SELECT * FROM accounts WHERE id = ?', id))])[0];

const getAccount = (db, id) => M.accountsWithCustomers(db, 'WHERE id = ?', [id])[0] || null;

// GET accounts (with optional filters)
router.get('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    const { custId, category, type, status } = req.query;
    const where = [];
    const params = [];
    if (custId)   { where.push('custId = ?');   params.push(custId); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (type)     { where.push('type = ?');     params.push(type); }
    if (status)   { where.push('status = ?');   params.push(status); }

    // Agents can access:
    //  1. Ledger accounts (cash/bank) — shared by all agents
    //  2. Only their own assigned customer accounts
    if (req.user.role === 'agent' && category !== 'ledger') {
      const ids = assignedIds(req.db, req.user.agentId);
      if (!ids.length) return res.json([]);
      where.push(`id IN ${placeholders(ids)}`);
      params.push(...ids);
    }

    res.json(M.accountsWithCustomers(req.db, where.length ? 'WHERE ' + where.join(' AND ') : '', params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /recalculate  ── Admin only
// Recomputes every account's balance from scratch using the real transactions.
// (declared before '/:id' routes so the word "recalculate" is never read as an id)
router.post('/recalculate', authMiddleware, tenantGuard, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    const db = req.db;

    const accounts     = db.all('SELECT * FROM accounts');
    const transactions = db.all('SELECT * FROM transactions');
    const groupTypeMap = {};
    db.all('SELECT name, type FROM groups').forEach(g => { groupTypeMap[g.name] = g.type; });

    const RECEIPT_TYPES = ['deposit', 'repay_princ', 'income', 'agent_handover'];
    let fixed = 0;
    const errors = [];

    db.tx(() => {
      for (const account of accounts) {
        try {
          const gType = groupTypeMap[account.grp] || 'Asset';
          const isAsset     = gType === 'Asset' || gType === 'Expense';
          const isLiability = gType === 'Liability' || gType === 'Equity';
          let newBalance = 0;

          for (const t of transactions) {
            const isPrimary   = t.accId === account.id;
            const isSecondary = t.secAccId === account.id;
            if (!isPrimary && !isSecondary) continue;
            const amt = t.amt || 0;

            if (t.type === 'adjustment') {
              if (isPrimary)   newBalance += isAsset ? amt : -amt;
              if (isSecondary) newBalance += isAsset ? -amt : amt;
              continue;
            }
            if (isPrimary) {
              if (isAsset) {
                if (['disburse', 'withdraw', 'expense'].includes(t.type)) newBalance += amt;
                if (['deposit', 'repay_princ', 'income'].includes(t.type)) newBalance -= amt;
              } else if (isLiability) {
                if (['deposit', 'repay_princ'].includes(t.type)) newBalance += amt;
                if (['withdraw', 'disburse'].includes(t.type))   newBalance -= amt;
              } else {
                if (['income', 'deposit', 'repay_princ'].includes(t.type)) newBalance += amt;
                if (['expense', 'withdraw', 'disburse'].includes(t.type))  newBalance -= amt;
              }
            }
            if (isSecondary) {
              if (t.byRole === 'agent' && t.type !== 'agent_handover') continue; // agent tx not credited to cash
              newBalance += RECEIPT_TYPES.includes(t.type) ? amt : -amt;
            }
          }

          if (Math.abs((account.balance || 0) - newBalance) > 0.001) {
            db.run('UPDATE accounts SET balance = ? WHERE id = ?', newBalance, account.id);
            fixed++;
          }
        } catch (e) { errors.push({ account: account.name, error: e.message }); }
      }
    });

    res.json({
      message: `Recalculation complete. ${fixed} account(s) corrected.`,
      totalAccounts: accounts.length, fixed, errors,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create ledger account
router.post('/ledger', authMiddleware, tenantGuard, (req, res) => {
  try {
    const { name, group, type } = req.body;
    if (!name || !group) return res.status(400).json({ error: 'Name and group are required' });
    if (req.db.get('SELECT id FROM accounts WHERE name = ? COLLATE NOCASE', name.trim()))
      return res.status(400).json({ error: 'Account name already exists' });
    const id = newId();
    req.db.run(
      `INSERT INTO accounts (id, name, grp, type, category, balance, status, opDate, createdAt)
       VALUES (?,?,?,?, 'ledger', 0, 'active', ?, ?)`,
      id, name.trim(), group, type || 'general', todayStr(), nowISO());
    res.status(201).json(M.account(req.db.get('SELECT * FROM accounts WHERE id = ?', id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create customer account
router.post('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    const db = req.db;
    const { custId, typeName, opDate, emiMethod, guarantor, depositType, agentId } = req.body;
    let { roi, period, periodType, maturityDate } = req.body;

    const typeObj = db.get('SELECT * FROM account_types WHERE name = ?', typeName);
    if (!typeObj) return res.status(400).json({ error: 'Account type not found' });
    const customer = db.get('SELECT * FROM customers WHERE id = ?', custId);
    if (!customer) return res.status(400).json({ error: 'Customer not found' });

    // Company configuration → defaults for this kind of account (loan / deposit / pigmy)
    const config = Config.getConfig(db);
    const category = Config.categoryFor(db, typeName, typeObj.grp);
    const cfg = config[category] || {};
    if (roi === undefined && cfg.interestRate !== undefined) roi = cfg.interestRate;                 // only when the field was not sent at all
    if (period === undefined && cfg.tenure !== undefined) { period = cfg.tenure; periodType = periodType || cfg.tenureType; }
    const openDate = opDate || todayStr();
    if (!maturityDate && period && category !== 'other') maturityDate = addPeriod(openDate, period, periodType || 'months');

    // The account keeps its OWN copy of the terms (late fee, grace …) so later config changes don't alter it.
    // Agents cannot choose fee terms — they always get the company defaults.
    const terms = { ...Config.termsDefaults(config, category) };
    if (req.user.role !== 'agent') Object.assign(terms, Config.cleanTerms(req.body.terms));
    ['collectorName', 'dailyAmount'].forEach(k => {                     // pigmy fields (older forms sent them at top level)
      if (req.body[k] !== undefined && category === 'pigmy') Object.assign(terms, Config.cleanTerms({ [k]: req.body[k] }));
    });
    if (category === 'pigmy' && cfg.minDailyAmount && terms.dailyAmount !== undefined && terms.dailyAmount < cfg.minDailyAmount)
      return res.status(400).json({ error: `Daily amount must be at least ${cfg.minDailyAmount}` });

    const id = newId();
    db.tx(() => {
      // Next account number for this type = highest existing number + 1
      const last = db.get(
        `SELECT MAX(CAST(SUBSTR(accNo, LENGTH(?) + 1) AS INTEGER)) AS n FROM accounts WHERE SUBSTR(accNo, 1, LENGTH(?)) = ?`,
        typeObj.prefix, typeObj.prefix, typeObj.prefix);
      const accNo = typeObj.prefix + String((last?.n || 0) + 1).padStart(4, '0');

      // EMI method is an admin-only setting — ignored when an agent submits it
      const emi = req.user.role !== 'agent' && emiMethod ? emiMethod : (category === 'loan' ? (cfg.interestMethod || 'reducing') : 'reducing');

      db.run(
        `INSERT INTO accounts (id, custId, accNo, name, grp, type, category, balance, status, opDate,
                               roi, period, periodType, maturityDate, emiMethod, guarantor, depositType, terms, createdAt)
         VALUES (?,?,?,?,?,?, 'customer', 0, 'active', ?, ?,?,?,?,?,?,?,?, ?)`,
        id, custId, accNo, `${customer.name} - ${typeName.toUpperCase()}`, typeObj.grp, typeName,
        openDate, roi || null, period || null, periodType || 'months', maturityDate || null,
        emi, guarantor || '', depositType || '', JSON.stringify(terms), nowISO());

      // Assign to the chosen agent, or to the agent who is creating it
      const targetAgentId = agentId || (req.user.role === 'agent' ? req.user.agentId : null);
      if (targetAgentId && db.get('SELECT id FROM agents WHERE id = ?', targetAgentId)) {
        db.run('INSERT OR IGNORE INTO agent_accounts (agentId, accountId) VALUES (?,?)', targetAgentId, id);
      }
    });
    res.status(201).json(accountOut(db, id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single account
router.get('/:id', authMiddleware, tenantGuard, (req, res) => {
  try {
    const account = getAccount(req.db, req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });

    // Agent isolation: only ledger accounts or their own assigned customer accounts
    if (req.user.role === 'agent') {
      const isLedger   = account.category === 'ledger';
      const isAssigned = assignedIds(req.db, req.user.agentId).includes(account._id);
      if (!isLedger && !isAssigned) return res.status(403).json({ error: 'Not authorized to view this account' });
    }
    // Loan / deposit history figures the transaction form needs (late-fee and arrears calculation)
    if (account.category === 'customer') {
      const s = req.db.get(
        `SELECT COALESCE(SUM(CASE WHEN type = 'disburse' THEN amt END), 0)    AS disbursed,
                COALESCE(SUM(CASE WHEN type = 'repay_princ' THEN amt END), 0) AS repaid,
                MIN(CASE WHEN type = 'disburse' THEN date END)                AS firstDisburseDate,
                MAX(date)                                                     AS lastTxDate
           FROM transactions WHERE accId = ?`, account._id);
      account.stats = s;
    }
    res.json(account);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update account
router.put('/:id', authMiddleware, tenantGuard, (req, res) => {
  try {
    const db = req.db;
    const { name, opDate, roi, period, periodType, maturityDate, emiMethod, guarantor, custId, group, type, depositType, status, agentId } = req.body;
    const set = {};

    const existing = db.get('SELECT * FROM accounts WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    // an agent may only edit accounts assigned to them
    if (req.user.role === 'agent' && existing.category !== 'ledger' && !assignedIds(db, req.user.agentId).includes(existing.id))
      return res.status(403).json({ error: 'Not authorized to edit this account' });

    // Fee terms + agent assignment are admin-only
    let newTerms = null;
    if (req.user.role !== 'agent' && req.body.terms && typeof req.body.terms === 'object') {
      newTerms = { ...M.parseJSON(existing.terms, {}), ...Config.cleanTerms(req.body.terms) };
      set.terms = JSON.stringify(newTerms);
    }
    let reassign = false;
    if (req.user.role !== 'agent' && agentId !== undefined) {
      if (agentId && !db.get('SELECT id FROM agents WHERE id = ? AND isActive = 1', agentId))
        return res.status(400).json({ error: 'Agent not found or inactive' });
      reassign = true;
    }

    if (name !== undefined)         set.name = name;
    if (opDate !== undefined)       set.opDate = opDate;
    if (roi !== undefined)          set.roi = numOrNull(roi);
    if (period !== undefined)       set.period = numOrNull(period);
    if (periodType !== undefined)   set.periodType = periodType;
    if (maturityDate !== undefined) set.maturityDate = maturityDate;
    if (emiMethod !== undefined && req.user.role !== 'agent') set.emiMethod = emiMethod;
    if (guarantor !== undefined)    set.guarantor = guarantor;
    if (group !== undefined)        set.grp = group;
    if (depositType !== undefined)  set.depositType = depositType;
    if (status !== undefined)       set.status = status;

    if (custId !== undefined && db.get('SELECT id FROM customers WHERE id = ?', custId)) set.custId = custId;

    if (type !== undefined) {
      set.type = type;
      if (group === undefined) {
        const typeObj = db.get('SELECT * FROM account_types WHERE name = ?', type);
        if (typeObj) set.grp = typeObj.grp;
      }
    }

    const keys = Object.keys(set);
    db.tx(() => {
      if (keys.length) {
        db.run(`UPDATE accounts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map(k => set[k]), req.params.id);
      }
      if (reassign) {   // the account belongs to ONE agent (or none)
        db.run('DELETE FROM agent_accounts WHERE accountId = ?', req.params.id);
        if (agentId) db.run('INSERT OR IGNORE INTO agent_accounts (agentId, accountId) VALUES (?,?)', agentId, req.params.id);
      }
    });
    res.json(accountOut(db, req.params.id));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// PATCH toggle status
router.patch('/:id/status', authMiddleware, tenantGuard, (req, res) => {
  try {
    const { status } = req.body;
    const account = req.db.get('SELECT * FROM accounts WHERE id = ?', req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    if (status === 'inactive' && Math.abs(account.balance) > 0.01)
      return res.status(400).json({ error: 'Cannot deactivate account with non-zero balance' });
    req.db.run('UPDATE accounts SET status = ? WHERE id = ?', status, account.id);
    res.json(M.account(req.db.get('SELECT * FROM accounts WHERE id = ?', account.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE account
router.delete('/:id', authMiddleware, tenantGuard, (req, res) => {
  try {
    const db = req.db;
    if (db.get('SELECT id FROM transactions WHERE accId = ? OR secAccId = ? LIMIT 1', req.params.id, req.params.id))
      return res.status(400).json({ error: 'Cannot delete: transactions exist' });
    const account = db.get('SELECT * FROM accounts WHERE id = ?', req.params.id);
    if (!account) return res.status(404).json({ error: 'Not found' });
    if (Math.abs(account.balance) > 0.01) return res.status(400).json({ error: 'Cannot delete account with balance' });

    db.tx(() => {
      db.run('DELETE FROM agent_accounts WHERE accountId = ?', account.id);
      db.run('DELETE FROM accounts WHERE id = ?', account.id);
    });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
