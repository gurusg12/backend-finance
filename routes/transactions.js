const express = require('express');
const router  = express.Router();
const M = require('../lib/mappers');
const { newId, nowISO } = require('../db/driver');
const { authMiddleware, tenantGuard, companyAdminOnly } = require('../middleware/auth');

const TYPES = ['deposit', 'withdraw', 'disburse', 'repay_princ', 'income', 'expense', 'agent_handover', 'adjustment'];
const RECEIPT_TYPES = ['deposit', 'repay_princ', 'income', 'agent_handover'];

/* How does this transaction change the primary account's balance? (+1 / -1) */
function getTxMod(groupType, type) {
  const isAsset     = groupType === 'Asset' || groupType === 'Expense';
  const isLiability = groupType === 'Liability';
  const t = String(type).toLowerCase();
  if (isAsset) {
    if (['disburse', 'withdraw', 'expense'].includes(t)) return 1;
    if (['deposit', 'repay_princ', 'income'].includes(t)) return -1;
  }
  if (isLiability) {
    if (['deposit', 'repay_princ'].includes(t)) return 1;
    if (['withdraw', 'disburse'].includes(t))   return -1;
  }
  return 1;
}

// group type (Asset / Liability / …) of an account row; 'Asset' if group not found
function groupTypeOf(db, acc) {
  const g = db.get('SELECT type FROM groups WHERE name = ?', acc.grp);
  return g ? g.type : 'Asset';
}

const addBalance = (db, accId, delta) => db.run('UPDATE accounts SET balance = balance + ? WHERE id = ?', delta, accId);

const POPULATE_LIST = {
  accId:    ['name', 'accNo', 'type', 'group', 'custId'],
  secAccId: ['name', 'type'],
  agentId:  ['username'],
};

