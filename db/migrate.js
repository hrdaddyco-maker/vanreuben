'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function directUrl(url) {
  if (!url) return url;
  return url.replace('-pooler.', '.');
}

async function migrate() {
  const url = process.env.DATABASE_URL_UNPOOLED || directUrl(process.env.DATABASE_URL);
  if (!url) {
    console.log('migrate: no DATABASE_URL, skip');
    return;
  }
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    await client.query(sql);
    console.log('migrate: ok');
  } finally {
    await client.end();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().catch((err) => {
    console.error('migrate: failed', err.message);
    process.exit(1);
  });
}
