import { getConfig } from '../server/config.js';
import { upsertAccessRecord } from '../server/access.js';
import fs from 'fs/promises';
import path from 'path';

function usage() {
  console.error('Usage:');
  console.error('  node scripts/seed_allowlist.js <email> [role] [status] [updatedBy]');
  console.error('  node scripts/seed_allowlist.js --file <json-file> [updatedBy]');
  process.exit(2);
}

const config = getConfig();

function normalizeEntry(entry, fallbackUpdatedBy) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Each file entry must be an object.');
  }

  return {
    email: String(entry.email || '').trim(),
    role: String(entry.role || 'viewer').trim(),
    status: String(entry.status || 'active').trim(),
    updatedBy: String(entry.updatedBy || fallbackUpdatedBy || 'seed-script').trim(),
  };
}

async function upsertSingle({ email, role = 'viewer', status = 'active', updatedBy = 'seed-script' }) {
  const record = await upsertAccessRecord(config, { email, role, status, updatedBy });
  return {
    email: record.email,
    role: record.role,
    status: record.status,
  };
}

async function upsertFromFile(filePath, updatedBy = 'seed-script') {
  const resolvedPath = path.resolve(filePath);
  const raw = await fs.readFile(resolvedPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Seed file must contain a JSON array.');
  }

  const results = [];
  for (const entry of parsed) {
    results.push(await upsertSingle(normalizeEntry(entry, updatedBy)));
  }

  console.log(JSON.stringify({
    message: 'Allowlist file applied.',
    file: resolvedPath,
    count: results.length,
    users: results,
  }, null, 2));
}

try {
  const args = process.argv.slice(2);
  if (!args.length) usage();

  if (args[0] === '--file') {
    const [, filePath, updatedBy = 'seed-script'] = args;
    if (!filePath) usage();
    await upsertFromFile(filePath, updatedBy);
  } else {
    const [email, role = 'viewer', status = 'active', updatedBy = 'seed-script'] = args;
    if (!email) usage();
    const record = await upsertSingle({ email, role, status, updatedBy });
    console.log(JSON.stringify({
      message: 'Allowlist entry upserted.',
      ...record,
    }, null, 2));
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exit(1);
}
