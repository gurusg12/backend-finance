// ─────────────────────────────────────────────────────────────────────────────
// MASTER database  →  data/master.db
// Holds: the list of companies (tenants) + the Super Admin's own platform books.
// Every company's real business data lives in its OWN file (see db/tenant.js).
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { Db } = require('./driver');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const TENANT_DIR = path.join(DATA_DIR, 'tenants');
fs.mkdirSync(TENANT_DIR, { recursive: true });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT UNIQUE,
  adminUsername     TEXT NOT NULL,
  adminPasswordHash TEXT NOT NULL,
  logo              TEXT,
  address           TEXT DEFAULT '',
  city              TEXT DEFAULT '',
  state             TEXT DEFAULT '',
  pincode           TEXT DEFAULT '',
  mobile            TEXT DEFAULT '',
  email             TEXT DEFAULT '',
  emailVerified     INTEGER DEFAULT 0,          -- 1 = owner proved the mailbox with an OTP
  website           TEXT DEFAULT '',
  adminName         TEXT DEFAULT '',
  businessType      TEXT DEFAULT 'Finance',
  recoveryMobile    TEXT DEFAULT '',
  recoveryEmail     TEXT DEFAULT '',
  plan              TEXT DEFAULT 'trial',
  subscriptionStart TEXT,
  subscriptionEnd   TEXT,
  maxAgents         INTEGER DEFAULT 5,
  maxCustomers      INTEGER DEFAULT 500,
  notes             TEXT DEFAULT '',
  isActive          INTEGER DEFAULT 1,
  suspendReason     TEXT DEFAULT '',
  billing           TEXT DEFAULT '{}',          -- JSON (prices, totals, paymentHistory)
  paidAmount        REAL DEFAULT 0,
  paymentStatus     TEXT DEFAULT 'unpaid',
  createdAt         TEXT,
  updatedAt         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_company_name  ON companies(name COLLATE NOCASE);
CREATE INDEX        IF NOT EXISTS ix_company_admin ON companies(adminUsername COLLATE NOCASE);

-- pending self-registrations (company is created only after the OTP is verified)
CREATE TABLE IF NOT EXISTS registrations (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  data       TEXT NOT NULL,                     -- JSON: company name, username, password HASH …
  otpHash    TEXT NOT NULL,
  expiresAt  TEXT NOT NULL,
  attempts   INTEGER DEFAULT 0,
  sendCount  INTEGER DEFAULT 1,
  lastSentAt TEXT,
  createdAt  TEXT
);
CREATE INDEX IF NOT EXISTS ix_reg_email ON registrations(email COLLATE NOCASE);

-- password-reset links (only a hash of the token is stored)
CREATE TABLE IF NOT EXISTS password_resets (
  id        TEXT PRIMARY KEY,
  companyId TEXT NOT NULL,
  tokenHash TEXT NOT NULL UNIQUE,
  expiresAt TEXT NOT NULL,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS platform_groups (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL UNIQUE,
  type      TEXT NOT NULL,
  isDefault INTEGER DEFAULT 0,
  createdAt TEXT
);

CREATE TABLE IF NOT EXISTS platform_accounts (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  grp       TEXT NOT NULL,
  type      TEXT DEFAULT 'other',
  balance   REAL DEFAULT 0,
  status    TEXT DEFAULT 'active',
  isDefault INTEGER DEFAULT 0,
  opDate    TEXT,
  createdAt TEXT
);
CREATE INDEX IF NOT EXISTS ix_pacc_group ON platform_accounts(grp);

CREATE TABLE IF NOT EXISTS platform_transactions (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL,
  category          TEXT NOT NULL,
  tenantCompanyId   TEXT,
  cashAccountId     TEXT NOT NULL,
  categoryAccountId TEXT NOT NULL,
  amt               REAL NOT NULL,
  description       TEXT DEFAULT '',
  createdAt         TEXT
);
CREATE INDEX IF NOT EXISTS ix_ptx_date   ON platform_transactions(date DESC, createdAt DESC);
CREATE INDEX IF NOT EXISTS ix_ptx_tenant ON platform_transactions(tenantCompanyId);
`;

// Upgrades a master.db created by an older version (safe to run every time)
function migrate(db) {
  const cols = db.all('PRAGMA table_info(companies)').map(c => c.name);
  if (!cols.includes('emailVerified')) db.exec('ALTER TABLE companies ADD COLUMN emailVerified INTEGER DEFAULT 0');
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_company_email ON companies(email COLLATE NOCASE) WHERE email IS NOT NULL AND email <> ''");
  } catch (e) {
    console.warn('• Two companies already share one email — unique-email index skipped. Fix the duplicates in Super Admin.');
  }
}

let master = null;
function getMaster() {
  if (!master) {
    master = new Db(path.join(DATA_DIR, 'master.db'));
    master.exec(SCHEMA);
    migrate(master);
  }
  return master;
}

module.exports = { getMaster, DATA_DIR, TENANT_DIR };
