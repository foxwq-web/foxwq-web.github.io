import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    fs: {
      // Development serves this repository, which also holds private tooling files.
      deny: ['.env', '.env.*', '**/.git/**', '**/*.{crt,pem}', '**/creds', '**/creds.*', '**/cloudflare-creds', '**/.dev.vars', '**/analysis/live/**']
    }
  }
});
