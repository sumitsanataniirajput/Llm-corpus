#!/usr/bin/env node
/** Fail CI when the SQL migration manifest and rollback playbook drift. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');
const PLAYBOOK = path.join(ROOT, 'docs', 'MIGRATIONS_AND_ROLLBACK.md');

function fail(message) {
  console.error(`migration manifest: ${message}`);
  process.exit(1);
}

const files = fs.readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort();
if (!files.length) fail('no SQL migrations found');

const playbook = fs.readFileSync(PLAYBOOK, 'utf8');
const missing = files.filter((name) => !playbook.includes(name));
if (missing.length) fail(`not documented in MIGRATIONS_AND_ROLLBACK.md: ${missing.join(', ')}`);

const numbers = new Map();
for (const name of files) {
  const match = name.match(/^(\d+)_/);
  if (!match) fail(`${name} does not start with a numeric migration id`);
  const number = match[1];
  if (numbers.has(number)) fail(`duplicate migration number ${number}: ${numbers.get(number)} and ${name}`);
  numbers.set(number, name);
}
if (!playbook.includes('no `009` migration file')) {
  fail('the intentional 009 gap must be explained in the rollback playbook');
}
if (!/## Rollback strategy/i.test(playbook)) {
  fail('the rollback playbook is missing its Rollback strategy section');
}

const destructive = /drop\s+table|drop\s+column|truncate\s+table|delete\s+from/i;
for (const name of files) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  if (destructive.test(sql)) fail(`${name} contains a destructive forward SQL statement`);
}

console.log(`migration manifest: OK — ${files.length} forward-only SQL files documented, with rollback guidance.`);
