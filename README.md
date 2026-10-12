# VolumeChecker

A local research dashboard for price/flow divergence in an onchain liquidity pool. CoinGecko provides market data; this app computes its own uncalibrated risk score. It does not trade or predict returns.

## Install and run

Requirements: Node.js 24.21 or later in the 24.x line, pnpm 10.34.6 or later in the 10.x line, and your own CoinGecko Pro API key with access to the onchain REST and WebSocket services. A free Demo key is not a substitute for Pro/WS access.

Install Node.js from its official distribution, then install pnpm (`npm install -g pnpm@10.34.6`) or use your preferred supported package manager. From a fresh clone:

```sh
pnpm install --frozen-lockfile
pnpm start
```

The first start builds the app if necessary. The terminal wizard asks for:

1. Your own Pro API key, entered without echo. The key lives only in process memory and the child server environment for this session; it is never saved in the dashboard config, browser storage or Git.
2. A token/pair search and CoinGecko network ID, or an exact GeckoTerminal pool link such as `https://www.geckoterminal.com/eth/pools/0xa6cc3c2531fdaa6ae1a3ca84c2855806728693e8`.
3. The exact pool and tracked token, verified against provider metadata. Token symbols are not unique: inspect the displayed contracts. Multiple configured pools are supported, with one active collector at a time.
4. Optional in-app research alerts; off by default for a new dashboard.

Open **http://127.0.0.1:8787**, then press Connect. Stop Monitoring produces a session report. Ctrl+C stops the local server. Each launch asks for your key again and offers to reuse your dashboard. To change pools in the catalog, answer No to the saved-dashboard question; changing the catalog or tracked side selects a separate local database so existing trade direction/price history cannot be reinterpreted. Old records remain on disk.

Only EVM pools with 0x addresses are currently supported. Network IDs use CoinGecko identifiers (`eth`, `base`, `arbitrum`, etc.). Non-EVM links are rejected explicitly. Support for a network or token does not guarantee meaningful sample sizes or live delivery. The tracked token may be either side of a verified pool. Nonstandard provider payloads fail safely instead of manufacturing values.

Your settings are in `.local/dashboard.json`, and databases are in `.local/data/<catalog-id>/` (ignored by Git). The standard start command does not load a repository `.env` and does not inherit inherited CoinGecko credentials, demo tunnel configuration or deployment lifetime. It binds only to loopback. No ngrok, account signup, telemetry or public server is started. A native SQLite dependency may require platform build tools if its prebuilt binary is unavailable. macOS is tested; Windows/Linux should use supported Node/pnpm releases but are not claimed as end-to-end tested here. File permission modes provide owner-only protection on POSIX; apply appropriate account/ACL protection on Windows.

## Development

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm smoke
```

After source changes, rebuild before starting. `pnpm start:server` and `pnpm dev` are advanced developer paths that can load a locally created `.env`; no environment file or credential is shipped. Never put secrets in VITE-prefixed settings, URLs or frontend code. Browser API calls use the same origin; provider calls are server-side and cannot be redirected to arbitrary hosts.

## Research limitations

Score weights are 25/20/25/20/10. Missing inputs remain unavailable and are not reweighted. No confirmed alert while WS/provider data is stale or samples are insufficient. A displayed score band is not a confirmed alert. Real alerts retain frozen evidence and 5/15/60/240-minute outcomes when available. Synthetic/replay results never count as real validation. Senders may be routers; seller groups do not identify beneficial owners or skilled traders. Sparse pools may never satisfy confirmation gates. No profitability is implied.

## Security

Read [the security model](SECURITY.md) before deployment. Never commit `.local/`, `.env`, database files, credentials or runtime reports. Offline synthetic tests are included; real market captures and user data are not.

Provider references: [pool search](https://docs.coingecko.com/reference/search-pools), [WebSocket access](https://docs.coingecko.com/websocket).
