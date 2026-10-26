const express = require('express');
const router = express.Router();
const M = require('../lib/mappers');
const { newId, nowISO } = require('../db/driver');
const { authMiddleware, tenantGuard, companyAdminOnly } = require('../middleware/auth');

const TYPES = ['Asset', 'Liability', 'Income', 'Expense', 'Equity'];

router.get('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    res.json(req.db.all('SELECT * FROM groups ORDER BY type, name').map(M.group));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || !TYPES.includes(type)) return res.status(400).json({ error: 'Valid name and type are required' });
    if (req.db.get('SELECT id FROM groups WHERE name = ? COLLATE NOCASE', name.trim()))
      return res.status(400).json({ error: 'Group name already exists' });
    const id = newId();
    req.db.run('INSERT INTO groups (id, name, type, isDefault, createdAt) VALUES (?,?,?,0,?)', id, name.trim(), type, nowISO());
    res.status(201).json(M.group(req.db.get('SELECT * FROM groups WHERE id = ?', id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const db = req.db;
    const existing = db.get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
    const type = req.body.type !== undefined ? req.body.type : existing.type;
    const isDefault = req.body.isDefault !== undefined ? req.body.isDefault : !!existing.isDefault;
    if (!name || !TYPES.includes(type)) return res.status(400).json({ error: 'Valid name and type are required' });
    if (name.toLowerCase() !== existing.name.toLowerCase() &&
        db.get('SELECT id FROM groups WHERE name = ? COLLATE NOCASE', name))
      return res.status(400).json({ error: 'Group name already exists' });

    db.tx(() => {
      db.run('UPDATE groups SET name = ?, type = ?, isDefault = ? WHERE id = ?', name, type, isDefault, existing.id);
      if (name !== existing.name) {
        // keep accounts / account types pointing at the renamed group
        db.run('UPDATE accounts SET grp = ? WHERE grp = ?', name, existing.name);
        db.run('UPDATE account_types SET grp = ? WHERE grp = ?', name, existing.name);
      }
    });
    res.json(M.group(db.get('SELECT * FROM groups WHERE id = ?', existing.id)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const g = req.db.get('SELECT * FROM groups WHERE id = ?', req.params.id);
    if (!g) return res.status(404).json({ error: 'Not found' });
    if (req.db.get('SELECT id FROM accounts WHERE grp = ? LIMIT 1', g.name))
      return res.status(400).json({ error: 'Cannot delete: accounts exist in this group' });
    req.db.run('DELETE FROM groups WHERE id = ?', g.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
