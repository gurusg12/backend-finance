// ─────────────────────────────────────────────────────────────────────────────
// Sends email through YOUR SMTP server (Gmail, Zoho, Outlook, SendGrid, Brevo …).
// Set SMTP_* in backend/.env.  Without SMTP:
//   • development → the email text is printed in the server console (nothing is sent)
//   • production  → sending fails with a clear "email not configured" error
// ─────────────────────────────────────────────────────────────────────────────
let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  let nodemailer;
  try { nodemailer = require('nodemailer'); }
  catch (e) { throw Object.assign(new Error('nodemailer is not installed. Run "npm install" in the backend folder.'), { code: 'EMAIL_NOT_CONFIGURED' }); }
  const port = parseInt(process.env.SMTP_PORT, 10) || 587;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,                       // 465 = SSL, 587 = STARTTLS
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

const mailer = {
  isConfigured: () => !!process.env.SMTP_HOST,

  // { to, subject, text, html }
  async sendMail({ to, subject, text, html }) {
    if (!mailer.isConfigured()) {
      if (process.env.NODE_ENV === 'production') {
        throw Object.assign(new Error('Email service is not configured'), { code: 'EMAIL_NOT_CONFIGURED' });
      }
      console.log(`\n──── ✉  EMAIL (SMTP not set — shown here only in development) ────\nTo: ${to}\nSubject: ${subject}\n\n${text}\n──────────────────────────────────────────────────────────────\n`);
      return { dev: true };
    }
    const from = process.env.SMTP_FROM || `FinSphere <${process.env.SMTP_USER}>`;
    return getTransporter().sendMail({ from, to, subject, text, html });
  },
};

module.exports = mailer;
