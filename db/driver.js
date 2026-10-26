// ─────────────────────────────────────────────────────────────────────────────
// SQLite driver wrapper
//  • Uses "better-sqlite3" (installed by npm).
//  • If it cannot be loaded (e.g. native build failed), falls back to the
//    SQLite built into Node.js 22+ ("node:sqlite") so the app still runs.
//  • Gives every database the same tiny API: run / get / all / exec / tx.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

let NativeDB = null;
let driverName = '';

try {
  const Better = require('better-sqlite3');
  new Better(':memory:').close();            // make sure the native binary really loads
  NativeDB = Better;
  driverName = 'better-sqlite3';
} catch (e) {
  try {
    NativeDB = require('node:sqlite').DatabaseSync;
    driverName = 'node:sqlite';
  } catch (e2) {
    throw new Error(
      'No SQLite driver available. Run "npm install" in the backend folder ' +
      '(installs better-sqlite3) or use Node.js 22 or newer.'
    );
  }
}

// SQLite only accepts numbers / strings / null — convert everything else.
function clean(params) {
  return params.map(p => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    return p;
  });
}

class Db {
  constructor(file) {
    this.raw = new NativeDB(file);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this._cache = new Map();
  }
  _stmt(sql) {
    let s = this._cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this._cache.set(sql, s); }
    return s;
  }
  exec(sql)            { this.raw.exec(sql); }
  run(sql, ...params)  { return this._stmt(sql).run(...clean(params)); }
  get(sql, ...params)  { const r = this._stmt(sql).get(...clean(params)); return r ? { ...r } : null; }
  all(sql, ...params)  { return this._stmt(sql).all(...clean(params)).map(r => ({ ...r })); }

  // Run several statements as ONE all-or-nothing unit.
  // (Everything inside fn must be synchronous — no await.)
  tx(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.raw.exec('ROLLBACK'); } catch (_) {}
      throw err;
    }
  }
  close() { try { this.raw.close(); } catch (_) {} }
}

const newId = () => crypto.randomBytes(12).toString('hex');   // 24-char id, same look as before
const nowISO = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().split('T')[0];
const placeholders = arr => '(' + arr.map(() => '?').join(',') + ')';

module.exports = { Db, newId, nowISO, todayStr, placeholders, driverName: () => driverName };
