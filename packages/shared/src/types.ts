/**
 * @cashingularity/shared - Strict BigInt Domain & Protocol Types
 * BCH BLAZE 2026
 */

export const DUST_LIMIT_SATS = 546n;
export const SATS_PER_BCH = 100_000_000n;
export const DEFAULT_PROTOCOL_FEE_BPS = 100n; // 1.00% = 100 bps
export const BPS_DENOMINATOR = 10_000n;
export const EWMA_LAMBDA_DEFAULT = 0.94;

export type ExecutionMode = 'SANDBOX_MODE' | 'MAINNET_MODE';
export type BchNetwork = 'mainnet' | 'chipnet';
export type AiExecutionMode = 'LOCAL' | 'SSH_REMOTE' | 'CLOUD_API';

export type HDAccountScope = 'receive' | 'change' | 'defi';

export interface HDDerivationCoordinate {
  scope: HDAccountScope;
  branchIndex: 0 | 1 | 2;
  addressIndex: number;
  fullPath: `m/44'/145'/0'/${0 | 1 | 2}/${number}`;
}

export type CashTokenCapability = 'none' | 'mutable' | 'minting';

export interface CashTokenNftData {
  capability: CashTokenCapability;
  commitment: string; // Hex-encoded commitment bytes
}

export interface CashTokenData {
  categoryId: string; // 32-byte hex txid
  amount: bigint;     // Fungible token amount in base units (0n if pure NFT)
  nft?: CashTokenNftData;
}

export interface BcmrTokenMetadata {
  categoryId: string;
  name: string;
  symbol: string;
  decimals: number;
  description?: string;
  iconUri?: string;
  uris?: Record<string, string>;
  isVerified: boolean;
}

export interface WalletUtxo {
  txid: string;
  vout: number;
  satoshis: bigint;
  address: string;          // Standard CashAddr (bitcoincash:q... or bchtest:q...)
  tokenAddress: string;     // Token-aware CashAddr (bitcoincash:z... or bchtest:z...)
  derivationScope: HDAccountScope;
  addressIndex: number;
  isGenesisCapable: boolean; // True when vout === 0
  token?: CashTokenData;
}

/**
 * WizardConnect SignTransactionRequest tuple:
 * [inputIndex, "receive" | "change" | "defi", addressIndex]
 */
export type WizardSignInputPath = [number, HDAccountScope, number];

export interface WizardSignTransactionRequest {
  transaction: unknown;
  inputPaths: WizardSignInputPath[];
  userPrompt?: string;
}

// ============================================================================
// Rabby-Style Pre-Sign UTXO DAG Inspector Types
// ============================================================================

export interface DagInputNode {
  inputIndex: number;
  txid: string;
  vout: number;
  satoshis: bigint;
  address: string;
  isGenesisInput: boolean; // vout === 0 allows new CashTokens category genesis
  categoryId?: string;
  token?: CashTokenData;
  unlockingBytecodeHex?: string;
  derivationPath?: string;
}

export interface OpcodeDisassemblyItem {
  opcode: string;
  hex: string;
  description: string;
  isCovenantIntrospection: boolean;
}

export type AiRiskVerdictLevel = 'SAFE' | 'CAUTION' | 'CRITICAL';

export interface SecurityAuditReport {
  disassembledOpcodes: OpcodeDisassemblyItem[];
  minerFeeSats: bigint;
  feeRateSatsPerByte: number;
  dustPassed: boolean;
  bcmrVerified: boolean;
  bcmrMetadata?: BcmrTokenMetadata;
  addressReuseDetected: boolean;
  aiVerdict: AiRiskVerdictLevel;
  aiExplanation: string;
  analysisMode: AiExecutionMode;
}

export type OutputScriptType = 'P2PKH' | 'P2SH32' | 'OP_RETURN' | 'UNKNOWN';

export interface NftReceiptCommitment {
  marketId: number;         // 4 bytes uint32 BE
  bucketId: number;         // 1 byte uint8 (0 = NO/DOWN, 1 = YES/UP, or bucket index)
  stakeSats: bigint;        // 8 bytes uint64 BE
  entryPriceCents?: number; // Optional 4 bytes uint32 BE (for 20-byte extended receipts)
  flagsHex?: string;        // Optional 3 bytes protocol version & fee tier
  rawHex: string;
}

