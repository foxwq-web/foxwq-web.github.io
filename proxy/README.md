## Proxy

This directory contains proxy code and configuration. To deploy your own Worker, supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the environment or `~/.config/cloudflare/credentials.env`, then run:

```sh
npm run proxy:deploy
```

The script deploys the Worker, sets its `PROXY_TOKEN` secret, checks `/health`, and writes `VITE_FOX_PROXY_URL` to ignored `.env.local`. It reads or creates `proxy/.dev.vars`; its token must match `PROXY_TOKEN` in `client/src/proxy.ts`. The token is bundled with the client and is not a private user credential.

[proxy/wrangler.jsonc](wrangler.jsonc) lists permitted static-site origins and Fox `host:port` destinations. Update these for your deployment and any newly advertised game gateway. The WebSocket endpoint is `/proxy`; `/health` checks Worker availability without connecting to Fox.

For local proxy development, put the matching `PROXY_TOKEN` in `proxy/.dev.vars`, set `VITE_FOX_PROXY_URL=ws://127.0.0.1:8787/proxy` in `.env.local`, and run `npm run proxy:dev` alongside the client.

## Verification

From the repository root, run `npm run proxy:check` to perform a deployment dry run without publishing the Worker.
