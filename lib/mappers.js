// ─────────────────────────────────────────────────────────────────────────────
// Turn database rows into the SAME JSON the old MongoDB API returned
// (_id, group, desc, by, nested objects …) so the React frontend keeps working
// without any change.
// ─────────────────────────────────────────────────────────────────────────────
const { placeholders } = require('../db/driver');

const parseJSON = (s, fallback) => {
  if (s === null || s === undefined || s === '') return fallback;
  try { return JSON.parse(s); } catch (_) { return fallback; }
};

/* ── Group ───────────────────────────────────────────────────────────────── */
function group(r) {
  if (!r) return null;
  return { _id: r.id, id: r.id, name: r.name, type: r.type, isDefault: !!r.isDefault, createdAt: r.createdAt };
}

/* ── Account type ────────────────────────────────────────────────────────── */
function accountType(r) {
  if (!r) return null;
  return { _id: r.id, id: r.id, name: r.name, prefix: r.prefix, group: r.grp, isDefault: !!r.isDefault, createdAt: r.createdAt };
}

/* ── Customer ────────────────────────────────────────────────────────────── */
function customer(r) {
  if (!r) return null;
  return {
    _id: r.id, id: r.id, custNo: r.custNo, name: r.name, mobile: r.mobile || '',
    address: r.address || '', createdBy: r.createdBy, createdAt: r.createdAt,
  };
}

/* ── Account ─────────────────────────────────────────────────────────────── */
// custObj: optional already-loaded customer row to "populate" custId with.
function account(r, custRow) {
  if (!r) return null;
  const out = {
    _id: r.id, id: r.id,
    custId: r.custId || null,
    accNo: r.accNo || '', name: r.name, group: r.grp, type: r.type,
    category: r.category, balance: r.balance, status: r.status, opDate: r.opDate,
    roi: r.roi, period: r.period, periodType: r.periodType, maturityDate: r.maturityDate,
    emiMethod: r.emiMethod, guarantor: r.guarantor || '', depositType: r.depositType || '',
    terms: parseJSON(r.terms, {}),
    agentId: null, agentIds: [],
    isDefault: !!r.isDefault, createdAt: r.createdAt,
  };
  if (custRow !== undefined) {
    out.custId = custRow ? { _id: custRow.id, name: custRow.name, custNo: custRow.custNo } : null;
  }
  return out;
}

// Fill agentId / agentIds (who the account is assigned to) on a list of account JSONs
function attachAgents(db, accs) {
  const ids = accs.map(a => a._id);
  if (!ids.length) return accs;
  const map = {};
  db.all(`SELECT accountId, agentId FROM agent_accounts WHERE accountId IN ${placeholders(ids)} ORDER BY rowid`, ...ids)
    .forEach(x => { (map[x.accountId] = map[x.accountId] || []).push(x.agentId); });
  accs.forEach(a => { a.agentIds = map[a._id] || []; a.agentId = a.agentIds[0] || null; });
  return accs;
}

// Load accounts and "populate" custId = { _id, name, custNo }
function accountsWithCustomers(db, whereSql = '', params = []) {
  const rows = db.all(`SELECT * FROM accounts ${whereSql}`, ...params);
  const ids = [...new Set(rows.map(r => r.custId).filter(Boolean))];
  const custMap = {};
  if (ids.length) {
    db.all(`SELECT id, name, custNo FROM customers WHERE id IN ${placeholders(ids)}`, ...ids)
      .forEach(c => { custMap[c.id] = c; });
  }
  return attachAgents(db, rows.map(r => account(r, r.custId ? (custMap[r.custId] || null) : null)));
}

/* ── Agent ───────────────────────────────────────────────────────────────── */
function agentDerived(validTill) {
  if (!validTill) return { isExpired: false, daysRemaining: null };
  const diff = new Date(validTill) - new Date();
  return { isExpired: diff < 0, daysRemaining: Math.max(0, Math.ceil(diff / 86400000)) };
}

function agent(r, assignedAccounts = [], { withHash = false } = {}) {
  if (!r) return null;
  const out = {
    _id: r.id, id: r.id, agentCode: r.agentCode || '', username: r.username,
    name: r.name || '', email: r.email || '', mobile: r.mobile || '', address: r.address || '',
    typeCommissions: parseJSON(r.typeCommissions, []),
    validFrom: r.validFrom, validTill: r.validTill,
    duration: { value: r.durationValue, type: r.durationType },
    assignedAccounts,
    isActive: !!r.isActive, createdAt: r.createdAt,
    ...agentDerived(r.validTill),
  };
  if (withHash) out.passwordHash = r.passwordHash;
  return out;
}

