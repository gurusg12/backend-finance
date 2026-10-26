// Default data every new company starts with (same as before).
const { newId, nowISO, todayStr } = require('../db/driver');

const DEFAULT_GROUPS = [
  { name: 'Cash', type: 'Asset' }, { name: 'Bank', type: 'Asset' },
  { name: 'Loans', type: 'Asset' }, { name: 'Deposits', type: 'Liability' },
  { name: 'Income', type: 'Income' }, { name: 'Expense', type: 'Expense' },
  { name: 'Equity', type: 'Equity' },
];
const DEFAULT_TYPES = [
  { name: 'Pigmy', prefix: 'PG', group: 'Deposits' }, { name: 'Loan', prefix: 'LN', group: 'Loans' },
  { name: 'Savings', prefix: 'SB', group: 'Deposits' }, { name: 'RD', prefix: 'RD', group: 'Deposits' },
  { name: 'Gold Loan', prefix: 'GL', group: 'Loans' }, { name: 'Personal Loan', prefix: 'PL', group: 'Loans' },
  { name: 'Property Loan', prefix: 'PR', group: 'Loans' },
];
const DEFAULT_ACCOUNTS = [
  { name: 'Cash',            group: 'Cash',    type: 'cash' },
  { name: 'Bank',            group: 'Bank',    type: 'bank' },
  { name: 'Interest Income', group: 'Income',  type: 'general' },
  { name: 'Rent Expense',    group: 'Expense', type: 'general' },
  { name: 'Other Charges',   group: 'Expense', type: 'general' },
];

function seedTenant(db) {
  const now = nowISO();
  const today = todayStr();
  db.tx(() => {
    DEFAULT_GROUPS.forEach(g =>
      db.run('INSERT INTO groups (id, name, type, isDefault, createdAt) VALUES (?,?,?,1,?)', newId(), g.name, g.type, now));
    DEFAULT_TYPES.forEach(t =>
      db.run('INSERT INTO account_types (id, name, prefix, grp, isDefault, createdAt) VALUES (?,?,?,?,1,?)',
        newId(), t.name, t.prefix, t.group, now));
    DEFAULT_ACCOUNTS.forEach(a =>
      db.run(`INSERT INTO accounts (id, name, grp, type, category, balance, status, opDate, isDefault, createdAt)
              VALUES (?,?,?,?, 'ledger', 0, 'active', ?, 1, ?)`, newId(), a.name, a.group, a.type, today, now));
  });
}

module.exports = { seedTenant };
