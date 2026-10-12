# Security model

## Boundaries

The supported entry point is `pnpm start` on a trusted user's local machine. Setup asks for a CoinGecko Pro key on every launch using hidden terminal input. No key is saved by the wizard; it exists in process memory and the child environment. Operating-system administrators and other processes with sufficient privileges can inspect that memory/environment. This is not a secret vault or a multi-user service.

The launcher ignores repository `.env` credentials and removes inherited provider, tunnel and lifetime configuration before starting the server. User config/data live in ignored `.local/`, with POSIX directory permissions 0700 and settings mode 0600. Database directories are keyed by the configured pool/token identities; reversing the tracked token cannot mix the previous token's price or buy/sell history. An exclusive launcher lock prevents two standard launches sharing the local database. Developer entry points are advanced paths and may load a user-created `.env`.

REST credentials are sent only to the fixed CoinGecko Pro HTTPS origin in a header. Redirects are rejected. Pool URLs, network identifiers, contracts and metadata relationships are validated; arbitrary remote endpoints are not accepted. Search/setup responses have a 15-second timeout and a 2 MB cap. Terminal labels strip control and direction-override characters. Provider text is rendered as React text, not injected HTML. Unknown or unsupported data must remain unavailable.

The server listens on loopback, does not trust proxy headers by default, rejects foreign Host/Origin and cross-site browser requests, requires an action header for commands, and applies one shared command-rate limit. Browser requests use relative API paths. Only built frontend assets are served; `.env`, settings, source and SQLite are outside the static root. Unknown non-API paths may return the SPA HTML shell, never the named local file. CSP and frame restrictions reduce script/framing exposure. API/logger redaction and frontend bundle checks cover provider credentials. All tabs share one collector.

Anyone with access to the local account/loopback application can control it. No application password is provided. Do not expose this local profile through a tunnel or reverse proxy without a separate deployment security review and access policy. No tunnel is started by the release. In-app research alerts are off for a new dashboard until explicit local opt-in; they do not place orders.

## Repository hygiene

The repository contains application source, synthetic tests, build manifests and user documentation. Local settings, credentials, databases, session records and captures must remain outside Git. Review staged changes before publishing and enable secret scanning where available. `.gitignore` cannot remove a secret already committed: revoke and rotate any exposed key.

Do not attach logs, reports or databases to public issues without reviewing them. The application sends selected pool queries and authentication to CoinGecko; it does not upload local reports or telemetry.

Keep dependencies updated. Offline tests do not certify provider quota, every pool or every operating system. The supported launch workflow has been tested on macOS; Windows and Linux are not yet verified end to end.
