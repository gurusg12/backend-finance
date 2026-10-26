const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const Company = require('../lib/company');
const { authMiddleware, tenantGuard, companyAdminOnly } = require('../middleware/auth');

// GET company settings
router.get('/', authMiddleware, tenantGuard, (req, res) => {
  try {
    const company = Company.findById(req.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(Company.toJSON(company));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update org details
router.put('/org', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const company = Company.findById(req.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    if (req.body.email !== undefined && String(req.body.email).trim().toLowerCase() !== String(company.email || '').toLowerCase()) {
      const dupEmail = Company.findByEmail(req.body.email);
      if (dupEmail && dupEmail.id !== company.id) return res.status(400).json({ error: 'This email is already used by another company' });
      company.emailVerified = false;                // a new address must be verified again
    }
    ['name', 'adminName', 'mobile', 'email', 'city', 'address', 'logo'].forEach(k => {
      if (req.body[k] !== undefined) company[k] = req.body[k];
    });
    if (company.name && company.name !== Company.findById(req.companyId).name) {
      const dup = Company.findByName(company.name);
      if (dup && dup.id !== company.id) return res.status(400).json({ error: 'Company name already exists' });
    }
    res.json(Company.toJSON(Company.save(company)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update security (username/password)
router.put('/security', authMiddleware, tenantGuard, companyAdminOnly, async (req, res) => {
  try {
    const { adminUsername, adminPassword } = req.body;
    const company = Company.findById(req.companyId);
    if (!company) return res.status(404).json({ error: 'Company not found' });

    if (adminUsername) {
      const dup = Company.findByAdminUsername(adminUsername);
      if (dup && dup.id !== company.id) return res.status(400).json({ error: 'Username already used by another company' });
      company.adminUsername = adminUsername;
    }
    if (adminPassword && adminPassword.length >= 4) {
      company.adminPasswordHash = await bcrypt.hash(adminPassword, 10);
    }
    Company.save(company);
    res.json({ message: 'Security settings updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT update recovery info
router.put('/recovery', authMiddleware, tenantGuard, companyAdminOnly, (req, res) => {
  try {
    const { recoveryMobile, recoveryEmail } = req.body;
    const company = Company.findById(req.companyId);
    if (recoveryMobile !== undefined) company.recoveryMobile = recoveryMobile;
    if (recoveryEmail !== undefined) company.recoveryEmail = recoveryEmail;
    Company.save(company);
    res.json({ message: 'Recovery info updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
