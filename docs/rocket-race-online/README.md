# Rocket Race Online

Open **Arcade → Online Multiplayer**. Pick a nickname, difficulty, and a grid of two, three, or four pilots. **Quick Match** joins the first compatible public lobby or opens one. **Browse Rooms** shows open public lobbies. Create a private room to share a six-character code. Private rooms can fill empty seats with computer pilots after at least two people join.

Everyone readies up before the shared three-second countdown. Use the same keyboard or touch controls configured in Arcade Settings. The first rocket across wins and the remaining pilots have up to 12 seconds to finish, subject to the race time limit. A rocket that misses the finish is placed by distance, behind everyone who crossed. Retired rockets place last. To run another round in the same room, remaining pilots vote for a rematch.

## Run locally

```sh
npm run build
npm start
```

Open [Online Multiplayer](http://localhost:3000/arcade/rocket-race/online) in two independent browser profiles or connect a second device to the same server. A tab uses a separate anonymous pilot token. If a duplicated tab copied the first tab's token, choose **New pilot** in the second tab.

## Run behind HTTPS

Build and run the same application on a single backend instance behind an HTTPS reverse proxy. Serve the UI, `/api/arcade/rocket-race/online/leaderboard` and `/ws/arcade/rocket-race` through the same origin. The browser selects WSS automatically on HTTPS. Forward the original `Host` and `Origin` and enable WebSocket upgrades. An example Nginx location, with your backend already serving the app on port 3000:

```nginx
location /ws/arcade/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_read_timeout 75s;
}
```

If the proxy is local, set `ARCADE_TRUST_PROXY_IPS=127.0.0.1` on the backend and keep that upstream port inaccessible directly. Use the edge's actual IP if it runs elsewhere. The trusted proxy must overwrite `X-Forwarded-For` with a single client IP. With no trusted proxy configured, connection limits use the TCP peer IP.

| Setting | Default and behavior |
| --- | --- |
| `ARCADE_WS_PATH` | `/ws/arcade/rocket-race`. Custom paths must be under `/ws/arcade/`. |
| `VITE_ARCADE_WS_URL` | Same-origin default. Set at frontend build time to a path or a full WSS URL when using a custom path or separate WS host. |
| `ARCADE_ALLOWED_ORIGINS` | The request host over HTTP or HTTPS. To connect from a separate UI origin, specify an exact comma-separated list such as `https://play.example.com`. |
| `ARCADE_TRUST_PROXY_IPS` | Empty. Accepts a comma-separated list of trusted proxy IP literals. |
| `ARCADE_RECONNECT_MS` | 30000. Supports 5000 to 120000 milliseconds. |
| `ARCADE_MAX_CONNECTIONS` | 256 simultaneous sockets. |
| `ARCADE_MAX_PER_IP` | 16 simultaneous sockets per IP. Choose a value that fits shared networks. |
| `ARCADE_MAX_ROOMS` | 64 concurrent rooms. |

Keep the backend's `.cashingularity-data` directory on persistent storage. Protect `arcade-online.key`, which signs anonymous pilot tokens, and retain `arcade-online-results.json` to preserve rankings. This implementation assumes one process owns active rooms and the rankings file.

## Race and connection rules

- The server advances a seeded course at 60 physics ticks per second. It validates and rate-limits control input, accepts only newer sequences for the active race, and publishes quantized snapshots at up to 20 Hz. The browser predicts its own rocket and interpolates remote rockets. Results and stats come from the server.
- Disconnecting immediately clears steering, thrust, and boost input. The rocket coasts using ordinary physics, including obstacle collisions. The pilot has 30 seconds by default after detection to resume the same seat. Expiry or explicitly leaving retires an unfinished rocket. Backgrounding clears local controls and suspends drawing. The race keeps running.
- A refresh in the same tab reuses its pilot token. An already-connected token keeps its current socket. The backend expires abandoned rooms and uses WebSocket heartbeats. A server restart clears races and lobbies while keeping valid pilot tokens and saved rankings.
- Ranked public results require a winner and at least two non-retired human pilots. Private rounds, including those with AI, still show authoritative results in the room. Shared rankings cover the latest 2,000 eligible races. Nicknames are public, multiple pilots can use the same name, and rankings follow the pilot's anonymous session ID. Clearing or losing the tab's token creates a new identity. Anonymous play allows multiple accounts, coordinated pilots, and automation that stays within permitted inputs.

## Reproduce verification

```sh
npm run build
npm test
node scripts/rocket-race-online-smoke.cjs
node --expose-gc scripts/rocket-race-online-load.cjs
node scripts/rocket-race-smoke.cjs
```

The browser script uses Playwright and Chromium. Set `PLAYWRIGHT_MODULE` to the module path if it is installed outside the workspace, and `CHROME_PATH` to use an installed Chromium or Chrome binary. It runs an isolated loopback backend with a fixed test course and blocked HTTP writes. It measures two and four concurrent browser contexts, checks the persisted ranking, and applies delay, jitter, and dropped snapshot messages to one touch context. Its mobile measurements use desktop Chrome with touch emulation and 4× CPU throttling.

- [Browser race results and frame timings](browser-results.json)
- [Backend CPU, heap, cleanup and WebSocket payload traffic](load-metrics.json)
- [Private lobby](private-lobby.png) · [Touch race in landscape](mobile-race.png) · [Four-player race](four-player-race.png) · [Official results](four-player-results.png)

## Source map

- `packages/shared/src/rocketRace/physics.ts` and `online.ts` share the deterministic physics and versioned wire types.
- `packages/backend/src/onlineRooms.ts`, `onlinePilotIdentity.ts`, `onlineScoreboard.ts`, and `rocketRaceOnline.ts` own WebSocket rooms, sessions, results and limits. `index.ts` registers the Arcade routes.
- `packages/frontend/src/arcade/online/` contains the lobby, race UI, prediction and transport, and online leaderboard. `RaceDisplay.tsx`, `RaceStage.tsx`, and `renderer.ts` share presentation and controls with Single Player. `Arcade.tsx`, `Leaderboard.tsx`, `arcade.css`, and `services/workspaceRoutes.ts` integrate navigation and styling.
