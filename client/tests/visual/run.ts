import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { devDependencies, engines } = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const image = `foxwq-visual:pw${devDependencies.playwright}-node${engines.node}-npm${engines.npm}`;
// Keep the browser image's fonts and libraries, but use the project's runtime.
// Docker caches this build; passing only the Dockerfile avoids sending the repo.
const build = spawnSync('docker', [
  'build', '--platform=linux/amd64',
  '--build-arg', `NODE_VERSION=${engines.node}`,
  '--build-arg', `NPM_VERSION=${engines.npm}`,
  '--build-arg', `PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v${devDependencies.playwright}-noble`,
  '--tag', image, '-',
], {
  input: readFileSync(new URL('./Dockerfile', import.meta.url)),
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (build.error || build.status !== 0) {
  console.error(`Could not build the visual test image: ${build.error?.message ?? `docker exited with status ${build.status}`}`);
  process.exit(build.status ?? 1);
}
// Match CI's OS, browser, fonts, and CPU architecture, including on macOS.
// An isolated node_modules volume avoids replacing the host's native packages.
const result = spawnSync('docker', [
  'run', '--rm', '--init', '--ipc=host', '--platform=linux/amd64',
  '--mount', `type=bind,source=${root},target=/workspace`,
  '--mount', 'type=volume,target=/workspace/node_modules',
  '--workdir', '/workspace',
  '--env', `VISUAL_OWNER=${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
  // The container intentionally uses the pinned npm rather than the latest.
  '--env', 'npm_config_update_notifier=false',
  image,
  // Linux hosts must be able to move the images produced by container root.
  'bash', '-c', `
    trap 'chown -R "$VISUAL_OWNER" client/tests/visual/results client/tests/visual/baselines 2>/dev/null || true' EXIT
    npm ci --no-audit --no-fund && npm run test:visual:run -- "$@"
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
