require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

if (!process.env.JWT_SECRET) {
  console.error('✗ JWT_SECRET is missing. Copy .env.example to .env and set it.');
  process.exit(1);
}

// Open the master database (creates data/master.db on first run)
const { getMaster, DATA_DIR } = require('./db/master');
const { closeAll } = require('./db/tenant');
const { driverName } = require('./db/driver');
getMaster();

const authRoutes = require('./routes/auth');
const companyRoutes = require('./routes/companies');
const customerRoutes = require('./routes/customers');
const accountRoutes = require('./routes/accounts');
const transactionRoutes = require('./routes/transactions');
const agentRoutes = require('./routes/agents');
const groupRoutes = require('./routes/groups');
const accountTypeRoutes = require('./routes/accountTypes');
const reportRoutes = require('./routes/reports');
const settingRoutes = require('./routes/settings');
const platformLedgerRoutes = require('./routes/platformLedger');
const onboardingRoutes = require('./routes/onboarding');
const configRoutes = require('./routes/config');

const app = express();
app.set('trust proxy', 1);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/auth', onboardingRoutes);   // register (OTP), forgot / reset password
app.use('/api/companies', companyRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/account-types', accountTypeRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/settings', settingRoutes);
app.use('/api/config', configRoutes);      // default loan / deposit / pigmy terms
app.use('/api/platform', platformLedgerRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok', db: 'sqlite', time: new Date() }));

// Unknown /api route
app.use('/api', (req, res) => res.status(404).json({ error: 'Route not found' }));

// Serve the React app after "npm run build" (frontend/build, or backend/public)
const buildDirs = [path.join(__dirname, '..', 'frontend', 'build'), path.join(__dirname, 'public')];
const buildDir = buildDirs.find(d => fs.existsSync(path.join(d, 'index.html')));
if (buildDir) {
  app.use(express.static(buildDir));
  app.get('*', (req, res) => res.sendFile(path.join(buildDir, 'index.html')));
} else {
  app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
}

// Error handler
app.use((err, req, res, next) => {
  console.error('✗ Error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error', status: err.status || 500 });
});

process.on('unhandledRejection', (reason) => console.error('✗ Unhandled Rejection:', reason));
process.on('uncaughtException', (error) => { console.error('✗ Uncaught Exception:', error); process.exit(1); });

const PORT = process.env.PORT || 6000;
const server = app.listen(PORT, () => {
  console.log(`\n✓ FinSphere running on port ${PORT}`);
  console.log(`✓ SQLite driver: ${driverName()}   |   data folder: ${DATA_DIR}`);
  console.log(buildDir ? `✓ Serving frontend from ${buildDir}\n` : '• Frontend build not found (run "npm run build" in the project root)\n');
});

function shutdown() {
  console.log('\nShutting down…');
  server.close(() => {
    closeAll();
    try { getMaster().close(); } catch (_) {}
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
