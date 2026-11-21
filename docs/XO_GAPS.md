# XO Stack Developer Experience Report, Reproduction Guide & Identified Gaps (`XO_GAPS.md`)

**Project**: Cashingularity (BCH BLAZE 2026)

**Target Bounties**: General Protocols — *Build with XO* (2 BCH) & *Migrate a Contract to XO* (1.5 BCH)

**Verified Stack**: `@xo-cash/engine@0.1.0-next.17612568780`, `@xo-cash/templates@0.0.12`, `@xo-cash/utils@0.0.10`, `@xo-cash/types@0.0.8`, `@xo-cash/state@0.0.5`, `@bitauth/libauth@3.1.0-next.8`

---

## 1. Step-by-Step Judge Reproduction Guide (`https://blaze.xo.cash/` & CLI)

### Option A: Inspecting in `https://blaze.xo.cash/`
1. Open [packages/contracts-xo/xo-prediction-template.json](file:///d:/Cashingularity/packages/contracts-xo/xo-prediction-template.json) or [docs/xo-reproduction-artifacts.json](file:///d:/Cashingularity/docs/xo-reproduction-artifacts.json).
2. Paste the `Cashingularity Parimutuel Prediction Pool` template JSON into `https://blaze.xo.cash/`.
3. Confirm the deterministic `templateIdentifier` hash resolves to:
   ```text
   06ea82511c453f1b804c7fa891caacb8c4b58171255da54400ee0682af3a98aa
   ```
   (and `p2pkhTemplate` resolves to `a31eb85891dbf248f1709a92b0fa7e3e6fdc518e6b34e376b197ed7f12dbc672`).
4. Inspect the migrated roles (`predictor` and `service`), actions (`placePredictionStake`, `claimRoundPayout`, `reclaimExpiredStake`), and the serialized invitation wire payload (`reproducibleInvitation.serializedInvitationString` in `docs/xo-reproduction-artifacts.json`).

### Option B: Running the Chipnet E2E Script Locally
```bash
npm run e2e:xo
```

---

## 2. Technical Observations & Actionable Feedback for General Protocols

During our migration of `PredictionPool.cash` into [xo-prediction-template.json](file:///d:/Cashingularity/packages/contracts-xo/xo-prediction-template.json) and live Chipnet testing of [xoBridgeService.ts](file:///d:/Cashingularity/packages/contracts-xo/src/xoBridgeService.ts), we documented the following actionable findings for `@xo-cash/*` and `@electrum-cash/application`:

1. **Chipnet Block Header `332451` Target Validation Failure in `@electrum-cash/application`**:
   - When calling `Engine.create(mnemonic, { network: XO_SUPPORTED_NETWORKS.chipnet, ... })`, `@electrum-cash/application` synchronizes Chipnet block headers from Genesis and throws a recurring header target validation error at **Chipnet height `332451`**:
     ```text
     Failed to synchronize block headers, will retry later: Error: Header
     '00000000000ecc7187034ddaa4327af300c23fd57bfd2557af6ca2392a022671' at height 332451
     claims target 486604799, expected 437753688.
       at validateBlockHeader (@electrum-cash/application/dist/index.mjs:1460:89)
       at async processBlockHeader (@electrum-cash/application/dist/index.mjs:1787:29)
       at async synchronizeBlockHeaders (@electrum-cash/application/dist/index.mjs:1999:59)
     ```
   - *Root Cause*: Target `486604799` (`0x1d00ffff`) is the testnet/Chipnet 20-minute minimum-difficulty rule trigger (`nBits = 0x1d00ffff`), whereas `validateBlockHeader` in `@electrum-cash/application` expects the ASERT target `437753688` without applying the testnet/Chipnet 20-minute min-difficulty exception.
   - *Suggestion*: In `@electrum-cash/application` `validateBlockHeader`, allow `nBits === 0x1d00ffff` (`486604799`) when `network === 'chipnet'` and `header.timestamp - parentHeader.timestamp > 1200`.

2. **Zod Schema Naming Asymmetry (`lockingScript` vs `lockingBytecode`)**:
   - In `@xo-cash/utils@0.0.10`, `xoTemplateOutputSchema` requires the property name `lockingScript: string` (referencing a key in `template.lockingScripts`), whereas `xoTemplateLockingScriptSchema` uses `lockingBytecode: string`.
   - *Suggestion*: Documenting `lockingScript` (reference identifier) vs `lockingBytecode` (inline script/assembly) in the TypeScript JSDoc on `XOTemplateOutput` prevents schema validation errors during contract migration.

3. **Sub-Package Peer Dependency Pinning (`@xo-cash/utils` `0.0.10` vs `0.0.12`)**:
   - Installing `@xo-cash/utils@latest` (`0.0.12`) alongside `@xo-cash/engine@0.1.0-next.17612568780` pulls in `@xo-cash/types@0.0.10`, whereas `@xo-cash/engine` internally depends on `@xo-cash/types@0.0.8` and `@xo-cash/utils@0.0.10`.
   - *Workaround Applied*: We pinned exact matching versions (`@xo-cash/utils@0.0.10`, `@xo-cash/types@0.0.8`, `@xo-cash/templates@0.0.12`, `@xo-cash/state@0.0.5`) in [packages/contracts-xo/package.json](file:///d:/Cashingularity/packages/contracts-xo/package.json).

4. **Derivation Path Isolation (`m/2415'/...` vs `m/44'/145'/...`) & `addChangeToInvitation` Ordering**:
   - `@xo-cash/engine` derives keys under `m/2415'/...` rather than standard BIP44 `m/44'/145'/...`, and `addChangeToInvitation(id)` must be invoked strictly before `signInvitation(id, idx)`. Both invariants are enforced in [xoBridgeService.ts](file:///d:/Cashingularity/packages/contracts-xo/src/xoBridgeService.ts).
