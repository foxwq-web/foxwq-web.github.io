## Proxy

This directory contains proxy code and configuration. To deploy your own Worker, supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the environment or `~/.config/cloudflare/credentials.env`, then run:

```sh
npm run proxy:deploy
```

The script deploys the Worker, sets its `PROXY_TOKEN` secret, checks `/health`, and writes `VITE_FOX_PROXY_URL` to ignored `.env.local`. It reads or creates `proxy/.dev.vars`; its token must match `PROXY_TOKEN` in `client/src/proxy.ts`. The token is bundled with the client and is not a private user credential.

GitHub Actions also deploys the proxy through the [Verify workflow](../.github/workflows/ci.yml). Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` under **Settings → Secrets and variables → Actions → Repository secrets**, or as secrets for the `cloudflare-production` environment. Create the API token with Cloudflare's **Edit Cloudflare Workers** template, scoped to the deployment account; see [Cloudflare's GitHub Actions setup](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

On pushes to `main`, the proxy deploys only after the entire `verify` job succeeds, including unit tests, type checks, build verification, and the proxy dry run. Pull requests and pushes to other branches only run verification. To redeploy manually, run **Verify** from the Actions tab with `main` selected; verification runs before deployment. Deployments use the `cloudflare-production` environment and run one at a time. CI sets the Worker's `PROXY_TOKEN` from `client/src/proxy.ts`, so no separate GitHub secret is needed for it.

[proxy/wrangler.jsonc](wrangler.jsonc) lists permitted static-site origins and Fox `host:port` destinations. The production origin is `https://foxwq-web.github.io`. Update these for your deployment and any newly advertised game gateway. The WebSocket endpoint is `/proxy`; `/health` checks Worker availability without connecting to Fox.

For local proxy development, put the matching `PROXY_TOKEN` in `proxy/.dev.vars`, set `VITE_FOX_PROXY_URL=ws://127.0.0.1:8787/proxy` in `.env.local`, and run `npm run proxy:dev` alongside the client.

`GET /fox/chessbook/TXWQFetchChessList` relays the query to the same path on `https://newframe.foxwq.com`. The client supplies its signed-in Fox UID, base64 login token, timestamp and signature. The Worker forwards them unchanged and adds CORS headers; it does not generate Fox credentials or guest requests. The route requires the same allowed origin and proxy access token as the WebSocket relay.

## Verification

From the repository root, run `npm run proxy:check` to perform a deployment dry run without publishing the Worker.
