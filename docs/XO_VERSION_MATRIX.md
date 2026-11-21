# XO Stack Verified NPM Version & Signature Matrix (`BCH BLAZE 2026`)

Verified on **2026-11-15** via `npm view @xo-cash/*` and inspected against installed `.d.ts` files in `packages/contracts-xo/node_modules/@xo-cash/*`.

## 1. Pinned Package Versions (`packages/contracts-xo/package.json`)

| Package | Pinned Version | Dist-Tags (`latest` / `next`) | Notes & Compatibility |
| :--- | :--- | :--- | :--- |
| `@xo-cash/engine` | `0.1.0-next.17612568780` | `latest: 0.0.1`, `next: 0.1.1-next.18029697917` | Latest `0.1.0-next.*` release; matches `getting-started.html` and pins exact sub-packages below |
| `@xo-cash/templates` | `0.0.12` | `latest: 0.0.12` | Exports `p2pkhTemplate`, `multisigTemplate`, `faucetCashTemplate`, `wrapBCHTemplate`, `wrapBCHChipnetTemplate` |
| `@xo-cash/utils` | `0.0.10` | `latest: 0.0.11` | Pinned to `0.0.10` to match `@xo-cash/engine` internal dependency and avoid duplicate Zod schemas |
| `@xo-cash/types` | `0.0.8` | `latest: 0.0.9` | Pinned to `0.0.8` to match `@xo-cash/engine` and `@xo-cash/templates@0.0.12` |
| `@xo-cash/state` | `0.0.5` | `latest: 0.0.6` | Pinned to `0.0.5` (`StorageType.SQLITE`, `StorageType.INDEXEDDB`) |
| `@xo-cash/primitives` | `0.0.3` | `latest: 0.0.3` | Strict branded primitive validators |
| `@bitauth/libauth` | `^3.1.0-next.8` | `latest: 3.0.0`, `next: 3.1.0-next.8` | Strictly isolated in `packages/contracts-xo` so it never collides with `@solidcash/*` |

## 2. Verified `.d.ts` Signatures (`@xo-cash/engine@0.1.0-next.17612568780`)

All methods verified directly from `packages/contracts-xo/node_modules/@xo-cash/engine/dist/index.d.mts`:

- **Lifecycle & Network**:
  - `Engine.create(mnemonic: string, options?: XOEngineOptions): Promise<Engine>`
  - `XO_SUPPORTED_NETWORKS = { mainnet: "mainnet", chipnet: "chipnet", testnet4: "testnet4" } as const`
  - `engine.stop(): Promise<void>`
  - `engine.getChainStatus(): Promise<ChainStatus>`
  - `engine.listElectrumConnections(): ElectrumConnection[]`
- **Templates & Default Policies**:
  - `engine.importTemplate(untrustedJsonOrObject: string | XOTemplate): Promise<{ template: XOTemplate; templateIdentifier: XOTemplateIdentifier }>`
  - `engine.getTemplate(templateIdentifier: XOTemplateIdentifier): Promise<XOTemplate | undefined>`
  - `engine.listTemplates(options?: StorageListOptions): Promise<StoredTemplate[]>`
  - `engine.setDefaultPolicies(policiesToSet: Partial<WalletDefaultPolicies>): Promise<void>`
  - `engine.getDefaultPolicies(): Promise<WalletDefaultPolicies>`
  - `engine.generateLockingBytecodeFromDefaultPolicy(policy: WalletDefaultPolicyName, variableValues?: Record<string, XOInvitationVariableValue>, invitationIdentifier?: XOInvitationIdentifier): Promise<string>`
  - `getTemplateLockingScriptOrThrow(template: XOTemplate, lockingScriptIdentifier: XOTemplateLockingScriptIdentifier): XOTemplateLockingScript`
- **UTXOs & Script Hashes**:
  - `engine.listUnspentOutputs(query?: UnspentOutputDataQuery, filter?: UnspentOutputDataFilter): Promise<UnspentOutputData[]>`
  - `engine.listSpendableUnspentOutputs(options?: StorageListOptions): Promise<UnspentOutputData[]>`
  - `engine.listScriptHashData(query: ScriptHashDataQuery): Promise<ScriptHashData[]>`
- **Invitations, Change, Signing, Preview & Execution**:
  - `engine.createInvitation(params: InvitationCreationParameters): Promise<StoredInvitation>`
  - `engine.getInvitation(invitationIdentifier: XOInvitationIdentifier): Promise<StoredInvitation | undefined>`
  - `engine.listInvitations(options?: StorageListOptions): Promise<StoredInvitation[]>`
  - `engine.acceptInvitation(invitation: XOInvitation, params?: InvitationAcceptanceParameters): Promise<StoredInvitation>`
  - `engine.updateInvitation(updatedInvitation: XOInvitation): Promise<StoredInvitation>`
  - `engine.appendInvitation(invitationIdentifier: XOInvitationIdentifier, params: AppendInvitationParameters): Promise<StoredInvitation>`
  - `engine.listMissingRequirements(invitationIdentifier: XOInvitationIdentifier): Promise<InvitationMissingRequirements>`
  - `engine.listOutputResolutions(invitationIdentifier: XOInvitationIdentifier, outputIdentifier: XOTemplateOutputIdentifier, roleIdentifier?: XOTemplateRoleIdentifier): Promise<InvitationResolutionRequirements>`
  - `engine.appendOwnOutputResolutions(invitationIdentifier: XOInvitationIdentifier, outputIdentifier: XOTemplateOutputIdentifier, roleIdentifier?: XOTemplateRoleIdentifier): Promise<StoredInvitation>`
  - `engine.calculateChange(invitationIdentifier: XOInvitationIdentifier): Promise<MergedInvitationChange>`
  - `engine.estimateTransactionFee(invitationIdentifier: XOInvitationIdentifier): Promise<number>`
  - `engine.addChangeToInvitation(invitationIdentifier: XOInvitationIdentifier, providedLockingBytecode?: string, changeVariableValues?: Record<string, XOInvitationVariableValue>, changeSelection?: ChangeSelection): Promise<StoredInvitation>`
  - `engine.listOwnInputIndexes(invitationIdentifier: XOInvitationIdentifier): Promise<number[]>`
  - `engine.signInvitation(invitationIdentifier: XOInvitationIdentifier, inputIndex: number): Promise<StoredInvitation>`
  - `engine.buildInvitationTransactionFromMergedCommit(invitationIdentifier: XOInvitationIdentifier): Promise<BuiltInvitationTransaction>`
  - `engine.executeAction(invitationIdentifier: XOInvitationIdentifier, params: ExecuteActionParameters): Promise<ExecuteActionResult>`
  - `engine.archiveInvitation(invitationIdentifier: XOInvitationIdentifier): Promise<void>`

## 3. Verified `@xo-cash/utils@0.0.10` Signatures

- `parseTemplate(inputTemplate: string | XOTemplate): XOTemplate`
- `serializeTemplate(template: XOTemplate): string`
- `generateTemplateIdentifier(template: XOTemplate): XOTemplateIdentifier`
- `serializeInvitation(invitation: XOInvitation): string`
- `deserializeInvitation(serializedInvitation: string): XOInvitation`
- `parseInvitation(invitationValue: unknown): XOInvitation`
