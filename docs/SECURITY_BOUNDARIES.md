# Security boundaries

## Wallet and chain data

- Local HD recovery phrases and signing keys stay in the browser wallet. Encrypted backups can use a device key or password protection. Backup material and pairing credentials belong outside the source tree.
- Watch-only profiles and cached extended public keys support address discovery. WizardConnect signing requires a verified live session and explicit approval. Unit and browser fixture tests cover pairing, reconnection, duplicate sessions, and transaction checks. Physical signing with Selene and Paytaca remains pending.
- The review flow validates address network, UTXOs, token-aware coin selection, approved outputs, and signed transaction bytes. The backend relays already signed transactions. Public release checks use read-only wallet data and game traffic.
- Wallet synchronization refreshes UTXOs and history after reconnects and checks for changes across reorganizations. When the feed is unavailable, the UI reports degraded availability.

## Public deployment

The wallet and verification frame use separate origins. The frame has an explicit parent allowlist and serves only Turnstile resources. The production backend binds to loopback by default. The public reverse proxy exposes the current UI APIs and WebSockets. Administrative, payroll scheduling, analytics exports, and XO sidecar endpoints stay internal. Keep the data directory and environment file private and backup access-restricted.

## Experimental contracts

Public deployments use Paper Trading for market positions and reject contract preparation. The confirmed Chipnet records demonstrate specific CashScript paths under the documented oracle, admission, and locktime rules. See [on-chain proof](ONCHAIN_PROOF.md) for verified transactions and remaining limits.

## Arcade

The game uses distinct anonymous sessions and a dedicated WebSocket. The server validates controls, sequences, rate limits, and room membership, then determines official rankings. Public rankings use pilot nicknames and IDs. Anonymous players can use multiple identities or coordinate with one another.
