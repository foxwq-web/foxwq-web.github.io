// Fixed, public Feistel permutation for cosmetic diffusion, not encryption.
// Equal halves keep both the 64-bit review and 96-bit room formats unchanged.
function scramble(bytes: Uint8Array, reverse = false): Uint8Array {
  const half = bytes.length / 2;
  const mask = (1n << BigInt(half * 8)) - 1n;
  const read = (part: Uint8Array) => part.reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
  let left = read(bytes.subarray(0, half)), right = read(bytes.subarray(half));
  const mix = (value: bigint, round: number) => {
    let x = BigInt.asUintN(64, value + BigInt(round + 1) * 0x9e3779b97f4a7c15n);
    x = BigInt.asUintN(64, (x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n);
    x = BigInt.asUintN(64, (x ^ (x >> 27n)) * 0x94d049bb133111ebn);
    return (x ^ (x >> 31n)) & mask;
  };
  for (let i = 0; i < 6; i++) {
    if (reverse) [left, right] = [right ^ mix(left, 5 - i), left];
    else [left, right] = [right, left ^ mix(right, i)];
  }
  let value = (left << BigInt(half * 8)) | right;
  const result = new Uint8Array(bytes.length);
  for (let i = result.length - 1; i >= 0; i--, value >>= 8n) result[i] = Number(value & 255n);
  return result;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeBytes(bytes: Uint8Array): string {
  return base64url(scramble(bytes));
}

function decodeBytes(token: string, size: number): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const bytes = Uint8Array.from(atob(token.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    // Reject padding aliases and nonzero unused bits as well as wrong lengths.
    return bytes.length === size && base64url(bytes) === token ? scramble(bytes, true) : null;
  } catch { return null; }
}

export function reviewPath(id: string): string {
  if (!/^[1-9][0-9]{0,19}$/.test(id) || BigInt(id) > 0xffffffffffffffffn)
    throw Error('invalid fox game identifier');
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(id));
  return `/game/${encodeBytes(bytes)}`;
}

export function recordedGameId(path = location.pathname) {
  const segment = /^\/game\/([^/]+)\/?$/.exec(path)?.[1];
  if (!segment) return undefined;
  const bytes = decodeBytes(segment, 8);
  // Leave invalid IDs to the record loader's existing error handling.
  return bytes ? new DataView(bytes.buffer).getBigUint64(0).toString() : 'invalid';
}

export const livePaths = ['/', '/matchmaking', '/play'] as const;

// Notify both the app router and the live controller about local navigation.
export function navigateTo(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
