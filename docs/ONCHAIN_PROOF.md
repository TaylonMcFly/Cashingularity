# Cashingularity — Live Bitcoin Cash Chipnet On-Chain Proof & XO Stack Reproduction

Generated: `2026-11-16T10:07:01.033Z`

Fulcrum Node: `fulcrum://chipnet.bch.ninja:50002`

---

## 1. Live Broadcasted Chipnet Transactions

### Transaction 1: Multi-Output Chipnet Wallet Funding (Multi-Send Batch)
- **TXID**: `a87122c361114ab59e6547fad6f6921fd948700f51ed80dc365ddeb5a542ec3f`
- **Explorer**: https://chipnet.chaingraph.cash/tx/a87122c361114ab59e6547fad6f6921fd948700f51ed80dc365ddeb5a542ec3f
- **Inputs**: `f72072bb04ceee882651006c517d1fe3a06ec2d1aaeb7b016ede92f4b2942e0d:0` (`500,000` sats)
- **Outputs**:
  - Output #0: `120,000` sats → `bchtest:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnqseeszx8x` (Deterministic BIP39 Test Wallet `m/44'/145'/0'/0/0`)
  - Output #1: `50,000` sats → `bchtest:qq37uk39ascddup6f4vf2a75w33vcl9c5gh4ml5k96` (`bchtest:zq37uk39ascddup6f4vf2a75w33vcl9c5gslgp6s6f`)
  - Output #2: `329,500` sats → `bchtest:qr78y59zz80dm3cwuk388r097pupwdguaugjl6473v` (Change)

### Transaction 2: Historical P2SH32 funding transfer
- **TXID**: `8b3fb7c71e2f7bdeab411acbec82240a1801c71eb4866396370420e98fca69e0`
- **Explorer**: https://chipnet.chaingraph.cash/tx/8b3fb7c71e2f7bdeab411acbec82240a1801c71eb4866396370420e98fca69e0
- **Sender Address (`m/44'/145'/0'/0/0`)**: `bchtest:qqyx49mu0kkn9ftfj6hje6g2wfer34yfnqseeszx8x` (`bchtest:zqyx49mu0kkn9ftfj6hje6g2wfer34yfnqhn2wvqc4`)
- **Target P2SH32 Covenant Address**: `bchtest:p0aarfxj2rc70a4yrdj5j6mtza2zex25jjfprg27qsf8vzfv58c8khl7sv6my` (`aa20...87`)
- **Output Amount**: `15,000` sats (`0.00015000 BCH`)
- **Local CashVM Verification**: `createVirtualMachineBCH().verify(...) === true`
- **Signed Transaction Hex**:
```text
02000000013fec42a5b5de5d36dc80ed510f7048d91f92f6d6fa47659eb54a1161c32271a8000000006441303499c53851f548de604e08b32ff2cb94c2372f3cfb21b8026bb0e8fa7a10d3c5483da8e7f095b4fccd5a6f29cbdccf30cbfa4731dfa6ace35a8ea2b4010518412102bbe7dbcdf8b2261530a867df7180b17a90b482f74f2736b8a30d3f756e42e217ffffffff02983a00000000000023aa20fbd1a4d250f1e7f6a41b65496b6b17542c9954949211a15e041276092ca1f07b8784980100000000001976a914086a977c7dad32a56996af2ce90a727238d4899888ac00000000
```

The raw transaction has one wallet input and two outputs without CashTokens. It demonstrates wallet funding of a P2SH32 output. The UP/DOWN pool stake, receipt issuance, settlement, and refunds require separate verification. The November 20, 2026 read-only check found this transaction in one Chipnet peer's mempool at height `-1`. The second peer returned no record.

### Current UP/DOWN verification

The testnet artifact uses the app's 13-byte big-endian receipt format. Mocknet verifies both outcomes, exact conservation across several winning receipts, and principal refunds. The tests exercise the real compiled CashScript in the BCH 2026 VM and model UTXO consumption separately. They reject wrong owners, categories, oracle and round signatures, early claims and refunds, payout changes, conservation violations, and repeated spends.

The pool input requires its P2SH32 function unlock. Deductions from the pool equal the calculated payout or refunded stake, and fees come from the wallet's funding or receipt input. That input requires the holder's separate P2PKH signature. A final payout or refund returns the reserve and removes the minting baton.

Genesis verification is part of admission. Participants must validate the unique zero-state baton against the actual pinned genesis transaction. The oracle authorizes each deposit against its exact pool and funding outpoints and signs the close for that round's locking script. Block locktime establishes a lower bound. An already authorized deposit can remain valid while the pool is open, and the first confirmed settlement or refund determines the phase. A genesis funded without any stakes has no reserve recovery path in this artifact. Mainnet prediction staking stays disabled.

