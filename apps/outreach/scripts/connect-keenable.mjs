import { readFile, writeFile, chmod } from 'node:fs/promises';
const client_id = 'autonomous-sourcing';
const request = async (path, body) => {
  const r = await fetch(`https://api.keenable.ai/v1/auth/agent/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, body: await r.json() };
};
const issued = await request('code', { client_id, label: 'Archil sourcing hackathon local app' });
if (issued.status !== 200) throw new Error(`Device login unavailable (HTTP ${issued.status})`);
const code = issued.body;
console.log(JSON.stringify({ verificationUrl: code.verification_uri_complete || code.verification_uri, userCode: code.user_code, expiresIn: code.expires_in }));
let interval = Math.max(5, code.interval || 5);
const expiresAt = Date.now() + code.expires_in * 1000;
while (Date.now() < expiresAt) {
  await new Promise(resolve => setTimeout(resolve, interval * 1000));
  const result = await request('token', { client_id, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
  if (result.status === 200 && result.body.api_key) {
    const envPath = new URL('../.env', import.meta.url);
    const current = await readFile(envPath, 'utf8').catch(() => '');
    const cleaned = current.replace(/^\s*KEENABLE_API_KEY\s*=.*\r?\n?/gm, '');
    await writeFile(envPath, `${cleaned.trimEnd()}\nKEENABLE_API_KEY=${JSON.stringify(result.body.api_key)}\n`, { mode: 0o600 });
    await chmod(envPath, 0o600);
    console.log('Keenable connected. API key saved securely in local .env; key not displayed.');
    process.exit(0);
  }
  if (result.body.error === 'authorization_pending') continue;
  if (result.body.error === 'slow_down') { interval = Math.max(interval + 5, result.body.interval || 0); continue; }
  if (result.body.error === 'expired_token') { console.log('Device approval expired; no credential saved. Run npm run connect:keenable for a new link.'); process.exit(0); }
  if (result.status === 429 || result.status === 503) { interval += 5; continue; }
  throw new Error(`Device login stopped: ${result.body.error || result.status}`);
}
console.log('Device approval expired; no credential saved.');