// Load agents (+ their assigned account ids) in two queries.
function loadAgents(db, whereSql = '', params = [], opts = {}) {
  const rows = db.all(`SELECT * FROM agents ${whereSql}`, ...params);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const map = {};
  db.all(`SELECT agentId, accountId FROM agent_accounts WHERE agentId IN ${placeholders(ids)}`, ...ids)
    .forEach(x => { (map[x.agentId] = map[x.agentId] || []).push(x.accountId); });
  return rows.map(r => agent(r, map[r.id] || [], opts));
}

/* ── Transaction ─────────────────────────────────────────────────────────── */
function transactionBase(r) {
  return {
    _id: r.id, id: r.id, date: r.date, accId: r.accId, secAccId: r.secAccId || null,
    type: r.type, amt: r.amt, desc: r.description || '', by: r.byRole,
    agentId: r.agentId || null, comm: r.comm || 0, createdAt: r.createdAt,
  };
}

/**
 * Convert transaction rows to JSON and "populate" the linked records.
 *   populate = {
 *     accId:    ['name','accNo',...]  → account fields to include
 *     secAccId: [...]
 *     agentId:  ['username','name','typeCommissions']
 *   }
 * A missing linked record becomes null (same as Mongoose populate).
 */
const ACC_FIELD = { group: 'grp' };   // API name -> column name
function pickAccount(row, fields) {
  const o = { _id: row.id };
  fields.forEach(f => {
    const col = ACC_FIELD[f] || f;
    o[f] = row[col];
  });
  return o;
}

function transactions(db, rows, populate = {}) {
  if (!rows.length) return [];
  const accIds = new Set();
  const agentIds = new Set();
  rows.forEach(r => {
    if (populate.accId && r.accId) accIds.add(r.accId);
    if (populate.secAccId && r.secAccId) accIds.add(r.secAccId);
    if (populate.agentId && r.agentId) agentIds.add(r.agentId);
  });

  const accMap = {};
  if (accIds.size) {
    const ids = [...accIds];
    db.all(`SELECT * FROM accounts WHERE id IN ${placeholders(ids)}`, ...ids).forEach(a => { accMap[a.id] = a; });
  }
  const agentMap = {};
  if (agentIds.size) {
    const ids = [...agentIds];
    db.all(`SELECT * FROM agents WHERE id IN ${placeholders(ids)}`, ...ids).forEach(a => { agentMap[a.id] = a; });
  }

  return rows.map(r => {
    const t = transactionBase(r);
    if (populate.accId) {
      const a = accMap[r.accId];
      t.accId = a ? pickAccount(a, populate.accId) : null;
    }
    if (populate.secAccId) {
      const a = r.secAccId ? accMap[r.secAccId] : null;
      t.secAccId = a ? pickAccount(a, populate.secAccId) : null;
    }
    if (populate.agentId) {
      const a = r.agentId ? agentMap[r.agentId] : null;
      if (!a) t.agentId = null;
      else {
        const o = { _id: a.id };
        populate.agentId.forEach(f => {
          o[f] = f === 'typeCommissions' ? parseJSON(a.typeCommissions, []) : a[f];
        });
        t.agentId = o;
      }
    }
    return t;
  });
}

/* ── Platform (Super Admin's own books) ──────────────────────────────────── */
function platformGroup(r) {
  if (!r) return null;
  return { _id: r.id, id: r.id, name: r.name, type: r.type, isDefault: !!r.isDefault, createdAt: r.createdAt };
}
function platformAccount(r) {
  if (!r) return null;
  return {
    _id: r.id, id: r.id, name: r.name, group: r.grp, type: r.type, balance: r.balance,
    status: r.status, isDefault: !!r.isDefault, opDate: r.opDate, createdAt: r.createdAt,
  };
}

module.exports = {
  parseJSON, group, accountType, customer, account, accountsWithCustomers, attachAgents,
  agent, loadAgents, transactions, transactionBase, platformGroup, platformAccount,
};
