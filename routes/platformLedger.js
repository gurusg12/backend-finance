const express = require('express');
const router  = express.Router();
const { authMiddleware, superAdminOnly } = require('../middleware/auth');
const { getMaster } = require('../db/master');
const { newId, nowISO, todayStr, placeholders } = require('../db/driver');
const M = require('../lib/mappers');
const Company = require('../lib/company');

// Every route here is Super Admin only — this is the platform's OWN accounting
// (stored in master.db), never touching any company's database.
router.use(authMiddleware, superAdminOnly);

const DEFAULT_GROUPS = [
  { name: 'Cash',          type: 'Asset' },
  { name: 'Bank',          type: 'Asset' },
  { name: 'Tenant Income', type: 'Income' },
  { name: 'Other Income',  type: 'Income' },
  { name: 'Staff Salary',  type: 'Expense' },
  { name: 'Other Expense', type: 'Expense' },
];
const DEFAULT_ACCOUNTS = [
  { name: 'Cash in Hand',  group: 'Cash',          type: 'cash' },
  { name: 'Bank Account',  group: 'Bank',          type: 'bank' },
  { name: 'AMC Income',    group: 'Tenant Income', type: 'income' },
  { name: 'Other Income',  group: 'Other Income',  type: 'income' },
  { name: 'Staff Salary',  group: 'Staff Salary',  type: 'expense' },
  { name: 'Other Expense', group: 'Other Expense', type: 'expense' },
];

// One-time auto-seed: only if there are no groups yet.
function ensureSeeded() {
  const db = getMaster();
  if (db.get('SELECT COUNT(*) AS n FROM platform_groups').n > 0) return;
  db.tx(() => {
    DEFAULT_GROUPS.forEach(g =>
      db.run('INSERT INTO platform_groups (id, name, type, isDefault, createdAt) VALUES (?,?,?,1,?)', newId(), g.name, g.type, nowISO()));
    DEFAULT_ACCOUNTS.forEach(a =>
      db.run(`INSERT INTO platform_accounts (id, name, grp, type, balance, status, isDefault, opDate, createdAt)
              VALUES (?,?,?,?,0,'active',1,?,?)`, newId(), a.name, a.group, a.type, todayStr(), nowISO()));
  });
}

// Platform transaction rows → JSON with linked accounts / company filled in
function populateTx(rows) {
  const db = getMaster();
  const accIds = [...new Set(rows.flatMap(r => [r.cashAccountId, r.categoryAccountId]))];
  const accMap = {};
  if (accIds.length) db.all(`SELECT * FROM platform_accounts WHERE id IN ${placeholders(accIds)}`, ...accIds).forEach(a => { accMap[a.id] = a; });
  const coIds = [...new Set(rows.map(r => r.tenantCompanyId).filter(Boolean))];
  const coMap = {};
  if (coIds.length) db.all(`SELECT id, name FROM companies WHERE id IN ${placeholders(coIds)}`, ...coIds).forEach(c => { coMap[c.id] = c; });

  return rows.map(r => {
    const cash = accMap[r.cashAccountId];
    const cat  = accMap[r.categoryAccountId];
    const co   = r.tenantCompanyId ? coMap[r.tenantCompanyId] : null;
    return {
      _id: r.id, id: r.id, date: r.date, category: r.category,
      tenantCompanyId:   co  ? { _id: co.id, name: co.name } : null,
      cashAccountId:     cash ? { _id: cash.id, name: cash.name, type: cash.type } : null,
      categoryAccountId: cat  ? { _id: cat.id, name: cat.name, group: cat.grp } : null,
      amt: r.amt, desc: r.description || '', createdAt: r.createdAt,
    };
  });
}

/* ════════════════════════════ GROUPS ════════════════════════════════════ */

