// "npm run build" in the backend: make sure the data folder + master database exist.
require('dotenv').config();
const { getMaster, DATA_DIR } = require('../db/master');
const { driverName } = require('../db/driver');
getMaster().close();
console.log(`✓ Database ready (${driverName()}) in ${DATA_DIR}`);
