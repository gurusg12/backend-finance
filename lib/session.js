const jwt = require('jsonwebtoken');
const Company = require('./company');

// The object returned to the browser after a company admin signs in (login or registration)
function adminSession(company) {
  const token = jwt.sign(
    { role: 'admin', companyId: company.id, username: company.adminUsername, companyName: company.name },
    process.env.JWT_SECRET, { expiresIn: '12h' });
  return {
    token, role: 'admin', username: company.adminUsername, companyId: company.id,
    companyName: company.name, logo: company.logo, plan: company.plan,
    daysRemaining: Company.daysRemaining(company),
  };
}

module.exports = { adminSession };
