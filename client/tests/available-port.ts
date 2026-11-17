import { createServer } from 'node:net';

// Vite treats a requested port of 0 as unset and falls back to its defaults,
// so reserve a free port explicitly before starting a server.
export async function availablePort(): Promise<number> {
  const socket = createServer();
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve());
  });
  const address = socket.address();
  if (!address || typeof address === 'string') throw Error('Could not reserve a port');
  await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
  return address.port;
}
