const express = require('express');
const router = express.Router();
const M = require('../lib/mappers');
const { newId, nowISO } = require('../db/driver');
const { authMiddleware, tenantGuard, companyAdminOnly } = require('../middleware/auth');

router.get('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    res.json(req.db.all('SELECT * FROM account_types ORDER BY name').map(M.accountType));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { name, prefix, group } = req.body;
    if (!name || !prefix || !group) return res.status(400).json({ error: 'Name, prefix and group are required' });
    const pre = String(prefix).trim().toUpperCase();
    if (req.db.get('SELECT id FROM account_types WHERE name = ? COLLATE NOCASE OR prefix = ?', name.trim(), pre))
      return res.status(400).json({ error: 'Name or prefix already exists' });
    const id = newId();
    req.db.run('INSERT INTO account_types (id, name, prefix, grp, isDefault, createdAt) VALUES (?,?,?,?,0,?)',
      id, name.trim(), pre, group, nowISO());
    res.status(201).json(M.accountType(req.db.get('SELECT * FROM account_types WHERE id = ?', id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const db = req.db;
    const existing = db.get('SELECT * FROM account_types WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const name   = req.body.name   !== undefined ? String(req.body.name).trim() : existing.name;
    const prefix = req.body.prefix !== undefined ? String(req.body.prefix).trim().toUpperCase() : existing.prefix;
    const grp    = req.body.group  !== undefined ? req.body.group : existing.grp;

    if (db.get('SELECT id FROM account_types WHERE id <> ? AND (name = ? COLLATE NOCASE OR prefix = ?)', existing.id, name, prefix))
      return res.status(400).json({ error: 'Name or prefix already exists' });

    db.tx(() => {
      db.run('UPDATE account_types SET name = ?, prefix = ?, grp = ? WHERE id = ?', name, prefix, grp, existing.id);
      if (name !== existing.name) db.run('UPDATE accounts SET type = ? WHERE type = ?', name, existing.name);
      if (grp !== existing.grp)   db.run('UPDATE accounts SET grp = ? WHERE type = ?', grp, name);
    });
    res.json(M.accountType(db.get('SELECT * FROM account_types WHERE id = ?', existing.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const at = req.db.get('SELECT * FROM account_types WHERE id = ?', req.params.id);
    if (!at) return res.status(404).json({ error: 'Not found' });
    if (req.db.get('SELECT id FROM accounts WHERE type = ? LIMIT 1', at.name))
      return res.status(400).json({ error: 'Cannot delete: accounts exist with this type' });
    req.db.run('DELETE FROM account_types WHERE id = ?', at.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
