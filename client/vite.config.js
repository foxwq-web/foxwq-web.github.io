import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolveBuildSha } from './scripts/build-metadata.ts';

export default defineConfig({
  worker: { rollupOptions: { output: { inlineDynamicImports: true } } },
  root: import.meta.dirname,
  envDir: fileURLToPath(new URL('../', import.meta.url)),
  define: {
    __CLIENT_BUILD__: JSON.stringify({ gitSha: resolveBuildSha() })
  },
  server: {
    fs: {
      allow: [
        import.meta.dirname,
        fileURLToPath(new URL('../score-estimator/src', import.meta.url)),
        fileURLToPath(new URL('../score-estimator/artifacts', import.meta.url)),
        fileURLToPath(new URL('../node_modules', import.meta.url))
      ],

      deny: ['.env', '.env.*', '**/.git/**', '**/*.{crt,pem}', '**/creds', '**/creds.*', '**/cloudflare-creds', '**/.dev.vars', '**/analysis/live/**']
    }
  }
});
