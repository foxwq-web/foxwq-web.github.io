import type { ChildProcess } from 'node:child_process';
import assert from 'node:assert/strict';
import type { ViteDevServer, PreviewServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer as createPortServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, build, preview } from 'vite';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const args = process.argv.slice(2);
const production = args.includes('--score-production') || args.includes('--production-shortcuts');
async function availablePort() {
  const socket = createPortServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return port;
}

let server: ViteDevServer | PreviewServer | undefined;
let child: ChildProcess | undefined;
let cache: string | undefined;
const interrupt = () => child?.kill('SIGINT');
const terminate = () => child?.kill('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  let url = process.env.FOX_BROWSER_URL;
  if (!url) {
    const port = await availablePort();
    if (production) {
      await build({ configFile });
      server = await preview({ configFile, preview: { host: '127.0.0.1', port, strictPort: true } });
    } else {
      cache = await mkdtemp(join(tmpdir(), 'foxwq-web-vite-'));
      server = await createServer({ configFile, cacheDir: cache,
        server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null } });
      await server.listen();
    }
    assert.ok(server.httpServer);
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== 'string');
    url = `http://127.0.0.1:${address.port}`;
  }
  child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./browser-check.ts', import.meta.url)), ...args], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, FOX_BROWSER_URL: url }, stdio: 'inherit'
  });
  const runningChild = child;
  process.exitCode = await new Promise<number>((resolve, reject) => {
    runningChild.once('error', reject);
    runningChild.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 1)));
  });
} finally {
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', terminate);
  if (server) await server.close();
  if (cache) await rm(cache, { recursive: true, force: true });
}
