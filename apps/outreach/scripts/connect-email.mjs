import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Run npm run connect:email in your own terminal. Key entry requires a private interactive prompt.');
  process.exit(1);
}
console.log('Create an AgentMail API key at https://console.agentmail.to.');
console.log('The key will be saved only in the ignored local .env file. It will not be displayed.');
process.stdout.write('Paste API key, then press Enter: ');
const key = await new Promise((resolveKey, reject) => {
  let value = '';
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  const done = (error) => {
    process.stdin.off('data', onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
    error ? reject(error) : resolveKey(value.trim());
  };
  const onData = (chunk) => {
    for (const character of chunk) {
      if (character === '\u0003' || character === '\u0004') return done(new Error('Cancelled; no changes saved.'));
      if (character === '\r' || character === '\n') return done();
      if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
      else if (character >= ' ') value += character;
    }
  };
  process.stdin.on('data', onData);
}).catch(error => { console.error(error.message); process.exit(1); });
if (!/^am_[A-Za-z0-9_-]{10,}$/.test(key)) {
  console.error('That does not look like an AgentMail API key. No changes saved.');
  process.exit(1);
}
const path = resolve(root, '.env');
const old = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const lines = old.split('\n').filter(line => !/^\s*(?:export\s+)?AGENTMAIL_API_KEY\s*=/.test(line));
const next = lines.join('\n').replace(/\n*$/, '\n') + `AGENTMAIL_API_KEY=${key}\n`;
const temporary = resolve(root, `work/agentmail-key-${randomUUID()}.tmp`);
const { mkdir } = await import('node:fs/promises');
await mkdir(dirname(temporary), { recursive: true, mode: 0o700 });
await writeFile(temporary, next, { mode: 0o600, flag: 'wx' });
await rename(temporary, path);
await chmod(path, 0o600);
console.log('Key saved locally. Open the dashboard and choose Connect inbox. No email has been sent.');
