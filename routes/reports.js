const express = require('express');
const router = express.Router();
const M = require('../lib/mappers');
const { authMiddleware, tenantGuard, companyAdminOnly } = require('../middleware/auth');
const Config = require('../lib/config');

// map of  groupName -> 'Asset' | 'Liability' | 'Income' | 'Expense' | 'Equity'
function groupTypeMap(db) {
  const map = {};
  db.all('SELECT name, type FROM groups').forEach(g => { map[g.name] = g.type; });
  return map;
}

const pad = n => String(n).padStart(2, '0');

// ─── GET /reports/agent-cash ────────────────────────────────────────────────
// Cash each agent has collected but not yet handed over (an asset on the balance sheet).
router.get('/agent-cash', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const rows = req.db.all(`
      SELECT a.id, a.agentCode, a.username, a.name, a.isActive,
             COALESCE(SUM(CASE
               WHEN t.type IN ('deposit','repay_princ') THEN t.amt
               WHEN t.type IN ('withdraw','disburse','agent_handover') THEN -t.amt
               ELSE 0 END), 0) AS balance
        FROM agents a LEFT JOIN transactions t ON t.agentId = a.id
       GROUP BY a.id ORDER BY a.rowid`);
    res.json(rows.map(r => ({
      _id: r.id, agentCode: r.agentCode || '', username: r.username, name: r.name || '',
      isActive: !!r.isActive, balance: r.balance,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET dashboard stats ────────────────────────────────────────────────────
router.get('/dashboard', authMiddleware, tenantGuard, (req, res) => {
  try {
    const db = req.db;
    const isAgent = req.user.role === 'agent';

    let transactions = db.all('SELECT * FROM transactions');
    const groups = db.all('SELECT * FROM groups');
    const incomeGroups  = groups.filter(g => g.type === 'Income').map(g => g.name);
    const expenseGroups = groups.filter(g => g.type === 'Expense').map(g => g.name);
    const accounts = db.all('SELECT * FROM accounts');
    const accById = {};
    accounts.forEach(a => { accById[a.id] = a; });

    // An agent only ever sees figures for their OWN collections/handovers
    if (isAgent) transactions = transactions.filter(t => t.agentId === req.user.agentId);

    let totalIncome = 0, totalExpense = 0, totalReceipts = 0, totalHandover = 0;
    const totalCount = transactions.length;

    transactions.forEach(t => {
      const acc    = accById[t.accId];
      const secAcc = t.secAccId ? accById[t.secAccId] : null;

      if (acc) {
        if (incomeGroups.includes(acc.grp))  totalIncome  += t.amt;
        if (expenseGroups.includes(acc.grp)) totalExpense += t.amt;
      }
      // Adjustment entries: the credit side (secAccId) can be an income account too
      if (t.type === 'adjustment' && secAcc) {
        if (incomeGroups.includes(secAcc.grp))  totalIncome  += t.amt;
        if (expenseGroups.includes(secAcc.grp)) totalExpense += t.amt;
      }

      // Only real customer collections are receipts. A handover is the agent settling
      // cash already counted, so it is tracked separately.
      if (['deposit', 'repay_princ', 'income'].includes(t.type)) totalReceipts += t.amt;
      if (t.type === 'agent_handover') totalHandover += t.amt;
    });

    let cashBalance = 0;
    if (isAgent) {
      transactions.forEach(t => {
        if (['deposit', 'repay_princ'].includes(t.type)) cashBalance += t.amt;
        else if (['withdraw', 'disburse', 'agent_handover'].includes(t.type)) cashBalance -= t.amt;
      });
    } else {
      const cashAcc = accounts.find(a => a.type === 'cash');
      cashBalance = cashAcc ? cashAcc.balance : 0;
    }

    // Handover history (shown separately)
    const handoverRows = isAgent
      ? db.all("SELECT * FROM transactions WHERE type = 'agent_handover' AND agentId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 8", req.user.agentId)
      : db.all("SELECT * FROM transactions WHERE type = 'agent_handover' ORDER BY createdAt DESC, rowid DESC LIMIT 8");
    const recentHandovers = M.transactions(db, handoverRows, {
      agentId: ['username', 'name'],
      accId:   ['name', 'accNo', 'type'],
    });

    res.json({ cashBalance, totalReceipts, totalIncome, totalExpense, totalCount, totalHandover, recentHandovers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /reports/dashboard-tenant ──────────────────────────────────────────
// Admin-only dashboard extras. Loans vs deposits are told apart by the account's group type:
//   Asset → loan account, Liability → deposit account
router.get('/dashboard-tenant', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const db = req.db;
    const now = new Date();
    const todayStr      = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const monthStartStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
    const lastDay       = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const monthEndStr   = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;
    const soonStr = (() => {
      const d = new Date(now); d.setDate(d.getDate() + (Config.getConfig(db).general.reminderDays || 7));
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    })();

    const groupType = groupTypeMap(db);

    // Today's payments
    const todayTxs = db.all('SELECT type, amt FROM transactions WHERE date = ?', todayStr);
    let todayReceived = 0, todayPaid = 0;
    todayTxs.forEach(t => {
      if (['deposit', 'repay_princ', 'income'].includes(t.type)) todayReceived += t.amt;
      else if (['withdraw', 'disburse', 'expense'].includes(t.type)) todayPaid += t.amt;
    });

    // Customer accounts split into loans / deposits
    const custAccounts = M.accountsWithCustomers(db, "WHERE category = 'customer' AND status = 'active'");
    const loanAccounts    = custAccounts.filter(a => groupType[a.group] === 'Asset' && a.roi != null && a.period);
    const depositAccounts = custAccounts.filter(a => groupType[a.group] === 'Liability' && a.maturityDate);

    const inMonth = a => a.maturityDate >= monthStartStr && a.maturityDate <= monthEndStr;
    const summary = list => ({
      count: list.length,
      totalAmt: list.reduce((s, a) => s + (a.balance || 0), 0),
      accounts: list.map(a => ({ _id: a._id, name: a.name, accNo: a.accNo, maturityDate: a.maturityDate, amt: a.balance })),
    });

    const monthDepositsMaturity = summary(depositAccounts.filter(inMonth));
    const monthLoanDue = summary(loanAccounts.filter(a => a.maturityDate && inMonth(a)));

    // EMI receivable: estimated monthly instalment = first disbursed amount / period
    let emiReceivable = 0;
    if (loanAccounts.length) {
      const loanIds = loanAccounts.map(a => a._id);
      const disburseTxs = db.all(
        `SELECT accId, amt FROM transactions WHERE type = 'disburse' AND accId IN (${loanIds.map(() => '?').join(',')})
         ORDER BY date ASC, rowid ASC`, ...loanIds);
      const firstDisburse = {};
      disburseTxs.forEach(t => { if (!(t.accId in firstDisburse)) firstDisburse[t.accId] = t.amt; });
      loanAccounts.forEach(a => {
        const principal = firstDisburse[a._id] ?? a.balance;
        if (a.period > 0) emiReceivable += principal / a.period;
      });
    }
    // EMI received: principal repayments collected this month
    const emiReceived = db.get(
      "SELECT COALESCE(SUM(amt), 0) AS s FROM transactions WHERE type = 'repay_princ' AND date >= ? AND date <= ?",
      monthStartStr, monthEndStr).s;

    // Reminders & alerts: overdue, or maturing within the reminder window (Configuration → General)
    const alerts = [];
    [...loanAccounts, ...depositAccounts].forEach(a => {
      if (!a.maturityDate) return;
      const kind = groupType[a.group] === 'Asset' ? 'loan' : 'deposit';
      if (a.maturityDate < todayStr) {
        alerts.push({ accId: a._id, name: a.name, accNo: a.accNo, maturityDate: a.maturityDate, amt: a.balance, kind, status: 'overdue' });
      } else if (a.maturityDate <= soonStr) {
        alerts.push({ accId: a._id, name: a.name, accNo: a.accNo, maturityDate: a.maturityDate, amt: a.balance, kind, status: 'upcoming' });
      }
    });
    alerts.sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));

    res.json({
      todayPayments: { received: todayReceived, paid: todayPaid, count: todayTxs.length },
      alerts, monthDepositsMaturity, monthLoanDue,
      monthEmi: { receivable: emiReceivable, received: emiReceived },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Transactions made by agents (collections) + admin-recorded agent handovers
function agentTxRows(db, { agentId, from, to }) {
  const where = ["(byRole = 'agent' OR (type = 'agent_handover' AND agentId IS NOT NULL))"];
  const params = [];
  if (agentId) { where.push('agentId = ?'); params.push(agentId); }
  if (from)    { where.push('date >= ?');   params.push(from); }
  if (to)      { where.push('date <= ?');   params.push(to); }
  return db.all(`SELECT * FROM transactions WHERE ${where.join(' AND ')} ORDER BY rowid`, ...params);
}

// A handover that uses the plain cash account as BOTH accounts only settles cash that was
// already counted in the agent's earlier collection → skip it so totals aren't doubled.
const isGenericHandover = t =>
  t.type === 'agent_handover' && t.accId && t.secAccId && t.accId._id === t.secAccId._id;

// ─── GET /reports/agent-commission ──────────────────────────────────────────
router.get('/agent-commission', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { from, to, agentId } = req.query;
    const rows = agentTxRows(req.db, { agentId, from, to });
    const txs = M.transactions(req.db, rows, {
      agentId:  ['agentCode', 'username', 'name', 'typeCommissions'],
      accId:    ['name', 'accNo', 'group', 'type'],
      secAccId: ['type'],
    });

    const agentMap = {};
    for (const t of txs) {
      const agent = t.agentId;
      if (!agent) continue;
      if (isGenericHandover(t)) continue;

      const aid = agent._id;
      if (!agentMap[aid]) {
        agentMap[aid] = {
          agentId: aid, agentCode: agent.agentCode || '', username: agent.username, name: agent.name || '',
          typeCommissions: agent.typeCommissions || [],
          rows: [], totalAmt: 0, totalComm: 0, byType: {},
        };
      }

      // Rate = the agent's commission % for this account's type
      const accType = t.accId?.type || 'General';
      const match = (agent.typeCommissions || []).find(tc => tc.typeName?.toLowerCase() === accType.toLowerCase());
      const rate = match ? (match.rate || 0) : 0;

      // Handovers carry the commission stored when they were recorded; others are calculated
      const comm = t.type === 'agent_handover' ? (t.comm || 0) : (t.amt * rate) / 100;

      agentMap[aid].totalAmt  += t.amt;
      agentMap[aid].totalComm += comm;
      if (!agentMap[aid].byType[accType]) agentMap[aid].byType[accType] = { amt: 0, comm: 0, rate };
      agentMap[aid].byType[accType].amt  += t.amt;
      agentMap[aid].byType[accType].comm += comm;

      agentMap[aid].rows.push({
        date: t.date, accName: t.accId?.name || '—', accNo: t.accId?.accNo || '',
        accountType: accType, group: t.accId?.group || '', type: t.type, amt: t.amt, rate, comm,
      });
    }
    res.json(Object.values(agentMap));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ══════════════════════════════════════════════════════════════════════════
   MIS REPORTS — admin only
   ══════════════════════════════════════════════════════════════════════════ */
function classifyAccounts(db) {
  const groupType = groupTypeMap(db);
  const custAccounts = M.accountsWithCustomers(db, "WHERE category = 'customer' AND status = 'active'");
  return {
    loanAccounts:    custAccounts.filter(a => groupType[a.group] === 'Asset' && a.roi != null && a.period),
    depositAccounts: custAccounts.filter(a => groupType[a.group] === 'Liability' && a.maturityDate),
  };
}

// GET /reports/mis/summary — the 3 top MIS cards
router.get('/mis/summary', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { loanAccounts, depositAccounts } = classifyAccounts(req.db);
    const todayStr = new Date().toISOString().slice(0, 10);
    const sum = list => list.reduce((s, a) => s + (a.balance || 0), 0);
    const due = loanAccounts.filter(a => a.maturityDate && a.maturityDate <= todayStr);
    res.json({
      totalDeposits: sum(depositAccounts), depositCount: depositAccounts.length,
      totalLoans: sum(loanAccounts),       loanCount: loanAccounts.length,
      totalLoanDue: sum(due),              loanDueCount: due.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /reports/mis/deposits
router.get('/mis/deposits', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { depositAccounts } = classifyAccounts(req.db);
    res.json(depositAccounts.map(a => ({
      _id: a._id, name: a.name, accNo: a.accNo, type: a.type,
      custName: a.custId?.name || '', custNo: a.custId?.custNo || '',
      balance: a.balance, roi: a.roi, maturityDate: a.maturityDate, opDate: a.opDate,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /reports/mis/loans
router.get('/mis/loans', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { loanAccounts } = classifyAccounts(req.db);
    res.json(loanAccounts.map(a => ({
      _id: a._id, name: a.name, accNo: a.accNo, type: a.type,
      custName: a.custId?.name || '', custNo: a.custId?.custNo || '',
      balance: a.balance, roi: a.roi, period: a.period, periodType: a.periodType,
      emiMethod: a.emiMethod || 'reducing', maturityDate: a.maturityDate, opDate: a.opDate,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /reports/mis/loan-due — "EMI" (still running) and "Maturity" (reached maturity) tabs
router.get('/mis/loan-due', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { loanAccounts } = classifyAccounts(req.db);
    const todayStr = new Date().toISOString().slice(0, 10);
    const toRow = a => ({
      _id: a._id, name: a.name, accNo: a.accNo,
      custName: a.custId?.name || '', custNo: a.custId?.custNo || '',
      balance: a.balance, roi: a.roi, period: a.period, maturityDate: a.maturityDate,
    });
    const emi      = loanAccounts.filter(a => !a.maturityDate || a.maturityDate > todayStr).map(toRow);
    const maturity = loanAccounts.filter(a => a.maturityDate && a.maturityDate <= todayStr).map(toRow);
    const total = l => l.reduce((s, a) => s + a.balance, 0);
    res.json({
      emi:      { count: emi.length,      totalAmt: total(emi),      accounts: emi },
      maturity: { count: maturity.length, totalAmt: total(maturity), accounts: maturity },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /reports/mis/agent-activity?agentId=&mode=day|month&from=&to=
router.get('/mis/agent-activity', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { agentId, mode = 'day', from, to } = req.query;
    const rows = agentTxRows(req.db, { agentId, from, to });
    const txs = M.transactions(req.db, rows, {
      agentId:  ['username', 'name', 'typeCommissions'],
      accId:    ['type'],
      secAccId: ['type'],
    });

    const bucketKey = t => (mode === 'month' ? t.date.slice(0, 7) : t.date);
    const buckets = {};
    txs.forEach(t => {
      const agent = t.agentId;
      if (!agent) return;
      if (isGenericHandover(t)) return;

      const key = bucketKey(t);
      if (!buckets[key]) buckets[key] = { period: key, collectionAmt: 0, handoverAmt: 0, commission: 0 };

      if (t.type === 'agent_handover') {
        buckets[key].handoverAmt += t.amt;
        buckets[key].commission  += t.comm || 0;
      } else {
        buckets[key].collectionAmt += t.amt;
        const accType = t.accId?.type || 'General';
        const match = (agent.typeCommissions || []).find(tc => tc.typeName?.toLowerCase() === accType.toLowerCase());
        buckets[key].commission += (t.amt * (match ? (match.rate || 0) : 0)) / 100;
      }
    });
    res.json(Object.values(buckets).sort((a, b) => a.period.localeCompare(b.period)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
