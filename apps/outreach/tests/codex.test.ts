import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexGateway } from '../server/codex.js';
import { PriorityScheduler } from '../server/scheduler.js';
import type { AppEvent, EventBus, ModelJob } from '../shared/types.js';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
const fakeCli = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
const input = JSON.parse(prompt.slice(prompt.lastIndexOf('INPUT JSON:\\n') + 'INPUT JSON:\\n'.length));
let priorAlive = null;
if (input.priorPid) { try { process.kill(input.priorPid, 0); priorAlive = true; } catch { priorAlive = false; } }
const secretNames = ['ARCHIL_API_KEY', 'KEENABLE_API_KEY', 'AGENTMAIL_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'UNRELATED_TEST_SECRET'];
if (input.mode === 'ignore-term') {
  process.on('SIGTERM', () => writeFileSync(input.termMarker, JSON.stringify({ at: Date.now(), pid: process.pid })));
}
writeFileSync(input.marker, JSON.stringify({ pid: process.pid, at: Date.now(), priorAlive, output, args,
  exposedSecretNames: secretNames.filter(name => Object.prototype.hasOwnProperty.call(process.env, name)) }));
if (input.mode === 'ignore-term') {
  setInterval(() => {}, 1000);
} else {
  writeFileSync(output, JSON.stringify({ ok: true }));
  if (input.mode === 'tool-event') {
    process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'test sentinel only' } }) + '\\n');
    setTimeout(() => process.exit(0), 200);
  } else {
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n');
  }
}
`;

function job(jobId: string, input: Record<string, unknown>): ModelJob {
  return { jobId, kind: 'test extraction', priority: 2, schema, input, instructions: 'Return ok true using the supplied data.' };
}

async function readEventually<T>(path: string, timeout = 4000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')) as T; }
    catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fake CLI did not produce its test marker in time');
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'sourcing-codex-test-'));
  const binary = join(root, 'fake-codex.mjs');
  await writeFile(binary, fakeCli); await chmod(binary, 0o700);
  const previous = { bin: process.env.CODEX_BIN, timeout: process.env.CODEX_TIMEOUT_MS };
  process.env.CODEX_BIN = binary; process.env.CODEX_TIMEOUT_MS = '10000';
  const recorded: AppEvent[] = [];
  const events: EventBus = { emit(type, message, data, caseId, supplierId) {
    const event = { id: `${recorded.length}`, at: new Date().toISOString(), type, message, data, caseId, supplierId };
    recorded.push(event); return event;
  } };
  const scheduler = new PriorityScheduler(1);
  const gateway = new CodexGateway(scheduler, events, join(root, 'workers'));
  return { root, scheduler, gateway, recorded, async cleanup() {
    gateway.shutdown();
    if (previous.bin === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous.bin;
    if (previous.timeout === undefined) delete process.env.CODEX_TIMEOUT_MS; else process.env.CODEX_TIMEOUT_MS = previous.timeout;
    await rm(root, { recursive: true, force: true });
  } };
}

test('timed-out CLI holds its scheduler slot until an ignored SIGTERM is escalated and the process exits', { timeout: 10_000 }, async () => {
  const h = await harness();
  const marker = join(h.root, 'hung.json'), termMarker = join(h.root, 'term.json');
  let firstSettled = false;
  try {
    process.env.CODEX_TIMEOUT_MS = '1500';
    const first = h.gateway.run(job('hung-worker', { mode: 'ignore-term', marker, termMarker }))
      .then(value => { firstSettled = true; return { value, error: null }; }, error => { firstSettled = true; return { value: null, error }; });
    const started = await readEventually<{ pid: number }>(marker);
    // The first process has already captured its timeout; give the queued replacement ample time.
    process.env.CODEX_TIMEOUT_MS = '10000';
    const replacementMarker = join(h.root, 'replacement.json');
    const replacement = h.gateway.run<{ ok: boolean }>(job('replacement-worker', { mode: 'normal', marker: replacementMarker, priorPid: started.pid }));
    const terminated = await readEventually<{ at: number }>(termMarker);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(firstSettled, false, 'SIGTERM alone must not settle the timed-out worker');
    assert.equal(h.scheduler.slots[0]?.status, 'running');
    assert.equal(h.scheduler.slots[0]?.jobId, 'hung-worker');
    assert.equal(h.scheduler.queue[0]?.jobId, 'replacement-worker');
    assert.doesNotThrow(() => process.kill(started.pid, 0), 'fake CLI is still alive after ignoring SIGTERM');
    const firstResult = await first;
    assert.match(String(firstResult.error?.message), /timed out/);
    assert.deepEqual(await replacement, { ok: true });
    const replacementStart = await readEventually<{ priorAlive: boolean; at: number }>(replacementMarker);
    assert.equal(replacementStart.priorAlive, false, 'replacement starts only after prior process is gone');
    assert.ok(replacementStart.at - terminated.at >= 1200, 'SIGKILL grace interval was respected');
    assert.throws(() => process.kill(started.pid, 0), { code: 'ESRCH' });
  } finally { await h.cleanup(); }
});

test('unexpected tool event rejects an otherwise valid structured result', async () => {
  const h = await harness();
  try {
    const marker = join(h.root, 'tool.json');
    await assert.rejects(h.gateway.run(job('tool-worker', { mode: 'tool-event', marker })), /unexpected tool action/);
    const emitted = await readEventually<{ output: string }>(marker);
    assert.deepEqual(JSON.parse(await readFile(emitted.output, 'utf8')), { ok: true });
    assert.equal(h.recorded.some(event => event.type === 'worker.completed'), false);
  } finally { await h.cleanup(); }
});

test('CLI receives no integration credentials and has explicit tool-disable flags', async () => {
  const h = await harness();
  const names = ['ARCHIL_API_KEY', 'KEENABLE_API_KEY', 'AGENTMAIL_API_KEY', 'AWS_BEARER_TOKEN_BEDROCK', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'UNRELATED_TEST_SECRET'];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = `test-sentinel-${name}`;
  try {
    const marker = join(h.root, 'env.json');
    assert.deepEqual(await h.gateway.run(job('environment-worker', { mode: 'normal', marker })), { ok: true });
    const metadata = await readEventually<{ exposedSecretNames: string[]; args: string[] }>(marker);
    assert.deepEqual(metadata.exposedSecretNames, []);
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use']) {
      assert.ok(metadata.args.some((arg, index) => arg === '--disable' && metadata.args[index + 1] === feature));
    }
    assert.ok(metadata.args.includes('web_search="disabled"'));
    assert.equal(metadata.args[metadata.args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(metadata.args.includes('--ignore-user-config'));
  } finally {
    for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await h.cleanup();
  }
});
