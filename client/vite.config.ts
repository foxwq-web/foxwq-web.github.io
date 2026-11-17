import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolveBuildSha } from './src/build-metadata.ts';

export default defineConfig({
  plugins: [{
    name: 'github-pages-routes',
    async writeBundle(options) {
      const directory = options.dir ?? 'dist';
      // GitHub Pages serves 404.html for direct archive links.
      const index = resolve(directory, 'index.html');
      await Promise.all([
        copyFile(index, resolve(directory, '404.html')),
        ...['matchmaking', 'play'].map(async route => {
          const entry = resolve(directory, route);
          await mkdir(entry, { recursive: true });
          await copyFile(index, resolve(entry, 'index.html'));
        }),
      ]);
    },
  }],
  // Dev screens load lazy chunks with their own bare imports. Scanning all
  // sources optimizes them up front instead of reloading open pages mid-test.
  optimizeDeps: { entries: ['index.html', 'src/**/*.{ts,tsx}'] },
  worker: { rollupOptions: { output: {
    inlineDynamicImports: true,
    entryFileNames: 'assets/[name]-[hash].js',
  } } },
  root: import.meta.dirname,
  base: "/",
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
