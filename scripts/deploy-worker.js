// Deployment tooling only; never serves the application or reads FOX credentials.
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const env = { ...process.env };
try {
  const credentials = await readFile(new URL('../cloudflare-creds', import.meta.url), 'utf8');
  for (const line of credentials.split(/\r?\n/)) {
    const match = line.match(/^(?:export\s+)?(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)=(.*)$/);
    if (match) env[match[1]] ||= match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) throw Error('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or provide cloudflare-creds');
const secretPath = new URL('../proxy/.dev.vars', import.meta.url);
let token;
try { token = (await readFile(secretPath, 'utf8')).match(/^PROXY_TOKEN="?([A-Za-z0-9_-]{32,128})"?$/m)?.[1]; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
token ||= randomBytes(32).toString('base64url');
await writeFile(secretPath, `PROXY_TOKEN="${token}"\n`, { mode: 0o600 });
await chmod(secretPath, 0o600);
function wrangler(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', 'proxy/wrangler.jsonc'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => process.stderr.write(data));
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(Error(`Wrangler exited with status ${code}`)));
    child.stdin.end(input);
  });
}
const output = await wrangler(['deploy']);
await wrangler(['secret', 'put', 'PROXY_TOKEN'], token);
const url = output.match(/https:\/\/[a-zA-Z0-9.-]+\.workers\.dev/)?.[0];
if (url) {
  await writeFile(new URL('../.env.local', import.meta.url), `VITE_FOX_PROXY_URL=${url.replace('https:', 'wss:')}/proxy\n`, { mode: 0o600 });
  console.log(`Proxy deployed: ${url}/proxy\nBrowser URL configured in .env.local. Enter the access token from proxy/.dev.vars in Proxy settings.`);
}
