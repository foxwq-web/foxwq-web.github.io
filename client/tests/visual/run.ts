import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = readFileSync(new URL('../../../package.json', import.meta.url));
const lockfile = readFileSync(new URL('../../../package-lock.json', import.meta.url));
const dockerfile = readFileSync(new URL('./Dockerfile', import.meta.url));
const { devDependencies, engines } = JSON.parse(manifest.toString());
const runtime = `pw${devDependencies.playwright}-node${engines.node}-npm${engines.npm}`;
const imageKey = createHash('sha256').update(runtime).update(dockerfile).digest('hex').slice(0, 20);
const image = `foxwq-visual:${runtime}-${imageKey}`;
const dependencyKey = createHash('sha256').update(imageKey).update(manifest).update(lockfile).digest('hex').slice(0, 20);
// Keep the browser image's fonts and libraries, but use the project's runtime.
// Only build when the runtime or Dockerfile changes (or the image was removed).
// Passing only the Dockerfile avoids sending the repo to the Docker daemon.
const inspect = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
if (inspect.error) {
  console.error(`Could not inspect the visual test image: ${inspect.error.message}. Start Docker and retry.`);
  process.exit(1);
}
if (inspect.status !== 0) {
  const build = spawnSync('docker', [
    'build', '--platform=linux/amd64',
    '--build-arg', `NODE_VERSION=${engines.node}`,
    '--build-arg', `NPM_VERSION=${engines.npm}`,
    '--build-arg', `PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v${devDependencies.playwright}-noble`,
    '--tag', image, '-',
  ], {
    input: dockerfile,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (build.error || build.status !== 0) {
    console.error(`Could not build the visual test image: ${build.error?.message ?? `docker exited with status ${build.status}`}`);
    process.exit(build.status ?? 1);
  }
}
// Match CI's OS, browser, fonts, and CPU architecture, including on macOS.
// Reuse Linux dependencies without touching the host's native packages. A new
// volume is selected whenever the manifests or container runtime change.
const result = spawnSync('docker', [
  'run', '--rm', '--init', '--ipc=host', '--platform=linux/amd64',
  '--mount', `type=bind,source=${root},target=/workspace`,
  '--mount', `type=volume,source=foxwq-visual-deps-${dependencyKey},target=/workspace/node_modules,volume-nocopy`,
  '--mount', 'type=volume,source=foxwq-visual-npm,target=/root/.npm',
  '--workdir', '/workspace',
  '--env', `VISUAL_OWNER=${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
  // The container intentionally uses the pinned npm rather than the latest.
  '--env', 'npm_config_update_notifier=false',
  image,
  // Linux hosts must be able to move the images produced by container root.
  'bash', '-e', '-c', `
    trap 'chown -R "$VISUAL_OWNER" client/tests/visual/results client/tests/visual/baselines 2>/dev/null || true' EXIT
    (
      flock 9
      if [ ! -f node_modules/.foxwq-visual-ready ]; then
        npm ci --prefer-offline --no-audit --no-fund
        touch node_modules/.foxwq-visual-ready
      fi
    ) 9>/root/.npm/visual-${dependencyKey}.lock
    npm run test:visual:run -- "$@"
  `,
  '--', ...process.argv.slice(2),
], { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not start the visual tests: ${result.error.message}. Start Docker and retry.`);
} else if (result.status !== 0) {
  console.error('\nReview screenshot differences in client/tests/visual/results/.');
  console.error('To accept intentional screenshot changes, run:');
  console.error('npm run test:visual -- --update-snapshots');
}
process.exitCode = result.status ?? 1;