export interface DagOutputNode {
  index: number;
  address: string;
  scriptType: OutputScriptType;
  lockingBytecodeHex: string;
  satoshis: bigint;
  isChange: boolean;
  token?: CashTokenData;
  decodedCommitment?: NftReceiptCommitment;
}

export interface UtxoDagInspection {
  txidPreview: string;
  inputs: DagInputNode[];
  audit: SecurityAuditReport;
  outputs: DagOutputNode[];
}

// ============================================================================
// Configurable Parimutuel Prediction Market & Volatility Cone Types
// ============================================================================

export type MarketStatus = 'OPEN' | 'LOCKED' | 'RESOLVED' | 'REFUNDED';

export type MarketPositionStatus = 'OPEN' | 'WON' | 'LOST';

export type OutcomeRuleKind = 'ABOVE' | 'BELOW' | 'RANGE';

export interface MarketPositionRecord {
  positionId: string;
  marketId: number;
  marketTitle: string;
  bucketId: number;
  bucketLabel: string;
  outcomeRule?: OutcomeRuleKind;
  lowerBoundCents?: number;
  upperBoundCents?: number;
  stakeSats: bigint;
  entrySpotUsd: number;
  strikePriceUsd: number;
  lockedMultiplierBps: number;
  placedAtMs: number;
  expiresAtMs: number;
  mode: ExecutionMode;
  txid: string;
  predictorAddress?: string;
  status: MarketPositionStatus;
  payoutSats: bigint;
  settledAtMs?: number;
  settlementSpotUsd?: number;
}

export interface MarketBucketPool {
  bucketId: number;
  label: string;
  poolSats: bigint;
  participantCount: number;
  impliedProbability: number;
  currentMultiplier: number;
  outcomeRule?: OutcomeRuleKind;
  lowerBoundCents?: number;
  upperBoundCents?: number;
}

export interface ConfigurableMarket {
  id?: string;   // Persistent UUID identifier
  slug?: string; // Stable URL slug (e.g. "bchusd-5m-flash")
  marketId: number;
  title: string;
  description: string;
  assetPair: string;
  strikePriceCents: number;
  createdAtMs: number;
  durationSeconds: number; // Any user-defined duration T (e.g. 300s to multi-day)
  expiryTimestampMs: number;
  feeBps: bigint;
  status: MarketStatus;
  totalPoolSats: bigint;
  buckets: MarketBucketPool[];
  oraclePubKeyHex: string;
  covenantAddress: string;
  categoryId: string;
  resolvedOutcome?: number;
  resolutionPriceCents?: number;
  resolutionSignatureHex?: string;
  timeframe?: '1m' | '5m' | '1h' | '24h';
  epochSeriesId?: string;
  slotStartMs?: number;
  slotLabel?: string;
  isCurrentSlot?: boolean;
  isFutureSlot?: boolean;
  isHistoricalSlot?: boolean;
  retentionExpiresAtMs?: number;
  epochKey?: string;
}

export interface VolatilityBandPoint {
  tauSeconds: number;
  timestampMs: number;
  meanPrice: number;
  upper1Sigma: number;
  lower1Sigma: number;
  upper2Sigma: number;
  lower2Sigma: number;
}

export interface ParimutuelSimulationResult {
  stakeSats: bigint;
  totalPoolAfterSats: bigint;
  bucketPoolAfterSats: bigint;
  protocolFeeSats: bigint;
  dustReserveSats: bigint;
  netDistributableSats: bigint;
  multiplier: number;
  estimatedPayoutSats: bigint;
  netProfitSats: bigint;
  calculationTimeMs: number;
}

// ============================================================================
// Multi-Currency Batch Payroll Parser & Scheduler Types
// ============================================================================

export type SupportedCurrency = 'USD' | 'EUR' | 'KZT' | 'RUB' | 'GBP' | 'USDT' | 'PUSD' | 'BCH';

export type PayrollValidationErrorCode =
  | 'INVALID_CHECKSUM'
  | 'NEGATIVE_OR_ZERO'
  | 'MISSING_CURRENCY'
  | 'NAN_AMOUNT'
  | 'BELOW_DUST_LIMIT';

