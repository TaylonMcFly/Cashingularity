# Rocket Race

For live races with other pilots, open **Arcade → Online Multiplayer**. See the [online rules and setup](../rocket-race-online/README.md).

Open **Arcade → Play Rocket Race**. Choose Easy, Normal, or Hard and a grid of two to four rockets. A blank seed generates a new course. Enter a seed to replay a local course. Ranked races use a server-issued seed.

- **Desktop** uses WASD or arrow keys to steer, thrust, and brake. Space spends a boost. Esc pauses or resumes.
- **Mobile** uses a joystick or drag steering and a separate boost button. Arcade Settings controls the boost hand, touch sensitivity, control size, and portrait inset. Rotating the device keeps the race in progress.
- Five consecutive close asteroid passes bank one boost. A collision slows the rocket and clears the streak. Banked charges remain available.
- The first rocket across the finish line wins. The results include every rocket's placement and any genuine finish time. Rockets still on track show their remaining distance.
- Each dodge earns 100 points, each charge earned adds 40, and a win adds 400. Each collision costs 30 points. Scores have a floor of zero.

## Leaderboards

Local names, preferences, and the latest 500 race results live in this browser. Ranked attempts also save a local result. A shared score appears only after the backend replays the recorded controls under the original course, grid size, and rules version. A ranked invitation expires after 30 minutes or when the server restarts. Retrying an acknowledged submission returns the existing score.

Shared totals cover the latest 2,000 verified results on the serving instance. Nicknames are public and scores with the same nickname are grouped together. Verification checks the race rules and timing. It cannot distinguish a person from automated controls that follow those rules.

## Verification

Run from the workspace root with Node.js 22 or newer.

```text
npm run build
npm test
node scripts/rocket-race-smoke.cjs
```

The smoke script uses Playwright and Chromium. Set `PLAYWRIGHT_MODULE` if Playwright is installed outside the workspace, and `CHROME_PATH` to select an installed browser. It starts a temporary loopback backend with wallet writes blocked. It exercises both themes at 375, 390, 768, 1280, and 1920 pixels, then runs complete mobile and ranked races. The mobile run uses two simultaneous touch contacts and checks the saved result after reload.

[Browser measurements](browser-metrics.json) capture rendered animation frames, frame intervals, and time spent in the game frame callback. Heap measurements use Chromium after forced garbage collection and compare idle states around repeated game mounts. Mobile figures use desktop Chromium with a touch-enabled viewport. The low-quality sample also uses 4× CPU throttling.

[Arcade landing](arcade-dark.png) · [Desktop race](rocket-race-desktop.png) · [Mobile race](rocket-race-mobile.png) · [Ranked results](rocket-race-results.png)

## File map

- The engine, track generator, bot controls, replay, and score model live in `packages/shared/src/rocketRace/`. `packages/shared/package.json` exposes them through the Rocket Race subpath.
- The separate game screens and input, rendering, audio, storage, and API clients live in `packages/frontend/src/arcade/`. `App.tsx`, `services/workspaceRoutes.ts`, and `styles.css` integrate the new navigation and layout.
- `packages/backend/src/rocketRace.ts` serves ranked challenges, verified scores, and shared rankings. `packages/backend/src/index.ts` registers the routes.
- `scripts/rocket-race-smoke.cjs` runs real browser races and captures the verification evidence. Arcade unit and endpoint tests sit beside their modules. The existing workspace navigation assertions in `services/marketRoutes.test.ts` and `scripts/wallet-home-smoke.cjs` cover the added tab.
