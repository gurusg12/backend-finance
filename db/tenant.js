// ─────────────────────────────────────────────────────────────────────────────
// TENANT databases  →  data/tenants/<companyId>.db
// One completely separate SQLite file per company. A company can never see
// another company's data because it is physically in a different file.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { Db } = require('./driver');
const { TENANT_DIR } = require('./master');

// NOTE: "group", "desc" and "by" are SQL keywords, so the columns are called
// grp / description / byRole. The API still sends/receives group / desc / by.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS groups (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  type      TEXT NOT NULL CHECK (type IN ('Asset','Liability','Income','Expense','Equity')),
  isDefault INTEGER DEFAULT 0,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS account_types (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  prefix    TEXT NOT NULL UNIQUE,
  grp       TEXT NOT NULL,
  isDefault INTEGER DEFAULT 0,
  createdAt TEXT
);

-- company configuration (default interest / late fee / grace period …) — one row
CREATE TABLE IF NOT EXISTS config (
  key       TEXT PRIMARY KEY,
  value     TEXT,
  updatedAt TEXT
);

CREATE TABLE IF NOT EXISTS customers (
  id        TEXT PRIMARY KEY,
  custNo    TEXT UNIQUE,
  name      TEXT NOT NULL,
  mobile    TEXT DEFAULT '',
  address   TEXT DEFAULT '',
  createdBy TEXT DEFAULT 'admin',
  createdAt TEXT
);
CREATE INDEX IF NOT EXISTS ix_cust_name ON customers(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS accounts (
  id           TEXT PRIMARY KEY,
  custId       TEXT,
  accNo        TEXT DEFAULT '',
  name         TEXT NOT NULL,
  grp          TEXT NOT NULL,
  type         TEXT NOT NULL,
  category     TEXT DEFAULT 'ledger' CHECK (category IN ('ledger','customer')),
  balance      REAL DEFAULT 0,
  status       TEXT DEFAULT 'active' CHECK (status IN ('active','inactive','closed')),
  opDate       TEXT,
  roi          REAL,
  period       REAL,
  periodType   TEXT DEFAULT 'months',
  maturityDate TEXT,
  emiMethod    TEXT DEFAULT 'reducing' CHECK (emiMethod IN ('reducing','fixed')),
  guarantor    TEXT DEFAULT '',
  depositType  TEXT DEFAULT '',
  terms        TEXT DEFAULT '{}',          -- JSON: late fee, grace days, due day, pigmy collector …
  isDefault    INTEGER DEFAULT 0,
  createdAt    TEXT
);
CREATE INDEX IF NOT EXISTS ix_acc_accno ON accounts(accNo);
CREATE INDEX IF NOT EXISTS ix_acc_cust  ON accounts(custId);
CREATE INDEX IF NOT EXISTS ix_acc_cat   ON accounts(category);

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  agentCode       TEXT,                        -- ag01, ag02 …
  username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  passwordHash    TEXT NOT NULL,
  name            TEXT DEFAULT '',
  email           TEXT DEFAULT '',
  mobile          TEXT DEFAULT '',
  address         TEXT DEFAULT '',
  typeCommissions TEXT DEFAULT '[]',          -- JSON: [{typeName, rate}]
  validFrom       TEXT,
  validTill       TEXT,
  durationValue   INTEGER DEFAULT 1,
  durationType    TEXT DEFAULT 'years',
  isActive        INTEGER DEFAULT 1,
  createdAt       TEXT
);

CREATE TABLE IF NOT EXISTS agent_accounts (
  agentId   TEXT NOT NULL,
  accountId TEXT NOT NULL,
  PRIMARY KEY (agentId, accountId)
);

CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  accId       TEXT NOT NULL,
  secAccId    TEXT,
  type        TEXT NOT NULL CHECK (type IN
                ('deposit','withdraw','disburse','repay_princ','income','expense','agent_handover','adjustment')),
  amt         REAL NOT NULL CHECK (amt >= 0.01),
  description TEXT DEFAULT '',
  byRole      TEXT DEFAULT 'admin' CHECK (byRole IN ('admin','agent')),
  agentId     TEXT,
  comm        REAL DEFAULT 0,
  createdAt   TEXT
);
CREATE INDEX IF NOT EXISTS ix_tx_date  ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS ix_tx_acc   ON transactions(accId);
CREATE INDEX IF NOT EXISTS ix_tx_sec   ON transactions(secAccId);
CREATE INDEX IF NOT EXISTS ix_tx_agent ON transactions(agentId);
`;

const { nextAgentCode } = require('../lib/agentCode');

// Upgrades databases created by an older version of the app (safe to run every time).
function migrate(db) {
  const accCols = db.all('PRAGMA table_info(accounts)').map(c => c.name);
  if (!accCols.includes('terms')) db.exec("ALTER TABLE accounts ADD COLUMN terms TEXT DEFAULT '{}'");

  const cols = db.all('PRAGMA table_info(agents)').map(c => c.name);
  if (!cols.includes('agentCode')) db.exec('ALTER TABLE agents ADD COLUMN agentCode TEXT');

  // give every existing agent a code (oldest agent = ag01)
  const missing = db.all("SELECT id FROM agents WHERE agentCode IS NULL OR agentCode = '' ORDER BY rowid");
  if (missing.length) {
    db.tx(() => missing.forEach(a => db.run('UPDATE agents SET agentCode = ? WHERE id = ?', nextAgentCode(db), a.id)));
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_code ON agents(agentCode)');
}

const cache = new Map();   // companyId -> open Db

function safeId(companyId) {
  const id = String(companyId || '');
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid company id');
  return id;
}

function tenantFile(companyId) {
  return path.join(TENANT_DIR, `${safeId(companyId)}.db`);
}

// Open (and create on first use) the database of ONE company.
function getTenantDb(companyId) {
  const id = safeId(companyId);
  let db = cache.get(id);
  if (!db) {
    db = new Db(tenantFile(id));
    db.exec(SCHEMA);
    migrate(db);
    cache.set(id, db);
  }
  return db;
}

function closeAll() {
  for (const db of cache.values()) db.close();
  cache.clear();
}

module.exports = { getTenantDb, tenantFile, closeAll };
