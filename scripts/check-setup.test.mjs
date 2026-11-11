import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSetup, formatReport, runQuiet, supportedNode, workerEnvironment } from './check-setup.mjs';

test('setup report distinguishes required and optional configuration without exposing values', async () => {
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, ARCHIL_API_KEY: 'private-test-archil', ARCHIL_DISK_ID: 'private-test-disk', KEENABLE_API_KEY: 'private-test-search', UNRELATED_SECRET: 'private-other' };
  const calls = [];
  const result = await checkSetup({ environment, nodeVersion: '22.19.0', dependenciesReady: true, buildReady: true,
    run: async (binary, args, options) => { calls.push({ binary, args, options }); return { ok: true }; } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls.map(call => call.args), [['--version'], ['login', 'status']]);
  assert.equal(result.checks.find(check => check.name === 'SCOUT_DISK_ID (optional)').status, 'OPTIONAL');
  assert.ok(!formatReport(result).includes('private-'));
  for (const call of calls) for (const name of ['ARCHIL_API_KEY', 'ARCHIL_DISK_ID', 'KEENABLE_API_KEY', 'UNRELATED_SECRET']) assert.equal(call.options.env[name], undefined);
  assert.deepEqual(workerEnvironment(environment), { PATH: process.env.PATH, HOME: process.env.HOME });
});

test('missing live setup fails with actionable checks and skips auth when CLI is absent', async () => {
  let calls = 0;
  const result = await checkSetup({ environment: {}, nodeVersion: '22.18.0', run: async () => { calls++; return { ok: false, reason: 'unavailable' }; } });
  assert.equal(result.exitCode, 1); assert.equal(calls, 1);
  for (const name of ['Node.js', 'App dependencies', 'Built dashboard and verifier', 'Codex CLI', 'Codex login', 'ARCHIL_API_KEY', 'ARCHIL_DISK_ID', 'KEENABLE_API_KEY']) {
    assert.equal(result.checks.find(check => check.name === name).status, 'FAIL', name);
  }
  assert.match(formatReport(result), /npm run setup/);
  assert.equal(supportedNode('26.12.0'), true); assert.equal(supportedNode('20.19.0'), false);
});

test('quiet CLI checks terminate a stalled process and discard its output', async () => {
  const started = Date.now();
  const result = await runQuiet(process.execPath, ['-e', "process.stdout.write('private-status'); process.stderr.write('private-auth'); setInterval(()=>{},1000)"], { env: workerEnvironment(process.env), cwd: process.cwd(), timeoutMs: 100 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 2000);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});
