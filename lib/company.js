// ─────────────────────────────────────────────────────────────────────────────
// Company (tenant) storage in master.db + the billing calculations that used to
// live in the Mongoose "pre save" hook.
// ─────────────────────────────────────────────────────────────────────────────
const { getMaster } = require('../db/master');
const { newId, nowISO } = require('../db/driver');
const { parseJSON } = require('./mappers');

const BILLING_DEFAULTS = {
  softwarePrice: 0, amcAmount: 0, taxType: 'without_tax',
  agentPrice: 0, agentCount: 0, agentTotal: 0,
  activeUserPrice: 0, activeUserCount: 0, activeUserTotal: 0,
  websiteSaleAmount: 0, grandTotal: 0,
  fromDate: null, billingNotes: '', paymentHistory: [],
};

// Re-calculate the cached totals (same maths as the old pre-save hook)
function computeBilling(b) {
  const x = { ...BILLING_DEFAULTS, ...(b || {}) };
  const n = v => Number(v) || 0;
  x.agentTotal      = n(x.agentPrice) * n(x.agentCount);
  x.activeUserTotal = n(x.activeUserPrice) * n(x.activeUserCount);
  x.grandTotal      = n(x.softwarePrice) + n(x.amcAmount) + x.agentTotal + x.activeUserTotal + n(x.websiteSaleAmount);
  if (!Array.isArray(x.paymentHistory)) x.paymentHistory = [];
  return x;
}

function computePaymentStatus(grandTotal, paid) {
  const total = Number(grandTotal) || 0;
  const p = Number(paid) || 0;
  if (total <= 0) return 'unpaid';
  if (total - p <= 0) return 'paid';
  if (p > 0) return 'partial';
  return 'unpaid';
}

/* ── row <-> doc ─────────────────────────────────────────────────────────── */
function rowToDoc(r) {
  if (!r) return null;
  return {
    ...r,
    isActive: !!r.isActive,
    emailVerified: !!r.emailVerified,
    billing: computeBilling({ fromDate: r.createdAt, ...parseJSON(r.billing, {}) }),
  };
}

const COLUMNS = [
  'name', 'slug', 'adminUsername', 'adminPasswordHash', 'logo', 'address', 'city', 'state', 'pincode',
  'mobile', 'email', 'emailVerified', 'website', 'adminName', 'businessType', 'recoveryMobile', 'recoveryEmail', 'plan',
  'subscriptionStart', 'subscriptionEnd', 'maxAgents', 'maxCustomers', 'notes', 'isActive', 'suspendReason',
  'billing', 'paidAmount', 'paymentStatus', 'createdAt', 'updatedAt',
];

function prepare(doc) {
  doc.updatedAt = nowISO();
  if (!doc.slug) doc.slug = String(doc.name).toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now();
  doc.billing = computeBilling(doc.billing);
  doc.paymentStatus = computePaymentStatus(doc.billing.grandTotal, doc.paidAmount);
  return doc;
}

const values = doc => COLUMNS.map(c => (c === 'billing' ? JSON.stringify(doc.billing) : doc[c]));

/* ── public API ──────────────────────────────────────────────────────────── */
function findById(id) {
  return rowToDoc(getMaster().get('SELECT * FROM companies WHERE id = ?', id));
}

function listAll() {
  return getMaster().all('SELECT * FROM companies ORDER BY createdAt DESC, rowid DESC').map(rowToDoc);
}

function listActive() {
  return getMaster().all('SELECT * FROM companies WHERE isActive = 1 ORDER BY createdAt DESC, rowid DESC').map(rowToDoc);
}

function findByName(name) {
  return rowToDoc(getMaster().get('SELECT * FROM companies WHERE name = ? COLLATE NOCASE', String(name).trim()));
}

function findByEmail(email) {
  const e = String(email || '').trim();
  if (!e) return null;
  return rowToDoc(getMaster().get("SELECT * FROM companies WHERE email = ? COLLATE NOCASE AND email <> '' LIMIT 1", e));
}

function findByAdminUsername(username, onlyActive = false) {
  return rowToDoc(getMaster().get(
    `SELECT * FROM companies WHERE adminUsername = ? COLLATE NOCASE ${onlyActive ? 'AND isActive = 1' : ''} ORDER BY rowid LIMIT 1`,
    String(username).trim()
  ));
}

// Create a company. `data` holds the fields; defaults are filled in here.
function insert(data) {
  const now = nowISO();
  const doc = prepare({
    id: newId(),
    logo: null, address: '', city: '', state: '', pincode: '', mobile: '', email: '', website: '',
    adminName: '', emailVerified: false, businessType: 'Finance', recoveryMobile: '', recoveryEmail: '',
    plan: 'trial', subscriptionStart: now,
    subscriptionEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
    maxAgents: 5, maxCustomers: 500, notes: '', isActive: true, suspendReason: '',
    paidAmount: 0, createdAt: now,
    ...data,
    billing: { fromDate: now, ...(data.billing || {}) },
  });
  getMaster().run(
    `INSERT INTO companies (id, ${COLUMNS.join(', ')}) VALUES (?, ${COLUMNS.map(() => '?').join(', ')})`,
    doc.id, ...values(doc)
  );
  return findById(doc.id);
}

// Save every field of an existing company doc.
function save(doc) {
  prepare(doc);
  getMaster().run(
    `UPDATE companies SET ${COLUMNS.map(c => `${c} = ?`).join(', ')} WHERE id = ?`,
    ...values(doc), doc.id
  );
  return findById(doc.id);
}

// JSON sent to the browser (never includes the password hash)
function toJSON(doc, { withHash = false } = {}) {
  if (!doc) return null;
  const { adminPasswordHash, ...rest } = doc;
  const out = {
    ...rest,
    _id: doc.id,
    isActive: !!doc.isActive,
    ...(withHash ? { adminPasswordHash } : {}),
  };
  const end = doc.subscriptionEnd;
  out.isExpired = !!end && new Date() > new Date(end);
  out.daysRemaining = end ? Math.max(0, Math.ceil((new Date(end) - new Date()) / 86400000)) : 0;
  out.remainingAmount = Math.max(0, (doc.billing.grandTotal || 0) - (doc.paidAmount || 0));
  return out;
}

const isExpired = doc => !!doc.subscriptionEnd && new Date() > new Date(doc.subscriptionEnd);
const daysRemaining = doc => doc.subscriptionEnd
  ? Math.max(0, Math.ceil((new Date(doc.subscriptionEnd) - new Date()) / 86400000)) : 0;

module.exports = {
  findById, listAll, listActive, findByName, findByEmail, findByAdminUsername, insert, save, toJSON,
  isExpired, daysRemaining, computeBilling, computePaymentStatus,
};
