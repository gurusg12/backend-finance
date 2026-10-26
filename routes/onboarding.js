// ─────────────────────────────────────────────────────────────────────────────
// Self-service sign-up and password recovery  (all routes are PUBLIC)
//
//   POST /api/auth/register/request   → validates the form, e-mails a 6-digit OTP
//   POST /api/auth/register/resend    → sends a new OTP
//   POST /api/auth/register/verify    → checks the OTP, creates the company with a 20-day trial
//   POST /api/auth/forgot-password    → e-mails a password-reset link (verified e-mails only)
//   GET  /api/auth/reset-password/validate?token=…
//   POST /api/auth/reset-password     → sets the new password
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const Company = require('../lib/company');
const mailer = require('../lib/mailer');
const { getMaster } = require('../db/master');
const { newId, nowISO } = require('../db/driver');
const { getTenantDb } = require('../db/tenant');
const { seedTenant } = require('../lib/seed');
const { validateEmail } = require('../lib/emailCheck');
const { rateLimit, tooMany } = require('../lib/rateLimit');
const { adminSession } = require('../lib/session');

const TRIAL_DAYS = 20;
const TRIAL_LIMITS = { maxAgents: 2, maxCustomers: 100 };
const OTP_MINUTES = 10;       // OTP valid for
const MAX_ATTEMPTS = 5;       // wrong OTP guesses allowed
const RESEND_SECONDS = 60;    // wait before asking for another OTP
const MAX_SENDS = 5;          // OTP e-mails per registration
const RESET_MINUTES = 30;     // reset link valid for

/* ── helpers ──────────────────────────────────────────────────────────────── */
const clean = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
const hmac = v => crypto.createHmac('sha256', process.env.JWT_SECRET).update(String(v)).digest('hex');
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const maskEmail = e => { const [l, d] = e.split('@'); return `${l.slice(0, 2)}${'*'.repeat(Math.max(2, l.length - 2))}@${d}`; };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const appUrl = () => (process.env.APP_URL || `http://localhost:${process.env.PORT || 6000}`).replace(/\/+$/, '');
const inMinutes = m => new Date(Date.now() + m * 60000).toISOString();

function purge() {                                  // delete old pending sign-ups / reset links
  const db = getMaster();
  const old = new Date(Date.now() - 3600000).toISOString();
  db.run('DELETE FROM registrations WHERE expiresAt < ?', old);
  db.run('DELETE FROM password_resets WHERE expiresAt < ?', old);
}

// Is this login name already used by a company admin, the super admin, or ANY agent?
function usernameTaken(username) {
  if (username.toLowerCase() === String(process.env.SUPER_ADMIN_USERNAME || '').toLowerCase()) return true;
  if (Company.findByAdminUsername(username)) return true;
  return Company.listAll().some(c =>
    getTenantDb(c.id).get('SELECT id FROM agents WHERE username = ? COLLATE NOCASE', username));
}

function sendFailed(res, err) {
  if (err && err.code === 'EMAIL_NOT_CONFIGURED') {
    return res.status(503).json({ error: 'Email service is not configured on the server. Please contact support.' });
  }
  console.error('✗ Email send failed:', err && err.message);
  return res.status(502).json({ error: 'Could not send the email. Please check the address and try again.' });
}

const otpMail = (name, otp) => ({
  subject: `${otp} is your FinSphere verification code`,
  text: `Hello ${name},\n\nYour FinSphere verification code is: ${otp}\n\nIt is valid for ${OTP_MINUTES} minutes. Do not share this code with anyone.\nIf you did not request it, you can ignore this email.\n\n— FinSphere`,
  html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
    <h2 style="margin:0 0 8px;color:#1e3a8a">FinSphere</h2>
    <p>Hello ${esc(name)},</p><p>Your verification code is</p>
    <p style="font-size:32px;letter-spacing:8px;font-weight:700;color:#111827;background:#f3f4f6;padding:12px;text-align:center;border-radius:8px">${otp}</p>
    <p style="color:#6b7280;font-size:13px">Valid for ${OTP_MINUTES} minutes. Do not share this code with anyone. If you did not request it, ignore this email.</p></div>`,
});

const resetMail = (name, link) => ({
  subject: 'Reset your FinSphere password',
  text: `Hello ${name},\n\nWe received a request to reset your FinSphere password.\nClick the link below to choose a new password (valid for ${RESET_MINUTES} minutes, one use only):\n\n${link}\n\nIf you did not ask for this, ignore this email — your password will not change.\n\n— FinSphere`,
  html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:12px">
    <h2 style="margin:0 0 8px;color:#1e3a8a">FinSphere</h2>
    <p>Hello ${esc(name)},</p><p>We received a request to reset your password. This link is valid for ${RESET_MINUTES} minutes and works once.</p>
    <p style="text-align:center;margin:24px 0"><a href="${link}" style="background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">Reset Password</a></p>
    <p style="color:#6b7280;font-size:12px;word-break:break-all">Or paste this link in your browser:<br>${link}</p>
    <p style="color:#6b7280;font-size:13px">If you did not ask for this, ignore this email — your password will not change.</p></div>`,
});

const newOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

/* ══════════════════════════ REGISTER ═════════════════════════════════════ */

// STEP 1 — validate form, e-mail the OTP
router.post('/register/request', rateLimit({ name: 'reg-req', windowMs: 15 * 60000, max: 10 }), async (req, res) => {
  try {
    purge();
    const b = req.body || {};
    const companyName = clean(b.companyName);
    const adminName = clean(b.adminName);
    const mobile = clean(b.mobile);
    const adminUsername = String(b.adminUsername || '').trim();
    const password = String(b.password || '');

    if (companyName.length < 2 || companyName.length > 120) return res.status(400).json({ error: 'Enter your company name (2–120 characters)' });
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(adminUsername)) return res.status(400).json({ error: 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if (mobile && !/^[0-9+\-\s()]{6,20}$/.test(mobile)) return res.status(400).json({ error: 'Enter a valid mobile number' });

    const ev = await validateEmail(b.email);                       // format + disposable + domain check
    if (!ev.ok) return res.status(400).json({ error: ev.error });
    const email = ev.email;

    if (Company.findByEmail(email)) return res.status(400).json({ error: 'This email is already registered. Please sign in, or use Forgot Password.' });
    if (Company.findByName(companyName)) return res.status(400).json({ error: 'A company with this name already exists' });
    if (usernameTaken(adminUsername)) return res.status(400).json({ error: 'This username is already taken. Please choose another.' });
    if (tooMany('reg-email', email, 60 * 60000, 5)) return res.status(429).json({ error: 'Too many verification emails for this address. Please try again after an hour.' });

    const db = getMaster();
    const otp = newOtp();
    const id = newId();
    const data = { companyName, adminName, mobile, adminUsername, passwordHash: await bcrypt.hash(password, 10) };

    db.tx(() => {
      db.run('DELETE FROM registrations WHERE email = ? COLLATE NOCASE', email);   // only one pending sign-up per email
      db.run(`INSERT INTO registrations (id, email, data, otpHash, expiresAt, attempts, sendCount, lastSentAt, createdAt)
              VALUES (?,?,?,?,?,0,1,?,?)`, id, email, JSON.stringify(data), hmac(id + otp), inMinutes(OTP_MINUTES), nowISO(), nowISO());
    });

    try {
      const m = otpMail(adminName || companyName, otp);
      await mailer.sendMail({ to: email, ...m });
    } catch (err) {
      db.run('DELETE FROM registrations WHERE id = ?', id);
      return sendFailed(res, err);
    }
    res.json({ registrationId: id, email: maskEmail(email), expiresInMinutes: OTP_MINUTES, resendAfterSeconds: RESEND_SECONDS });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send a fresh OTP for a pending registration
router.post('/register/resend', rateLimit({ name: 'reg-resend', windowMs: 15 * 60000, max: 10 }), async (req, res) => {
  try {
    const db = getMaster();
    const reg = db.get('SELECT * FROM registrations WHERE id = ?', String((req.body || {}).registrationId || ''));
    if (!reg) return res.status(400).json({ error: 'Registration expired. Please start again.', code: 'REGISTRATION_EXPIRED' });

    const wait = RESEND_SECONDS - Math.floor((Date.now() - new Date(reg.lastSentAt)) / 1000);
    if (wait > 0) return res.status(429).json({ error: `Please wait ${wait} seconds before requesting another code.` });
    if (reg.sendCount >= MAX_SENDS) {
      db.run('DELETE FROM registrations WHERE id = ?', reg.id);
      return res.status(429).json({ error: 'Too many codes requested. Please start the registration again.', code: 'REGISTRATION_EXPIRED' });
    }

    const data = JSON.parse(reg.data);
    const otp = newOtp();
    db.run('UPDATE registrations SET otpHash = ?, expiresAt = ?, attempts = 0, sendCount = sendCount + 1, lastSentAt = ? WHERE id = ?',
      hmac(reg.id + otp), inMinutes(OTP_MINUTES), nowISO(), reg.id);
    try {
      await mailer.sendMail({ to: reg.email, ...otpMail(data.adminName || data.companyName, otp) });
    } catch (err) { return sendFailed(res, err); }
    res.json({ message: 'A new code has been sent', email: maskEmail(reg.email), expiresInMinutes: OTP_MINUTES, resendAfterSeconds: RESEND_SECONDS });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// STEP 2 — check the OTP, create the company (20-day free trial) and sign in
router.post('/register/verify', rateLimit({ name: 'reg-verify', windowMs: 15 * 60000, max: 30 }), async (req, res) => {
  try {
    const db = getMaster();
    const { registrationId } = req.body || {};
    const otp = String((req.body || {}).otp || '').trim();
    const reg = db.get('SELECT * FROM registrations WHERE id = ?', String(registrationId || ''));
    if (!reg) return res.status(400).json({ error: 'Registration expired. Please start again.', code: 'REGISTRATION_EXPIRED' });
    if (new Date(reg.expiresAt) < new Date()) {
      db.run('DELETE FROM registrations WHERE id = ?', reg.id);
      return res.status(400).json({ error: 'The code has expired. Please register again.', code: 'REGISTRATION_EXPIRED' });
    }
    if (!/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Enter the 6-digit code' });

    if (!safeEq(hmac(reg.id + otp), reg.otpHash)) {
      if (reg.attempts + 1 >= MAX_ATTEMPTS) {
        db.run('DELETE FROM registrations WHERE id = ?', reg.id);
        return res.status(400).json({ error: 'Too many wrong codes. Please register again.', code: 'REGISTRATION_EXPIRED' });
      }
      db.run('UPDATE registrations SET attempts = attempts + 1 WHERE id = ?', reg.id);
      return res.status(400).json({ error: `Incorrect code. ${MAX_ATTEMPTS - reg.attempts - 1} attempt(s) left.` });
    }

    // OTP is correct → the e-mail is verified. Re-check nobody took the name / username meanwhile.
    const data = JSON.parse(reg.data);
    if (Company.findByEmail(reg.email) || Company.findByName(data.companyName) || usernameTaken(data.adminUsername)) {
      db.run('DELETE FROM registrations WHERE id = ?', reg.id);
      return res.status(400).json({ error: 'Company name, username or email was taken while you were verifying. Please register again.', code: 'REGISTRATION_EXPIRED' });
    }

    const now = nowISO();
    const company = Company.insert({
      name: data.companyName, adminName: data.adminName, mobile: data.mobile, email: reg.email, emailVerified: true,
      adminUsername: data.adminUsername, adminPasswordHash: data.passwordHash,
      plan: 'trial', subscriptionStart: now,
      subscriptionEnd: new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString(),
      ...TRIAL_LIMITS, notes: 'Self-registered (email verified)',
    });
    try { seedTenant(getTenantDb(company.id)); }
    catch (e) { db.run('DELETE FROM companies WHERE id = ?', company.id); throw e; }

    db.run('DELETE FROM registrations WHERE id = ?', reg.id);
    res.status(201).json({ ...adminSession(company), message: `Welcome! Your ${TRIAL_DAYS}-day free trial has started.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═════════════════════════ FORGOT / RESET PASSWORD ═══════════════════════ */

router.post('/forgot-password', rateLimit({ name: 'forgot', windowMs: 15 * 60000, max: 10 }), async (req, res) => {
  try {
    purge();
    const ev = await validateEmail((req.body || {}).email);
    if (!ev.ok) return res.status(400).json({ error: ev.error });

    const company = Company.findByEmail(ev.email);
    if (!company || !company.emailVerified) {
      return res.status(404).json({ error: 'This email is not registered or has not been verified.' });
    }
    if (!company.isActive) return res.status(403).json({ error: 'This company account is suspended. Please contact support.' });
    if (tooMany('forgot-email', ev.email, 60 * 60000, 3)) {
      return res.status(429).json({ error: 'Too many reset requests for this email. Please try again after an hour.' });
    }

    const db = getMaster();
    const token = crypto.randomBytes(32).toString('hex');
    db.tx(() => {
      db.run('DELETE FROM password_resets WHERE companyId = ?', company.id);          // older links stop working
      db.run('INSERT INTO password_resets (id, companyId, tokenHash, expiresAt, createdAt) VALUES (?,?,?,?,?)',
        newId(), company.id, sha256(token), inMinutes(RESET_MINUTES), nowISO());
    });

    const link = `${appUrl()}/reset-password?token=${token}`;
    try {
      await mailer.sendMail({ to: company.email, ...resetMail(company.adminName || company.name, link) });
    } catch (err) {
      db.run('DELETE FROM password_resets WHERE companyId = ?', company.id);
      return sendFailed(res, err);
    }
    res.json({ message: 'Password reset link sent', email: maskEmail(company.email), expiresInMinutes: RESET_MINUTES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function findReset(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const row = getMaster().get('SELECT * FROM password_resets WHERE tokenHash = ?', sha256(token));
  return row && new Date(row.expiresAt) > new Date() ? row : null;
}

// lets the page say "link expired" immediately
router.get('/reset-password/validate', rateLimit({ name: 'reset-check', windowMs: 15 * 60000, max: 60 }), (req, res) => {
  const row = findReset(req.query.token);
  if (!row) return res.status(400).json({ valid: false, error: 'This reset link is invalid or has expired. Please request a new one.' });
  res.json({ valid: true });
});

router.post('/reset-password', rateLimit({ name: 'reset', windowMs: 15 * 60000, max: 20 }), async (req, res) => {
  try {
    const { token } = req.body || {};
    const password = String((req.body || {}).password || '');
    const row = findReset(token);
    if (!row) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const company = Company.findById(row.companyId);
    if (!company) return res.status(400).json({ error: 'Account not found' });

    company.adminPasswordHash = await bcrypt.hash(password, 10);
    Company.save(company);
    getMaster().run('DELETE FROM password_resets WHERE companyId = ?', company.id);   // link works only once
    res.json({ message: 'Password updated. You can now sign in with your new password.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
