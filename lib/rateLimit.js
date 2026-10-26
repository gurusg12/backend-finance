// Tiny in-memory rate limiter (enough for one server). Stops OTP / email spamming.
const hits = new Map();
setInterval(() => {                               // forget old entries
  const now = Date.now();
  for (const [k, v] of hits) if (now - v.last > v.windowMs) hits.delete(k);
}, 10 * 60 * 1000).unref();

// true → limit reached (do NOT continue); false → allowed (and counted)
function tooMany(name, key, windowMs, max) {
  const k = `${name}:${key}`;
  const now = Date.now();
  const rec = hits.get(k) || { times: [], windowMs, last: now };
  rec.times = rec.times.filter(t => now - t < windowMs);
  rec.windowMs = windowMs; rec.last = now;
  if (rec.times.length >= max) { hits.set(k, rec); return true; }
  rec.times.push(now);
  hits.set(k, rec);
  return false;
}

// Express middleware: limit per IP address
function rateLimit({ name, windowMs, max }) {
  return (req, res, next) => {
    if (tooMany(name, req.ip || 'ip', windowMs, max)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    }
    next();
  };
}

module.exports = { rateLimit, tooMany };
