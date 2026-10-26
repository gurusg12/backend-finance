const express = require('express');
const router = express.Router();
const M = require('../lib/mappers');
const { newId, nowISO, placeholders } = require('../db/driver');
const { authMiddleware, tenantGuard, companyAdminOnly } = require('../middleware/auth');

// IDs of the accounts an agent is allowed to see
function assignedIds(db, agentId) {
  return db.all('SELECT accountId FROM agent_accounts WHERE agentId = ?', agentId).map(r => r.accountId);
}

// GET all customers
router.get('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    const { search } = req.query;
    const where = [];
    const params = [];

    // Agent isolation: an agent only sees customers who own one of their assigned accounts.
    if (req.user.role === 'agent') {
      const ids = assignedIds(req.db, req.user.agentId);
      const custIds = ids.length
        ? [...new Set(req.db.all(`SELECT custId FROM accounts WHERE id IN ${placeholders(ids)}`, ...ids)
            .map(a => a.custId).filter(Boolean))]
        : [];
      if (!custIds.length) return res.json([]);
      where.push(`id IN ${placeholders(custIds)}`);
      params.push(...custIds);
    }

    if (search) {
      const like = `%${search}%`;
      where.push('(name LIKE ? OR custNo LIKE ? OR mobile LIKE ?)');
      params.push(like, like, like);
    }

    const rows = req.db.all(
      `SELECT * FROM customers ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY createdAt DESC, rowid DESC`,
      ...params);
    res.json(rows.map(M.customer));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create customer
router.post('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    const { name, mobile, address } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Customer name is required' });
    const db = req.db;

    if (db.get('SELECT id FROM customers WHERE name = ? COLLATE NOCASE', name.trim()))
      return res.status(400).json({ error: 'Customer name already exists' });

    const id = newId();
    db.tx(() => {
      // Next customer number = highest existing DRxxxx + 1 (never reuses a number after deletes)
      const last = db.get(`SELECT MAX(CAST(SUBSTR(custNo, 3) AS INTEGER)) AS n FROM customers WHERE custNo LIKE 'DR%'`);
      const custNo = 'DR' + String((last?.n || 0) + 1).padStart(4, '0');
      db.run('INSERT INTO customers (id, custNo, name, mobile, address, createdBy, createdAt) VALUES (?,?,?,?,?,?,?)',
        id, custNo, name.trim(), mobile || '', address || '',
        req.user.role === 'agent' ? req.user.agentId : 'admin', nowISO());
    });
    res.status(201).json(M.customer(db.get('SELECT * FROM customers WHERE id = ?', id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /import — add many customers at once (used by the CSV import screen). Admin only.
// Body: { customers: [{ name, mobile, address, row? }, ...] }
router.post('/import', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const list = req.body && req.body.customers;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ error: 'No customers to import' });
    if (list.length > 5000) return res.status(400).json({ error: 'Maximum 5000 customers per import' });

    const db = req.db;
    const skipped = [];
    let created = 0;

    db.tx(() => {
      const existing = new Set(db.all('SELECT name FROM customers').map(c => c.name.trim().toLowerCase()));
      const last = db.get(`SELECT MAX(CAST(SUBSTR(custNo, 3) AS INTEGER)) AS n FROM customers WHERE custNo LIKE 'DR%'`);
      let next = (last?.n || 0) + 1;

      list.forEach((r, i) => {
        const row  = r.row || i + 1;
        const name = String(r.name || '').trim().replace(/\s+/g, ' ');
        if (!name)           return skipped.push({ row, name, reason: 'Name is missing' });
        if (name.length > 120) return skipped.push({ row, name, reason: 'Name is too long' });
        const key = name.toLowerCase();
        if (existing.has(key)) return skipped.push({ row, name, reason: 'Customer already exists' });

        existing.add(key);
        db.run('INSERT INTO customers (id, custNo, name, mobile, address, createdBy, createdAt) VALUES (?,?,?,?,?,?,?)',
          newId(), 'DR' + String(next++).padStart(4, '0'), name,
          String(r.mobile || '').trim().slice(0, 30), String(r.address || '').trim().slice(0, 300), 'admin', nowISO());
        created++;
      });
    });

    res.json({ message: `${created} customer(s) imported`, created, skipped, total: list.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update customer
router.put('/:id', authMiddleware, tenantGuard, (req, res) => {
  try {
    const db = req.db;
    const c = db.get('SELECT * FROM customers WHERE id = ?', req.params.id);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const { name, mobile, address } = req.body;
    db.run('UPDATE customers SET name = ?, mobile = ?, address = ? WHERE id = ?',
      name !== undefined ? name : c.name,
      mobile !== undefined ? mobile : c.mobile,
      address !== undefined ? address : c.address,
      c.id);
    res.json(M.customer(db.get('SELECT * FROM customers WHERE id = ?', c.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE customer
router.delete('/:id', authMiddleware, tenantGuard, (req, res) => {
  try {
    const db = req.db;
    if (db.get('SELECT id FROM accounts WHERE custId = ? AND balance <> 0 LIMIT 1', req.params.id))
      return res.status(400).json({ error: 'Customer has accounts with balance' });

    db.tx(() => {
      const accIds = db.all('SELECT id FROM accounts WHERE custId = ?', req.params.id).map(a => a.id);
      if (accIds.length) db.run(`DELETE FROM agent_accounts WHERE accountId IN ${placeholders(accIds)}`, ...accIds);
      db.run('DELETE FROM accounts WHERE custId = ?', req.params.id);
      db.run('DELETE FROM customers WHERE id = ?', req.params.id);
    });
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
