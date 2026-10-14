// Synthetic, disposable PostgreSQL regression. Never accepts an existing database DSN.
// Default: Docker + ALL repository migrations. Native minimal mode is explicitly NOT that gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../packages/adapters/package.json', import.meta.url));
const { Pool } = require('pg');
const args = process.argv.slice(2);
// Do not inherit a real database target from an operator's shell.
if (Object.keys(process.env).some(key => key.startsWith('PG') || key === 'DATABASE_URL' || key.endsWith('_DATABASE_URL') || key.endsWith('_DSN'))) {
  throw new Error('Refusing ambient database configuration');
}
const native = args[0] === '--native-minimal';
if (args.length && !(native && args.length === 3)) {
  throw new Error('Use no arguments for Docker, or --native-minimal PG_BIN EVIDENCE_DIRECTORY');
}
// pg_ctl interprets its -o string: support only simple paths, before mkdtemp/initdb.
if (native && args.slice(1).some(path => !/^[A-Za-z0-9_./-]+$/.test(resolve(path)))) {
  throw new Error('Unsafe native path: only letters, digits, underscore, dot, slash and hyphen supported');
}
const suffix = randomUUID();
const container = `fieldloop-audit-test-${suffix}`;
const network = `${container}-net`;
let nativeDirectory;
let nativeStartAttempted = false;
let pool;
let primaryError;
let fixtureFailed = false;
let cleanupErrors;
async function cleanup(label, action) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Cleanup timeout')), 5000); }),
    ]);
  } catch (error) {
    console.error(`Cleanup failed (${label}): ${error.message}`);
    return error;
  } finally { clearTimeout(timer); }
}
function command(executable, argv, options = {}) {
  console.log(`RUN ${executable} ${argv.join(' ')}`);
  const result = spawnSync(executable, argv, { cwd: root, encoding: 'utf8', timeout: 120000, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`Fixture command failed (${result.status}): ${executable}`, { cause: result.error });
  return result.stdout.trim();
}
try {
  let connection;
  if (native) {
    const bin = resolve(args[1]);
    nativeDirectory = await mkdtemp(join(resolve(args[2]), 'audit-fixture-'));
    console.log(`LIMIT: native minimal audit migrations only; no PostGIS/pgvector/full migration proof. Fixture ${nativeDirectory}`);
    command(join(bin, 'initdb'), ['-D', join(nativeDirectory, 'data'), '-U', 'synthetic_audit_fixture', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    nativeStartAttempted = true;
    command(join(bin, 'pg_ctl'), ['-D', join(nativeDirectory, 'data'), '-l', join(nativeDirectory, 'postgres.log'), '-o', `-k ${nativeDirectory} -p 55493 -c listen_addresses= -c unix_socket_permissions=0700`, '-w', 'start']);
    connection = { host: nativeDirectory, port: 55493, user: 'synthetic_audit_fixture', database: 'postgres' };
  } else {
    command('docker', ['build', '-q', '-t', 'fieldloop-db-test:pg16', '-f', 'db/test/Dockerfile', '.']);
    command('docker', ['build', '-q', '-t', `${container}-migrate`, '-f', 'db/Dockerfile', '.']);
    command('docker', ['network', 'create', network]);
    command('docker', ['run', '-d', '--rm', '--name', container, '--network', network, '-e', 'POSTGRES_PASSWORD=synthetic-fixture', '-e', 'POSTGRES_DB=audit_fixture', '-p', '127.0.0.1::5432', 'fieldloop-db-test:pg16']);
    command('docker', ['run', '--rm', '--network', network, '-e', `DATABASE_URL=postgres://postgres:synthetic-fixture@${container}:5432/audit_fixture?sslmode=disable`, `${container}-migrate`, 'up']);
    const address = command('docker', ['port', container, '5432/tcp']);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    connection = { host: '127.0.0.1', port: Number(address.split(':')[1]), user: 'postgres', password: 'synthetic-fixture', database: 'audit_fixture' };
  }
  pool = new Pool({ ...connection, max: 8, connectionTimeoutMillis: 5000, options: '-c default_transaction_isolation=repeatable\\ read -c timezone=Asia/Bangkok' });
  console.log((await pool.query('SELECT version()')).rows[0].version);
  assert.equal((await pool.query('SHOW default_transaction_isolation')).rows[0].default_transaction_isolation, 'repeatable read');
  assert.equal((await pool.query('SHOW server_encoding')).rows[0].server_encoding, 'UTF8');
  if (native) {
    await pool.query('CREATE SCHEMA app; CREATE TABLE app.asset (id uuid PRIMARY KEY)');
    const migration = await readFile(join(root, 'db/migrations/20261010000005_action_approval_audit.sql'), 'utf8');
    await pool.query(migration.split('-- migrate:down')[0]);
    // The shared append function and guard, without the simulation reset section that needs later tables.
    const shared = await readFile(join(root, 'db/migrations/20261014060000_shared_audit_writer.sql'), 'utf8');
    await pool.query('CREATE ROLE fieldloop_app NOLOGIN');
    await pool.query(shared.split('-- migrate:down')[0].split('-- The simulation reset appends')[0]);
  }
  // Import the public production export, not a copy, after fixture setup.
  const { appendAuditEventAtomically } = await import('../packages/adapters/dist/index.js');
  await pool.query("CREATE TABLE app.synthetic_audit_domain (id text PRIMARY KEY, org_id text NOT NULL, simulated boolean NOT NULL, classification text NOT NULL, value integer NOT NULL); INSERT INTO app.synthetic_audit_domain VALUES ('synthetic-1','synthetic-atomic-org',true,'INTERNAL',0)");
  const input = { orgId: 'synthetic-atomic-org', actor: 'synthetic-user', action: 'synthetic.updated', entity: 'synthetic:1', beforeHash: null, afterHash: 'a'.repeat(64), simulated: true, classification: 'INTERNAL' };
  const mutate = async (transaction) => {
    await transaction.query('UPDATE app.synthetic_audit_domain SET value = value + 1 WHERE id = $1', ['synthetic-1']);
  };
  async function state(value, count) {
    assert.equal((await pool.query('SELECT value FROM app.synthetic_audit_domain')).rows[0].value, value);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM app.audit_event WHERE org_id = $1', [input.orgId])).rows[0].n, count);
  }
  const first = await appendAuditEventAtomically(pool, input, mutate);
  assert.equal(first.prevHash, null);
  await state(1, 1);
  console.log('PASS domain mutation and audit commit together');
  const failure = new Error('synthetic domain failure');
  await assert.rejects(appendAuditEventAtomically(pool, input, async (transaction) => { await mutate(transaction); throw failure; }), error => error === failure);
  await state(1, 1);
  console.log('PASS domain failure rolls back mutation with no audit');
  // Fixture-only rejection; does not alter production migration or privileges.
  await pool.query("ALTER TABLE app.audit_event ADD CONSTRAINT synthetic_audit_reject CHECK (action <> 'synthetic.reject')");
  await assert.rejects(appendAuditEventAtomically(pool, { ...input, action: 'synthetic.reject' }, mutate), error => error.code === '23514' && error.constraint === 'synthetic_audit_reject');
  await state(1, 1);
  console.log('PASS audit failure rolls back domain mutation');
  const second = await appendAuditEventAtomically(pool, input, mutate);
  assert.equal(second.prevHash, first.hash);
  await state(2, 2);
  console.log('PASS predecessor includes committed append only');
  // Atomic mutation coverage; same-row locking alone cannot prove advisory-lock sensitivity.
  const receipts = await Promise.all(Array.from({ length: 16 }, () => appendAuditEventAtomically(pool, input, mutate)));
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 16);
  await state(18, 18);
  const client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    const rows = (await client.query('SELECT id, prev_hash, app.payload_sha256(to_jsonb(event)) AS hash FROM app.audit_event AS event WHERE org_id = $1 ORDER BY created_at, id', [input.orgId])).rows;
    assert.equal(rows.length, 18);
    assert.equal(rows[0].prev_hash, null);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash);
    for (const receipt of [first, second, ...receipts]) assert.equal(rows.find(row => row.id === receipt.id)?.hash, receipt.hash);
  } finally { client.release(); }
  console.log('PASS 16 concurrent same-client mutations form one 18-row committed chain');
  // Separate Organisation, audit-only calls: no domain row lock can serialize these.
  const auditOnlyInput = { ...input, orgId: 'synthetic-audit-only-org' };
  const auditOnly = await Promise.all(Array.from({ length: 32 }, () => appendAuditEventAtomically(pool, auditOnlyInput)));
  assert.equal(new Set(auditOnly.map(receipt => receipt.id)).size, 32);
  const auditClient = await pool.connect();
  try {
    await auditClient.query("SET TIME ZONE 'UTC'");
    const rows = (await auditClient.query('SELECT id, prev_hash, app.payload_sha256(to_jsonb(event)) AS hash FROM app.audit_event AS event WHERE org_id = $1 ORDER BY created_at, id', [auditOnlyInput.orgId])).rows;
    assert.equal(rows.length, 32);
    assert.equal(rows[0].prev_hash, null);
    for (let i = 1; i < rows.length; i++) assert.equal(rows[i].prev_hash, rows[i - 1].hash, 'audit-only concurrent chain must have exactly one committed predecessor');
    for (const receipt of auditOnly) assert.equal(rows.find(row => row.id === receipt.id)?.hash, receipt.hash);
  } finally { auditClient.release(); }
  await state(18, 18);
  console.log('PASS 32 concurrent audit-only appends form one chain without domain-row locks');
} catch (error) {
  primaryError = error;
  fixtureFailed = true;
} finally {
  const failures = [];
  if (pool) failures.push(await cleanup('pool', () => pool.end()));
  if (nativeStartAttempted) failures.push(await cleanup('native stop', () => command(join(resolve(args[1]), 'pg_ctl'), ['-D', join(nativeDirectory, 'data'), '-m', 'fast', '-w', 'stop'], { timeout: 10000 })));
  if (!native) {
    // Cleanup is independent, checked and restricted to uniquely owned names.
    for (const [label, argv] of [
      ['container', ['rm', '-f', container]],
      ['network', ['network', 'rm', network]],
      ['migration image', ['image', 'rm', `${container}-migrate`]],
    ]) failures.push(await cleanup(label, () => command('docker', argv, { timeout: 10000 })));
  }
  cleanupErrors = failures.filter(Boolean);
}
if (fixtureFailed) throw primaryError;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Fixture cleanup failed');