export interface PayrollRow {
  rowIndex: number;
  rawLine: string;
  recipientAddress: string;
  tokenAwareAddress?: string;
  network?: BchNetwork;
  rawAmountText: string;
  parsedAmount: number;
  currency: SupportedCurrency | null;
  exchangeRateBchPerUnit: number;
  calculatedSats: bigint;
  label?: string;
  isBip21: boolean;
  isValid: boolean;
  errors: PayrollValidationErrorCode[];
  errorMessages: string[];
}

export interface FxQuoteLock {
  quoteId: string;
  ratesToBch: Record<SupportedCurrency, number>; // How many BCH per 1 unit of currency
  bchUsdPrice: number;
  lockedAtMs: number;
  expiresAtMs: number; // Locked for 60s
  fxSource?: string;
  fxFetchedAtMs?: number;
  spotSource?: string;
  spotFetchedAtMs?: number;
}

export interface PayrollBatchSummary {
  rows: PayrollRow[];
  validCount: number;
  invalidCount: number;
  totalSats: bigint;
  estimatedMinerFeeSats: bigint;
  grandTotalSats: bigint;
  allValid: boolean;
  quoteLock: FxQuoteLock;
}

export interface ScheduledPayrollJob {
  jobId: string;
  nLockTime: number;
  signedTxHex: string;
  totalSats: bigint;
  recipientCount: number;
  createdAtMs: number;
  status: 'PENDING_LOCKTIME' | 'BROADCASTED' | 'FAILED';
}

// ============================================================================
// Nostr-BCH Identity & Bridge Types
// ============================================================================

export interface NostrBchIdentityProof {
  cashAddrZ: string;        // bitcoincash:z... token-aware address
  npub: string;             // Nostr public key (npub1...)
  timestamp: number;        // Unix seconds
  nonce: string;            // Cryptographic nonce
  challengeHashHex: string; // SHA256("BCH-NOSTR-ID-V1" || cashaddr_z || npub || timestamp || nonce)
  bchSignatureHex: string;
  nostrSigHex: string;
  relayUrls: string[];
  verified: boolean;
}

export interface PusdBridgeQuote {
  quoteId: string;
  direction: 'BCH_TO_EVM' | 'EVM_TO_BCH';
  sourceToken: 'PUSD' | 'MUSD' | 'USDC' | 'USDT';
  targetToken: 'PUSD' | 'MUSD' | 'USDC' | 'USDT';
  inputAmountUnits: bigint;
  outputAmountUnits: bigint;
  bridgeFeeUnits: bigint;
  bchAddress: string;
  evmAddress: string;
  estimatedTimeSeconds: number;
}

export type PreparedContractType =
  | 'PREDICTION_STAKE'
  | 'INACTIVITY_VAULT'
  | 'PULL_REWARD_CLAIM';

export interface PreparedContractTransactionInput {
  outpointTransactionHash: string;
  outpointIndex: number;
  sequenceNumber: number;
  unlockingBytecodeHex: string;
  derivationScope: 'receive' | 'change';
  addressIndex: number;
}

export interface PreparedContractTransactionOutput {
  valueSatoshis: string;
  lockingBytecodeHex: string;
  address: string;
  isChange: boolean;
  token?: {
    categoryId: string;
    amount: string;
    nft?: {
      capability: CashTokenCapability;
      commitment: string;
    };
  };
}

export interface PreparedContractSourceOutput {
  valueSatoshis: string;
  lockingBytecodeHex: string;
  address: string;
  txid: string;
  vout: number;
  derivationScope: 'receive' | 'change';
  addressIndex: number;
}

export interface CovenantProof {
  contractName: string;
  covenantSemantics?:
    | 'USER_FUNDED_ESCROW_TICKET'
    | 'INACTIVITY_VAULT'
    | 'PULL_REWARD_CLAIM';
  redeemScriptHex: string;
  scriptHash32Hex: string;
  lockingBytecodeHex: string;
  constructorArgs: Record<string, string>;
  spendPathSelectorOpcode?: number;
  recoveryTestUnlockingBytecodeHex?: string;
}

export interface PreparedContractTransactionTemplate {
  contractType: PreparedContractType;
  network: BchNetwork;
  covenantAddress: string;
  covenantLockingBytecodeHex: string;
  covenantProof?: CovenantProof;
  genesisCategoryId?: string;
  transaction: {
    version: number;
    locktime: number;
    inputs: PreparedContractTransactionInput[];
    outputs: PreparedContractTransactionOutput[];
  };
  sourceOutputs: PreparedContractSourceOutput[];
}
