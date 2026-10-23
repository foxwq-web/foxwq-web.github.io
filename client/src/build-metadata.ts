import { execFileSync } from 'node:child_process';


export function resolveBuildSha({ env = process.env, cwd = import.meta.dirname } = {}) {
  const supplied = env.CLIENT_BUILD_SHA?.trim();
  if (supplied) return supplied;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
}
