// ─────────────────────────────────────────────────────────────────────────────
// Company CONFIGURATION — default terms for Loans, Deposits and Pigmy
// (interest, late fee, grace period, due day …).  One row per company, stored in
// that company's own database (table "config").
//
// New accounts copy these defaults into their own "terms", so changing the
// configuration later never silently changes accounts that already exist.
// ─────────────────────────────────────────────────────────────────────────────
const { nowISO } = require('../db/driver');
const { parseJSON } = require('./mappers');

const num  = (min, max) => ({ t: 'num', min, max });
const en   = (...values) => ({ t: 'enum', values });
const bool = () => ({ t: 'bool' });
const text = (max = 80) => ({ t: 'text', max });

const PERIOD_TYPES = ['days', 'months', 'years'];
const LATE_FEE_TYPES = ['none', 'flat', 'per_day', 'percent'];

// ── what can be configured (and the limits) ──
const SCHEMA = {
  loan: {
    interestRate:     num(0, 100),            // % p.a.
    interestMethod:   en('reducing', 'fixed'),
    tenure:           num(1, 600),
    tenureType:       en(...PERIOD_TYPES),
    dueDay:           num(1, 28),             // EMI falls due on this day of every month
    graceDays:        num(0, 90),             // no late fee until this many days after the due date
    lateFeeFrom:      en('grace', 'due'),     // grace = count days after the grace period · due = count from the due date onwards (once grace is over)
    lateFeeType:      en(...LATE_FEE_TYPES),  // flat = once per overdue EMI · per_day = ₹ per day · percent = % of EMI per month
    lateFee:          num(0, 1000000),
    processingFeePct: num(0, 100),            // % of loan amount, charged at disbursement
    foreclosurePct:   num(0, 100),            // % of outstanding, charged on pre-closure
  },
  deposit: {
    interestRate:        num(0, 100),
    tenure:              num(1, 600),
    tenureType:          en(...PERIOD_TYPES),
    interestPayout:      en('maturity', 'monthly', 'quarterly', 'yearly'),
    prematurePenaltyPct: num(0, 100),         // interest rate is reduced by this many % p.a. on early withdrawal
  },
  pigmy: {
    interestRate:        num(0, 100),
    tenure:              num(1, 600),
    tenureType:          en(...PERIOD_TYPES),
    minDailyAmount:      num(0, 1000000),
    prematurePenaltyPct: num(0, 100),
  },
  general: {
    reminderDays: num(1, 60),                 // dashboard "Reminders & Alerts" look-ahead window
  },
};

const DEFAULTS = {
  loan:    { interestRate: 12, interestMethod: 'reducing', tenure: 12, tenureType: 'months', dueDay: 5, graceDays: 3,
             lateFeeFrom: 'grace', lateFeeType: 'flat', lateFee: 100, processingFeePct: 1, foreclosurePct: 2 },
  deposit: { interestRate: 7, tenure: 12, tenureType: 'months', interestPayout: 'maturity', prematurePenaltyPct: 1 },
  pigmy:   { interestRate: 6, tenure: 12, tenureType: 'months', minDailyAmount: 10, prematurePenaltyPct: 1 },
  general: { reminderDays: 7 },
};

// which config keys are copied into an account's own terms when it is opened
const TERM_KEYS = {
  loan:    ['lateFeeType', 'lateFeeFrom', 'lateFee', 'graceDays', 'dueDay', 'processingFeePct', 'foreclosurePct'],
  deposit: ['interestPayout', 'prematurePenaltyPct'],
  pigmy:   ['prematurePenaltyPct'],
};

// keys an individual account may carry in "terms"
const ACCOUNT_TERMS = {
  lateFeeType: en(...LATE_FEE_TYPES), lateFeeFrom: en('grace', 'due'), lateFee: num(0, 1000000), graceDays: num(0, 90), dueDay: num(1, 28),
  processingFeePct: num(0, 100), foreclosurePct: num(0, 100),
  interestPayout: en('maturity', 'monthly', 'quarterly', 'yearly'), prematurePenaltyPct: num(0, 100),
  collectorName: text(80), dailyAmount: num(0, 1000000),
};

function coerce(spec, value, label) {
  if (spec.t === 'num') {
    const n = Number(value);
    if (value === '' || value === null || !Number.isFinite(n)) throw new Error(`${label} must be a number`);
    if (n < spec.min || n > spec.max) throw new Error(`${label} must be between ${spec.min} and ${spec.max}`);
    return n;
  }
  if (spec.t === 'enum') {
    if (!spec.values.includes(value)) throw new Error(`${label} is not a valid option`);
    return value;
  }
  if (spec.t === 'bool') return value === true || value === 'true' || value === 1;
  return String(value == null ? '' : value).trim().slice(0, spec.max);
}

// keep only known keys, validate them; unknown keys are silently dropped
function sanitize(schema, input, prefix = '') {
  const out = {};
  Object.keys(schema).forEach(k => {
    if (input && input[k] !== undefined) out[k] = coerce(schema[k], input[k], prefix + k);
  });
  return out;
}

function getConfig(db) {
  const row = db.get("SELECT value FROM config WHERE key = 'config'");
  const saved = row ? parseJSON(row.value, {}) : {};
  const out = {};
  Object.keys(DEFAULTS).forEach(sec => { out[sec] = { ...DEFAULTS[sec], ...(saved[sec] || {}) }; });
  return out;
}

// patch = { loan: {...}, deposit: {...} }  — only the sections / keys sent are changed
function saveConfig(db, patch) {
  const current = getConfig(db);
  Object.keys(SCHEMA).forEach(sec => {
    if (patch && patch[sec] && typeof patch[sec] === 'object') {
      current[sec] = { ...current[sec], ...sanitize(SCHEMA[sec], patch[sec], `${sec}.`) };
    }
  });
  db.run(
    `INSERT INTO config (key, value, updatedAt) VALUES ('config', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`,
    JSON.stringify(current), nowISO());
  return current;
}

// loan | deposit | pigmy | other   (group TYPE decides: Asset = loan, Liability = deposit)
function categoryFor(db, typeName, groupName) {
  if (/pigmy/i.test(typeName || '')) return 'pigmy';
  const g = db.get('SELECT type FROM groups WHERE name = ?', groupName);
  if (g && g.type === 'Asset') return 'loan';
  if (g && g.type === 'Liability') return 'deposit';
  return 'other';
}

// default terms a brand-new account of this category starts with
function termsDefaults(config, category) {
  const keys = TERM_KEYS[category] || [];
  const out = {};
  keys.forEach(k => { if (config[category] && config[category][k] !== undefined) out[k] = config[category][k]; });
  return out;
}

const cleanTerms = input => sanitize(ACCOUNT_TERMS, input, 'terms.');

module.exports = { DEFAULTS, getConfig, saveConfig, categoryFor, termsDefaults, cleanTerms };
