import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = resolve(repositoryRoot, 'apps/outreach');

/** Match the application's worker environment: service keys never reach Codex. */
export function workerEnvironment(environment) {
  return Object.fromEntries(['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']
    .filter(name => environment[name]).map(name => [name, environment[name]]));
}

/** Discard all CLI output: login status can describe authentication details. */
export function runQuiet(binary, args, { env, cwd = appRoot, timeoutMs = 5000 } = {}) {
  return new Promise(resolveResult => {
    let timedOut = false, settled = false;
    const child = spawn(binary, args, { env, cwd, shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolveResult(value); } };
    child.on('error', () => finish({ ok: false, reason: 'unavailable' }));
    child.on('close', code => finish({ ok: code === 0 && !timedOut, reason: timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed' }));
  });
}

export function supportedNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) && (major > 22 || (major === 22 && minor >= 19));
}

export async function checkSetup({ environment = {}, nodeVersion = process.versions.node, dependenciesReady = false, buildReady = false, run = runQuiet } = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  const present = name => typeof environment[name] === 'string' && environment[name].trim().length > 0;
  const local = environment.APP_STORAGE === 'file';
  add('Node.js', supportedNode(nodeVersion) ? 'PASS' : 'FAIL', supportedNode(nodeVersion) ? 'Supported version (22.19 or newer).' : 'Install Node.js 22.19 or newer.');
  add('App dependencies', dependenciesReady ? 'PASS' : 'FAIL', dependenciesReady ? 'Installed.' : 'Run npm run setup from the repository root; include development dependencies.');
  add('Built dashboard and verifier', buildReady ? 'PASS' : 'FAIL', buildReady ? 'Present.' : 'Run npm run build from the repository root.');
  const env = workerEnvironment(environment);
  const binary = environment.CODEX_BIN?.trim() || 'codex';
  const available = await run(binary, ['--version'], { env, timeoutMs: 5000 });
  add('Codex CLI', available.ok ? 'PASS' : 'FAIL', available.ok ? 'Available.' : 'Install Codex CLI, or set CODEX_BIN to its executable path.');
  if (available.ok) {
    const auth = await run(binary, ['login', 'status'], { env, timeoutMs: 5000 });
    add('Codex login', auth.ok ? 'PASS' : 'FAIL', auth.ok ? 'Credentials present; model access and quota are not tested.' : auth.reason === 'timeout' ? 'Status check timed out. Run codex login status in your terminal.' : 'Run codex login on this host, then check again.');
  } else add('Codex login', 'FAIL', 'Not checked because the CLI is unavailable.');
  add('Storage mode', local ? 'WARN' : 'PASS', local ? 'Explicit local test storage; live research still needs Archil.' : 'Archil storage selected.');
  for (const name of ['ARCHIL_API_KEY', 'ARCHIL_DISK_ID']) {
    add(name, present(name) ? 'PASS' : local ? 'WARN' : 'FAIL', present(name) ? 'Configured; value hidden and access not tested.' : local ? 'Missing; required for live Archil research.' : 'Missing; configure it in apps/outreach/.env.');
  }
  add('ARCHIL_REGION', 'PASS', present('ARCHIL_REGION') ? 'Configured; value hidden.' : 'Using the documented app default region.');
  add('ARCHIL_PREFIX', 'PASS', present('ARCHIL_PREFIX') ? 'Configured; value hidden.' : 'Using the app default prefix.');
  add('KEENABLE_API_KEY', present('KEENABLE_API_KEY') ? 'PASS' : local ? 'WARN' : 'FAIL', present('KEENABLE_API_KEY') ? 'Configured; access and credits not tested.' : 'Missing for live search; run npm run connect:keenable.');
  add('SCOUT_DISK_ID (optional)', present('SCOUT_DISK_ID') ? 'PASS' : 'OPTIONAL', present('SCOUT_DISK_ID') ? 'Configured; value hidden and read access not tested.' : 'Not configured; manual RFQs and the fictional sample remain available.');
  add('AGENTMAIL_API_KEY (optional)', present('AGENTMAIL_API_KEY') ? 'PASS' : 'OPTIONAL', present('AGENTMAIL_API_KEY') ? 'Configured; inbox access not tested.' : 'Not configured; real email is unavailable.');
  add('AGENTMAIL_INBOX_ID (optional)', present('AGENTMAIL_INBOX_ID') ? 'PASS' : 'OPTIONAL', present('AGENTMAIL_INBOX_ID') ? 'Configured; value hidden.' : 'Use a saved local connection or explicitly connect an inbox in the dashboard.');
  add('Backend ownership', 'WARN', 'Not checked automatically. Run only one backend for a shared outreach disk and prefix.');
  return { checks, exitCode: checks.some(check => check.status === 'FAIL') ? 1 : 0 };
}

export function formatReport(result) {
  return ['Source / Control setup check', ...result.checks.map(check => `[${check.status}] ${check.name}: ${check.detail}`),
    '', result.exitCode ? 'Resolve the failed checks before using the full workflow.' : 'Required local checks passed. Service permissions, credits and model inference remain unverified.',
    'This check does not start the app, contact Archil/Keenable/AgentMail, or expose a shared URL.'].join('\n');
}

async function main() {
  let environment = { ...process.env };
  let dependenciesReady = false, environmentReadable = true;
  try {
    const require = createRequire(resolve(appRoot, 'package.json'));
    const pkg = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'));
    dependenciesReady = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]
      .every(name => existsSync(resolve(appRoot, 'node_modules', name, 'package.json')));
    if (existsSync(resolve(appRoot, '.env'))) environment = { ...environment, ...require('dotenv').parse(readFileSync(resolve(appRoot, '.env'))) };
  } catch { environmentReadable = false; }
  const result = await checkSetup({ environment, dependenciesReady, buildReady: existsSync(resolve(appRoot, 'dist/index.html')) && existsSync(resolve(appRoot, 'work/verify_and_fingerprint.mjs')) });
  if (!environmentReadable) {
    result.checks.unshift({ name: 'Local configuration', status: 'FAIL', detail: 'Could not read app configuration. Run npm run setup and check apps/outreach/.env permissions.' });
    result.exitCode = 1;
  }
  console.log(formatReport(result));
  process.exitCode = result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Setup check could not finish. Check the local installation and file permissions.'); process.exitCode = 1; });
}
