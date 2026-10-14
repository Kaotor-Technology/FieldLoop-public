// Runner failure-path tests: no real subprocess, socket or database is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const source = await readFile(new URL('./test-audit-writer.mjs', import.meta.url), 'utf8');
const body = source.replace(/^import .*;\n/gm, '').replace(/const root = .*;\nconst require = .*;\nconst \{ Pool \} = require\('pg'\);\n/, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function scenario({ native = true, startFails = false, poolFails = false, dockerFails = false, stopFails = false, cleanupOnly = false, hangs = false, args }) {
  const calls = []; const output = []; const primary = new Error('primary fixture failure');
  const fixture = '/synthetic/audit-fixture-owned';
  let creations = 0;
  class Pool {
    async query() { throw primary; }
    end() { calls.push('pool.end'); return hangs ? new Promise(() => {}) : poolFails ? Promise.reject(new Error('pool cleanup failure')) : Promise.resolve(); }
  }
  const spawnSync = (executable, argv, options) => {
    calls.push([executable, argv, options]);
    if (startFails && argv.includes('start')) return { status: 1, stderr: 'partial startup failure' };
    if (stopFails && argv.includes('stop')) return { status: 1, stderr: 'native cleanup failure' };
    if (dockerFails) return { status: 1, stderr: 'docker failure' };
    return { status: 0, stdout: '' };
  };
  const process = { argv: ['node', 'runner', ...(args ?? (native ? ['--native-minimal', '/safe/bin', '/safe/evidence'] : []))], env: {}, stdout: { write() {} }, stderr: { write() {} } };
  // For cleanup-only outcomes, bypass fixture body, retaining actual runner finally code.
  const executedBody = cleanupOnly ? body.slice(0, body.indexOf('try {\n  let connection;')) + 'try {}' + body.slice(body.indexOf(' catch (error) {\n  primaryError')) : body;
  let error;
  try {
    await new AsyncFunction('assert', 'spawnSync', 'mkdtemp', 'readFile', 'resolve', 'join', 'randomUUID', 'root', 'Pool', 'process', 'console', executedBody)(assert, spawnSync, async () => { creations++; return fixture; }, readFile, resolve, join, randomUUID, '/synthetic', Pool, process, { log: (...text) => output.push(text.join(' ')), error: (...text) => output.push(text.join(' ')) });
  } catch (caught) { error = caught; }
  return { calls, output, error, primary, creations };
}
const partial = await scenario({ startFails: true });
assert.ok(partial.calls.some(call => Array.isArray(call) && call[1].includes('stop')), 'partial native startup must attempt owned server stop');
assert.match(partial.error.message, /Fixture command failed/);
console.log('PASS partial startup attempts stop');
for (const hangs of [false, true]) {
  const failedPool = await scenario({ poolFails: true, hangs });
  assert.equal(failedPool.error, failedPool.primary, 'cleanup must preserve primary error identity');
  assert.ok(failedPool.calls.some(call => Array.isArray(call) && call[1].includes('stop')));
  assert.match(failedPool.output.join('\n'), /Cleanup failed.*pool/);
  console.log(`PASS pool ${hangs ? 'timeout' : 'rejection'} does not skip native stop or mask primary`);
}
const docker = await scenario({ native: false, dockerFails: true });
assert.equal(docker.calls.filter(call => Array.isArray(call) && call[1][0] === 'rm').length, 1);
assert.ok(docker.calls.some(call => Array.isArray(call) && call[1][0] === 'network' && call[1][1] === 'rm'));
assert.ok(docker.calls.some(call => Array.isArray(call) && call[1][0] === 'image' && call[1][1] === 'rm'));
assert.equal(docker.output.filter(line => /Cleanup failed/.test(line)).length, 3);
for (const call of docker.calls) if (Array.isArray(call)) assert.ok(call[2].timeout > 0 && call[2].timeout <= 120000);
console.log('PASS all Docker cleanup failures observed independently with bounded commands');
const cleanupFailure = await scenario({ native: false, dockerFails: true, cleanupOnly: true });
assert.ok(cleanupFailure.error instanceof AggregateError);
assert.equal(cleanupFailure.error.errors.length, 3);
console.log('PASS cleanup-only failures cannot report success');
const stopFailure = await scenario({ poolFails: true, stopFails: true });
assert.equal(stopFailure.error, stopFailure.primary);
assert.equal(stopFailure.output.filter(line => /Cleanup failed/.test(line)).length, 2);
console.log('PASS pool and native stop failures both observed while preserving primary');
for (const unsafe of ['/safe/evidence with spaces', '/safe/evidence;touch-marker', '/safe/evidence$(id)', '/safe/evidence\nnext']) {
  for (const args of [['--native-minimal', '/safe/bin', unsafe], ['--native-minimal', unsafe, '/safe/evidence']]) {
    const rejected = await scenario({ args });
    assert.match(rejected.error?.message ?? '', /Unsafe native path/, 'unsafe paths need explicit pre-fixture rejection');
    assert.equal(rejected.creations, 0);
    assert.equal(rejected.calls.length, 0);
  }
}
console.log('PASS spaces and shell metacharacters in both native paths rejected before fixtures');