router.get('/groups', (req, res) => {
  try {
    ensureSeeded();
    res.json(getMaster().all('SELECT * FROM platform_groups ORDER BY type, name').map(M.platformGroup));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/groups', (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Name and type are required' });
    if (!['Asset', 'Liability', 'Income', 'Expense', 'Equity'].includes(type)) return res.status(400).json({ error: 'Invalid group type' });
    const db = getMaster();
    if (db.get('SELECT id FROM platform_groups WHERE name = ?', name.trim())) return res.status(400).json({ error: 'Group name already exists' });
    const id = newId();
    db.run('INSERT INTO platform_groups (id, name, type, isDefault, createdAt) VALUES (?,?,?,0,?)', id, name.trim(), type, nowISO());
    res.status(201).json(M.platformGroup(db.get('SELECT * FROM platform_groups WHERE id = ?', id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/groups/:id', (req, res) => {
  try {
    const db = getMaster();
    const g = db.get('SELECT * FROM platform_groups WHERE id = ?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Not found' });
    const name = req.body.name !== undefined ? String(req.body.name).trim() : g.name;
    const type = req.body.type !== undefined ? req.body.type : g.type;
    if (name !== g.name && db.get('SELECT id FROM platform_groups WHERE name = ?', name)) return res.status(400).json({ error: 'Group name already exists' });
    db.run('UPDATE platform_groups SET name = ?, type = ? WHERE id = ?', name, type, g.id);
    res.json(M.platformGroup(db.get('SELECT * FROM platform_groups WHERE id = ?', g.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/groups/:id', (req, res) => {
  try {
    const db = getMaster();
    const g = db.get('SELECT * FROM platform_groups WHERE id = ?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Not found' });
    if (g.isDefault) return res.status(400).json({ error: 'Cannot delete a default group' });
    if (db.get('SELECT COUNT(*) AS n FROM platform_accounts WHERE grp = ?', g.name).n > 0)
      return res.status(400).json({ error: 'Group has accounts under it — delete those first' });
    db.run('DELETE FROM platform_groups WHERE id = ?', g.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══════════════════════════ ACCOUNTS ════════════════════════════════════ */

router.get('/accounts', (req, res) => {
  try {
    ensureSeeded();
    const { status } = req.query;
    const rows = status
      ? getMaster().all('SELECT * FROM platform_accounts WHERE status = ? ORDER BY grp, name', status)
      : getMaster().all('SELECT * FROM platform_accounts ORDER BY grp, name');
    res.json(rows.map(M.platformAccount));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/accounts', (req, res) => {
  try {
    const { name, group, type } = req.body;
    if (!name || !group) return res.status(400).json({ error: 'Name and group are required' });
    const db = getMaster();
    const id = newId();
    db.run(`INSERT INTO platform_accounts (id, name, grp, type, balance, status, isDefault, opDate, createdAt)
            VALUES (?,?,?,?,0,'active',0,?,?)`, id, name.trim(), group, type || 'other', todayStr(), nowISO());
    res.status(201).json(M.platformAccount(db.get('SELECT * FROM platform_accounts WHERE id = ?', id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/accounts/:id', (req, res) => {
  try {
    const db = getMaster();
    const a = db.get('SELECT * FROM platform_accounts WHERE id = ?', req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const { name, group, type, status } = req.body;
    db.run('UPDATE platform_accounts SET name = ?, grp = ?, type = ?, status = ? WHERE id = ?',
      name !== undefined ? name : a.name, group !== undefined ? group : a.grp,
      type !== undefined ? type : a.type, status !== undefined ? status : a.status, a.id);
    res.json(M.platformAccount(db.get('SELECT * FROM platform_accounts WHERE id = ?', a.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/accounts/:id', (req, res) => {
  try {
    const db = getMaster();
    const a = db.get('SELECT * FROM platform_accounts WHERE id = ?', req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (a.isDefault) return res.status(400).json({ error: 'Cannot delete a default account' });
    if (a.balance !== 0) return res.status(400).json({ error: 'Account balance must be zero before deletion' });
    db.run('DELETE FROM platform_accounts WHERE id = ?', a.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══════════════════════════ TRANSACTIONS ════════════════════════════════ */

// GET /transactions — platform-only history (never any company's customer data)
router.get('/transactions', (req, res) => {
  try {
    const { from, to, category, tenantCompanyId, search } = req.query;
    const limit = parseInt(req.query.limit) || 150;
    const where = [];
    const params = [];
    if (from) { where.push('date >= ?'); params.push(from); }
    if (to)   { where.push('date <= ?'); params.push(to); }
    if (category) { where.push('category = ?'); params.push(category); }
    if (tenantCompanyId) { where.push('tenantCompanyId = ?'); params.push(tenantCompanyId); }

    const rows = getMaster().all(
      `SELECT * FROM platform_transactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY date DESC, createdAt DESC, rowid DESC LIMIT ?`, ...params, limit);
    let txs = populateTx(rows);

    if (search) {
      const q = search.toLowerCase();
      txs = txs.filter(t =>
        (t.desc || '').toLowerCase().includes(q) ||
        (t.tenantCompanyId?.name || '').toLowerCase().includes(q) ||
        (t.categoryAccountId?.name || '').toLowerCase().includes(q) ||
        (t.cashAccountId?.name || '').toLowerCase().includes(q));
    }
    res.json(txs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const INCOME_CATEGORIES  = ['tenant_receipt', 'other_income'];
const EXPENSE_CATEGORIES = ['staff_salary', 'other_expense'];

// POST /transactions — create + update both account balances
router.post('/transactions', (req, res) => {
  try {
    const { date, category, tenantCompanyId, cashAccountId, categoryAccountId, amt, desc } = req.body;
    if (!date || !category || !cashAccountId || !categoryAccountId || !amt)
      return res.status(400).json({ error: 'date, category, cashAccountId, categoryAccountId and amt are required' });
    if (category === 'tenant_receipt' && !tenantCompanyId)
      return res.status(400).json({ error: 'tenantCompanyId is required for Tenant Receipt transactions' });
    if (![...INCOME_CATEGORIES, ...EXPENSE_CATEGORIES].includes(category))
      return res.status(400).json({ error: 'Invalid category' });

    const amount = parseFloat(amt);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const db = getMaster();
    const cashAcc = db.get('SELECT * FROM platform_accounts WHERE id = ?', cashAccountId);
    const catAcc  = db.get('SELECT * FROM platform_accounts WHERE id = ?', categoryAccountId);
    if (!cashAcc || !catAcc) return res.status(404).json({ error: 'Account not found' });

    let company = null;
    if (category === 'tenant_receipt') {
      company = Company.findById(tenantCompanyId);
      if (!company) return res.status(404).json({ error: 'Company not found' });
    }

    const id = newId();
    let updatedCompany = null;
    db.tx(() => {
      const cashDelta = INCOME_CATEGORIES.includes(category) ? amount : -amount;
      db.run('UPDATE platform_accounts SET balance = balance + ? WHERE id = ?', cashDelta, cashAcc.id);
      db.run('UPDATE platform_accounts SET balance = balance + ? WHERE id = ?', amount, catAcc.id);

      // A tenant receipt also reduces what that company still owes (Fixed Balance)
      if (company) {
        company.paidAmount = (company.paidAmount || 0) + amount;
        updatedCompany = Company.save(company);   // recalculates paymentStatus / remainingAmount
      }

      db.run(
        `INSERT INTO platform_transactions (id, date, category, tenantCompanyId, cashAccountId, categoryAccountId, amt, description, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        id, date, category, category === 'tenant_receipt' ? tenantCompanyId : null,
        cashAccountId, categoryAccountId, amount, desc || '', nowISO());
    });

    const populated = populateTx(db.all('SELECT * FROM platform_transactions WHERE id = ?', id))[0];
    res.status(201).json({ ...populated, company: updatedCompany ? Company.toJSON(updatedCompany) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /transactions/:id — reverses both account balances
router.delete('/transactions/:id', (req, res) => {
  try {
    const db = getMaster();
    const tx = db.get('SELECT * FROM platform_transactions WHERE id = ?', req.params.id);
    if (!tx) return res.status(404).json({ error: 'Not found' });

    let deletedCompany = null;
    db.tx(() => {
      const cashAcc = db.get('SELECT id FROM platform_accounts WHERE id = ?', tx.cashAccountId);
      const catAcc  = db.get('SELECT id FROM platform_accounts WHERE id = ?', tx.categoryAccountId);
      if (cashAcc && catAcc) {
        const income = INCOME_CATEGORIES.includes(tx.category);
        db.run('UPDATE platform_accounts SET balance = balance + ? WHERE id = ?', income ? -tx.amt : tx.amt, cashAcc.id);
        db.run('UPDATE platform_accounts SET balance = balance - ? WHERE id = ?', tx.amt, catAcc.id);
      }

      if (tx.category === 'tenant_receipt' && tx.tenantCompanyId) {
        const company = Company.findById(tx.tenantCompanyId);
        if (company) {
          company.paidAmount = Math.max(0, (company.paidAmount || 0) - tx.amt);
          deletedCompany = Company.save(company);
        }
      }
      db.run('DELETE FROM platform_transactions WHERE id = ?', tx.id);
    });
    res.json({ message: 'Deleted and balances reversed', company: deletedCompany ? Company.toJSON(deletedCompany) : null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