/* ── GET transactions ────────────────────────────────────────────────────── */
router.get('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    const { from, to, accId, type } = req.query;
    const limit = parseInt(req.query.limit) || 50;
    const where = [];
    const params = [];

    if (from) { where.push('date >= ?'); params.push(from); }
    if (to)   { where.push('date <= ?'); params.push(to); }
    if (type) { where.push('type = ?');  params.push(type); }

    if (req.user.role === 'agent') {
      // An agent only ever sees the transactions THEY personally made — never another agent's.
      where.push('agentId = ?');
      params.push(req.user.agentId);
    } else if (accId) {
      where.push('(accId = ? OR secAccId = ?)');
      params.push(accId, accId);
    }

    const rows = req.db.all(
      `SELECT * FROM transactions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY createdAt DESC, rowid DESC LIMIT ?`, ...params, limit);
    res.json(M.transactions(req.db, rows, POPULATE_LIST));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST create transaction ─────────────────────────────────────────────── */
router.post('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    const db = req.db;
    const { date, accId, secAccId, type, amt, desc } = req.body;

    if (!date) return res.status(400).json({ error: 'Date is required' });
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Invalid transaction type' });
    const parsedAmt = parseFloat(amt);
    if (isNaN(parsedAmt) || parsedAmt < 0.01) return res.status(400).json({ error: 'Invalid amount' });

    const primaryAcc = db.get('SELECT * FROM accounts WHERE id = ?', accId);
    if (!primaryAcc) return res.status(400).json({ error: 'Primary account not found' });

    // Secondary account is optional (may be missing or the sentinel '__cash__')
    const hasSec = secAccId && secAccId !== '__cash__';
    const secondaryAcc = hasSec ? db.get('SELECT * FROM accounts WHERE id = ?', secAccId) : null;
    if (hasSec && !secondaryAcc) return res.status(400).json({ error: 'Payment account not found' });

    const id = newId();
    db.tx(() => {
      addBalance(db, primaryAcc.id, parsedAmt * getTxMod(groupTypeOf(db, primaryAcc), type));

      // Admin: cash/bank moves automatically. Agent: no cash movement (handed over later).
      if (secondaryAcc && req.user.role === 'admin') {
        addBalance(db, secondaryAcc.id, RECEIPT_TYPES.includes(type) ? parsedAmt : -parsedAmt);
      }

      db.run(
        `INSERT INTO transactions (id, date, accId, secAccId, type, amt, description, byRole, agentId, createdAt)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, date, accId, hasSec ? secAccId : null, type, parsedAmt, desc || '',
        req.user.role, req.user.role === 'agent' ? req.user.agentId : null, nowISO());
    });

    // Return the saved transaction with linked accounts (frontend uses _id as voucher number)
    const rows = db.all('SELECT * FROM transactions WHERE id = ?', id);
    res.status(201).json(M.transactions(db, rows, {
      accId:    ['name', 'accNo', 'type', 'group', 'custId', 'balance'],
      secAccId: ['name', 'type', 'balance'],
    })[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── POST adjustment entry (double entry) ────────────────────────────────── */
router.post('/adjustment', authMiddleware, tenantGuard, (req, res) => {
  try {
    const db = req.db;
    const { date, drId, crId, amt, desc } = req.body;
    if (drId === crId) return res.status(400).json({ error: 'DR and CR accounts must differ' });
    if (!date) return res.status(400).json({ error: 'Date is required' });
    const parsedAmt = parseFloat(amt);
    if (isNaN(parsedAmt) || parsedAmt < 0.01) return res.status(400).json({ error: 'Invalid amount' });

    const drAcc = db.get('SELECT * FROM accounts WHERE id = ?', drId);
    const crAcc = db.get('SELECT * FROM accounts WHERE id = ?', crId);
    if (!drAcc || !crAcc) return res.status(400).json({ error: 'Account not found' });

    const drGroup = db.get('SELECT type FROM groups WHERE name = ?', drAcc.grp);
    const crGroup = db.get('SELECT type FROM groups WHERE name = ?', crAcc.grp);
    const isDrAsset = drGroup && (drGroup.type === 'Asset' || drGroup.type === 'Expense');
    const isCrAsset = crGroup && (crGroup.type === 'Asset' || crGroup.type === 'Expense');

    const id = newId();
    db.tx(() => {
      addBalance(db, drAcc.id, isDrAsset ?  parsedAmt : -parsedAmt);
      addBalance(db, crAcc.id, isCrAsset ? -parsedAmt :  parsedAmt);
      db.run(
        `INSERT INTO transactions (id, date, accId, secAccId, type, amt, description, byRole, createdAt)
         VALUES (?,?,?,?, 'adjustment', ?,?,?,?)`,
        id, date, drId, crId, parsedAmt, `[ADJ] ${desc || ''}`, req.user.role, nowISO());
    });
    res.status(201).json(M.transactionBase(db.get('SELECT * FROM transactions WHERE id = ?', id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── PUT update transaction ──────────────────────────────────────────────── */
router.put('/:id', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const db = req.db;
    const t = db.get('SELECT * FROM transactions WHERE id = ?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });

    const date = req.body.date !== undefined ? req.body.date : t.date;
    const type = req.body.type !== undefined ? req.body.type : t.type;
    const amt  = req.body.amt  !== undefined ? parseFloat(req.body.amt) : t.amt;
    const desc = req.body.desc !== undefined ? req.body.desc : t.description;
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'Invalid transaction type' });
    if (isNaN(amt) || amt < 0.01) return res.status(400).json({ error: 'Invalid amount' });

    db.tx(() => {
      const primAcc = db.get('SELECT * FROM accounts WHERE id = ?', t.accId);
      const secAcc  = t.secAccId ? db.get('SELECT * FROM accounts WHERE id = ?', t.secAccId) : null;

      // 1) undo the old effect
      if (primAcc) addBalance(db, primAcc.id, -(t.amt * getTxMod(groupTypeOf(db, primAcc), t.type)));
      if (secAcc)  addBalance(db, secAcc.id, RECEIPT_TYPES.includes(t.type) ? -t.amt : t.amt);

      // 2) apply the new effect
      if (primAcc) addBalance(db, primAcc.id, amt * getTxMod(groupTypeOf(db, primAcc), type));
      if (secAcc)  addBalance(db, secAcc.id, RECEIPT_TYPES.includes(type) ? amt : -amt);

      db.run('UPDATE transactions SET date = ?, type = ?, amt = ?, description = ? WHERE id = ?', date, type, amt, desc, t.id);
    });
    res.json(M.transactionBase(db.get('SELECT * FROM transactions WHERE id = ?', t.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── DELETE transaction ──────────────────────────────────────────────────── */
router.delete('/:id', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const db = req.db;
    const t = db.get('SELECT * FROM transactions WHERE id = ?', req.params.id);
    if (!t) return res.status(404).json({ error: 'Not found' });

    db.tx(() => {
      const primAcc = db.get('SELECT * FROM accounts WHERE id = ?', t.accId);
      const secAcc  = t.secAccId ? db.get('SELECT * FROM accounts WHERE id = ?', t.secAccId) : null;
      if (primAcc) addBalance(db, primAcc.id, -(t.amt * getTxMod(groupTypeOf(db, primAcc), t.type)));
      if (secAcc)  addBalance(db, secAcc.id, RECEIPT_TYPES.includes(t.type) ? -t.amt : t.amt);
      db.run('DELETE FROM transactions WHERE id = ?', t.id);
    });
    res.json({ message: 'Deleted and balances reversed' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
