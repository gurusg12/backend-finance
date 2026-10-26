// ─────────────────────────────────────────────────────────────────────────────
// Email validation — rejects fake addresses BEFORE we send anything.
//   1. correct format
//   2. not a disposable / throw-away / example domain
//   3. the domain really exists and can receive mail (DNS MX lookup)
// The OTP / reset link then proves the person owns the mailbox.
// ─────────────────────────────────────────────────────────────────────────────
const dns = require('dns').promises;

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com',
  '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmailo.com',
  'yopmail.com', 'yopmail.net', 'trashmail.com', 'trashmail.net', 'getnada.com', 'nada.email',
  'throwawaymail.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com', 'mailnesia.com', 'moakt.com',
  'emailondeck.com', 'mintemail.com', 'mohmal.com', 'spamgourmet.com', 'tempinbox.com', 'burnermail.io',
  'mytemp.email', 'inboxkitten.com', 'discard.email', 'mailcatch.com', 'spambox.us', 'grr.la',
]);
const FAKE_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'domain.com', 'email.com', 'mail.com.test']);
const BLOCKED_TLDS = new Set(['test', 'invalid', 'example', 'localhost', 'local', 'lan', 'internal']);

const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const normalizeEmail = e => String(e || '').trim().toLowerCase();

function syntaxError(email) {
  if (!email) return 'Email address is required';
  if (email.length > 254) return 'Email address is too long';
  if (!EMAIL_RE.test(email)) return 'Please enter a valid email address';
  const [local, domain] = email.split('@');
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return 'Please enter a valid email address';
  const tld = domain.split('.').pop();
  if (tld.length < 2 || !/^[a-z]{2,}$|^xn--[a-z0-9-]+$/.test(tld)) return 'Please enter a valid email address';
  if (BLOCKED_TLDS.has(tld) || FAKE_DOMAINS.has(domain)) return 'Please use your real email address';
  if (DISPOSABLE.has(domain)) return 'Temporary / disposable email addresses are not allowed';
  return '';
}

function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), ms);
    Promise.resolve().then(fn).then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

const cache = new Map();   // domain -> { ok, at }   (only definite answers are cached)
const TTL = 10 * 60 * 1000;
const definite = e => e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA');

// true  → domain can receive mail
// false → domain does not exist / has no mail server
async function domainCanReceiveMail(domain) {
  if (String(process.env.SKIP_MX_CHECK).toLowerCase() === 'true') return true;
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL) return hit.ok;

  let ok;
  try {
    const mx = await withTimeout(() => dns.resolveMx(domain), 4000);
    if (mx.length === 1 && (!mx[0].exchange || mx[0].exchange === '.')) ok = false;   // "null MX" = accepts no mail
    else if (mx.length > 0) ok = true;
    // no MX records at all → fall through to the A / AAAA check below
  } catch (e) {
    if (!definite(e)) return true;              // timeout / SERVFAIL → don't block (OTP still protects us), don't cache
  }

  if (ok === undefined) {
    // no MX record: mail servers may still use the domain's A record
    try {
      const a = await withTimeout(() => dns.resolve4(domain), 4000);
      ok = a.length > 0;
    } catch (e2) {
      if (definite(e2)) ok = false;
      else return true;
    }
  }
  cache.set(domain, { ok, at: Date.now() });
  return ok;
}

// → { ok:true, email } or { ok:false, error }
async function validateEmail(raw) {
  const email = normalizeEmail(raw);
  const err = syntaxError(email);
  if (err) return { ok: false, error: err };
  const domain = email.split('@')[1];
  if (!(await domainCanReceiveMail(domain))) {
    return { ok: false, error: 'This email domain does not exist or cannot receive email. Please check the address.' };
  }
  return { ok: true, email };
}

module.exports = { validateEmail, normalizeEmail, syntaxError };
