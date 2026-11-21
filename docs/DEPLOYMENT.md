# Deploy Cashingularity on Ubuntu

The release uses one Node.js process behind a reverse proxy. Two public hostnames are used below so the wallet page can keep the Turnstile frame on its own origin. Replace `play.example.com` and `verify.example.com` with your hostnames.

## 1. Build a release checkout

Install the latest patched release of [Node.js 24 LTS](https://nodejs.org/en/about/previous-releases/) on the Ubuntu host. The service template expects `/usr/bin/node`. If your package manager or verified Node distribution uses another path, update `ExecStart`.

```sh
git clone https://github.com/TaylonMcFly/Cashingularity.git cashingularity-release
cd cashingularity-release
git checkout --detach <release-commit-sha>
npm ci --include=dev
npm ci --prefix packages/contracts-xo --include=dev --ignore-scripts
npm rebuild sqlite3 --prefix packages/contracts-xo
npm ci --prefix packages/contracts-solidcash --include=dev
```

The isolated XO unit tests load the SQLite N-API binding. The targeted rebuild installs that binding and skips unrelated native install scripts. If a prebuilt binding is unavailable, install the host's compiler toolchain and compatible Python. The public deployment keeps the live sidecar disabled.

Set `VITE_TURNSTILE_SITE_KEY` to your public site key and `VITE_TURNSTILE_FRAME_ORIGIN=https://verify.example.com` in `packages/frontend/.env.local`. Allow the verification hostname in the Cloudflare widget configuration. Run `npm run build` and `npm test`. The default frontend uses same-origin HTTP calls and WSS on HTTPS. Keep the default Arcade WebSocket path for the supplied proxy. If you change it, update `ARCADE_WS_PATH`, `VITE_ARCADE_WS_URL`, and the proxy together.

## 2. Install the persistent service

Create the `cashingularity` system user and group, then copy the built checkout, including installed dependencies, to `/opt/cashingularity/releases/<release-commit-sha>`. Point `/opt/cashingularity/current` at that release. Install [the systemd unit](../deploy/cashingularity.service) in `/etc/systemd/system/`.

Create `/etc/cashingularity/cashingularity.env` from [the template](../.env.example). Restrict it to root with mode `0600`. Set `TURNSTILE_WALLET_ORIGINS` and `ARCADE_ALLOWED_ORIGINS` to the public wallet origin, and `TURNSTILE_ALLOWED_HOSTNAMES` to the verification hostname. Put the real Turnstile secret in this server file only. With an empty secret, public registration and password/TOTP login fail closed. Wallet operations that do not use account protection, Markets, and Arcade can still be used.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now cashingularity
sudo systemctl status cashingularity
sudo journalctl -u cashingularity -n 50 --no-pager
```

The unit creates `/var/lib/cashingularity` and owns the files written there. Keep it outside the release checkout. Back it up under restricted access to preserve the account encryption key, WAL, Arcade pilot key and rankings. Switch the `current` link to deploy or roll back code without replacing the data. Restart between races when possible. Active rooms are in memory.

## 3. Publish through Cloudflare

**Existing Tunnel.** Install [the Nginx configuration](../deploy/cashingularity.nginx.conf) in Nginx's HTTP configuration, substitute both hostnames, and run `sudo nginx -t` before reloading. Point both Cloudflare published application routes at `http://127.0.0.1:8080` on the existing tunnel. Preserve the incoming Host. Restrict all three listeners (3000, 3001, and 8080) to loopback. Keep incoming SSH limited to administrator sources. See [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/).

**Standard Cloudflare proxy.** Give both Nginx server blocks a TLS listener on port 443 and an unexpired origin certificate valid for the corresponding hostname. Replace the Tunnel-only `set_real_ip_from` with the current [Cloudflare origin peer ranges](https://www.cloudflare.com/ips/) and restrict port 443 to those ranges at the cloud firewall and host. In Cloudflare, proxy the DNS records and select [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/). Preserve the WebSocket `Upgrade` and `Connection` forwarding in the template. Wallet and verification Node ports remain on loopback.

The template serves SPA deep links and allowlists the UI HTTP and WebSocket paths. Keep Cloudflare caching off for `/api/*`, `/ws*` and the verification frame, and preserve the normal HTTPS origin and request Host.

## 4. Verify from an external client

1. Open `/`, `/market`, `/settings`, and `/arcade/rocket-race/online` directly over HTTPS, then refresh each route.
2. Open a disposable watch-only profile, check its synchronization and Receive view, and confirm that Send requires a signing profile. Avoid using a funded production wallet for the deployment check.
3. Open the Markets price charts and start a Single Player race. Check the navigation and controls at a narrow viewport in both themes.
4. Join a two-player public match from two independent browser contexts. Drive both seats, compare the final rankings, and confirm `/api/arcade/rocket-race/online/leaderboard` records the race.
5. After the race, restart the service and verify the same ranking over public HTTPS. Inspect the WebSocket connection for WSS and HTTP 101.
6. Verify the public proxy denies internal endpoints and the verification host serves only the frame assets. Inspect the service journal for startup and runtime errors.