Use these commands to reproduce the local checks.

```powershell
npm run build:cashscript
npm run test:cashscript
node scripts/prediction-chipnet.mjs --verify-receipts docs/prediction-chipnet-receipts-2026-11-20.json
```

The receipts contain signed transaction bytes, public source outputs, network anchors, and peer observation times. A record with an empty `observedAt` field represents a preflighted transaction awaiting broadcast verification.

### Chipnet run on November 20, 2026

Both `chipnet.bch.ninja` and `chipnet.imaginary.cash` returned identical bytes for all nine transactions following the 30,000-sat faucet funding. The two pool genesis transactions and all three stakes confirmed in block 339734. The final run used Unix timestamps derived from the peers' median time past.

| Operation | TXID | Confirmed block | Accounting |
| --- | --- | --- | --- |
| UP settlement | `ca905860ab3fa6798ed5d61d09791e82bbfba08e7b63465529c27d1de6bd2cb5` | 339740 | 2,200 sats from the pool, 300 sats left from the receipt input, and a 1,500-sat reserve returned separately |
| Timeout refund | `53868a8dd5069d1fd1f6c1537944f0322c93f23dd7d05e258e8b69bf6364653c` | 339743 | 1,100 sats refunded, 300 sats left from the receipt input, and a 1,500-sat reserve returned separately |

[Timestamp-based Chipnet receipts](prediction-chipnet-receipts-2026-11-20.json)

The first Chipnet runner omitted the bucket argument and stopped after pool setup. The next runner completed the stakes, then hit `bad-txns-nonfinal` because it used displayed block heights for locktime under the Faster Blocks rules. Those partial runs remain available for independent verification. [Setup-only receipts](prediction-chipnet-setup-only-2026-11-20.json) [Height-locked run](prediction-chipnet-height-lock-2026-11-20.json) [BCHN Chipnet preview](https://bitcoincashnode.org/en/newsroom/2026-11-14_opinion_on_faster_blocktime)

## 2. Verified XO Stack Template Identifiers & Serialized `XOInvitation`

- **Engine Version**: `@xo-cash/engine@0.1.0-next.17612568780`
- **Libauth Version**: `@bitauth/libauth@3.1.0-next.8`
- **Validated P2PKH Template Hash (`getTemplateHash`)**:
  `a31eb85891dbf248f1709a92b0fa7e3e6fdc518e6b34e376b197ed7f12dbc672`
- **Cashingularity Prediction Pool Template Hash (`getTemplateHash`)**:
  `06ea82511c453f1b804c7fa891caacb8c4b58171255da54400ee0682af3a98aa`

### Illustrative serialized `XOInvitation` (`serializeInvitation()`)

This JSON illustrates the wire format. Its example signatures and identifiers carry no settlement or broadcast evidence.
```json
{"invitationIdentifier":"8f4e2c1a9b0d7e6f5a4c3b2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f","templateIdentifier":"06ea82511c453f1b804c7fa891caacb8c4b58171255da54400ee0682af3a98aa","actionIdentifier":"placePredictionStake","createdAtTimestamp":1763200000000,"commits":[{"commitIdentifier":"1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b","entityIdentifier":"tpubD6NzVbkrYhZ4XgiXtGrdW5XDAPFCL9h7we1vwNCpn8tGbBcgfVYjXyhWo4E1xkh56hjod1RhGjxbaTLV3X4FyWuejifB9jusQ46QzG87VKp","createdAtTimestamp":1763200000000,"data":{"roleIdentifier":"predictor","variables":[{"variableIdentifier":"stakeSatoshis","roleIdentifier":"predictor","value":"<bigint: 15000n>"},{"variableIdentifier":"receiptCommitment","roleIdentifier":"predictor","value":"00000001010000000000003a98"}],"inputs":[{"outpointTransactionHash":"<uint8array: a87122c361114ab59e6547fad6f6921fd948700f51ed80dc365ddeb5a542ec3f>","outpointIndex":0}],"outputs":[{"outputIdentifier":"poolStakeContinuationOutput"},{"outputIdentifier":"predictorReceiptOutput"}]},"signature":"abababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababababab","expiresAtTimestamp":1763286400000}]}
```

### How to Verify in the XO Blaze Playground (https://blaze.xo.cash/)
1. Open https://blaze.xo.cash/ in your browser.
2. Import `packages/contracts-xo/xo-prediction-template.json`.
3. Verify the computed template hash equals `06ea82511c453f1b804c7fa891caacb8c4b58171255da54400ee0682af3a98aa`.
4. Inspect the format with `deserializeInvitation()` from `@xo-cash/utils`. Use the confirmed CashScript receipts above to verify Chipnet broadcasts.
