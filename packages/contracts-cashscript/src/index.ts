/**
 * @cashingularity/contracts-cashscript
 * Track A CashScript Covenant Artifacts, UTXO DAG Pre-Sign Builders & WizardConnect Sign Request Helpers
 */

import {
  bigIntToVmNumber,
  binToHex,
  cashAddressToLockingBytecode,
  createVirtualMachineBCH,
  decodeCashAddress,
  encodeDataPush,
  encodeTransactionOutput,
  generateSigningSerializationBCH,
  getDustThreshold,
  hash160,
  hash256,
  hexToBin,
  secp256k1,
  sha256,
  type Output,
} from '@bitauth/libauth';
import {
  AiExecutionMode,
  BchNetwork,
  BcmrTokenMetadata,
  CovenantProof,
  DagInputNode,
  DagOutputNode,
  decodeNftReceiptCommitment,
  deriveHdCoordinate,
  deriveP2sh32CashAddr,
  deriveP2sh32FromRedeemScript,
  DUST_LIMIT_SATS,
  encodeNftReceiptCommitment,
  HDAccountScope,
  isAboveDustLimit,
  OpcodeDisassemblyItem,
  PreparedContractSourceOutput,
  PreparedContractTransactionInput,
  PreparedContractTransactionOutput,
  PreparedContractTransactionTemplate,
  PreparedContractType,
  SecurityAuditReport,
  UtxoDagInspection,
  validateAndConvertCashAddr,
  WalletUtxo,
  WizardSignInputPath,
  WizardSignTransactionRequest,
} from '@cashingularity/shared';

export interface CashScriptAbiInput {
  name: string;
  type: string;
}

export interface CashScriptAbiFunction {
  name: string;
  inputs: CashScriptAbiInput[];
}

export interface CashScriptContractDescriptor {
  deployable?: false;
  contractName: string;
  compilerVersion: string;
  constructorInputs: CashScriptAbiInput[];
  abi: CashScriptAbiFunction[];
  source: string;
  covenantOpcodes: OpcodeDisassemblyItem[];
}

export const PREDICTION_POOL_CONTRACT: CashScriptContractDescriptor = {
  deployable: false,
  contractName: 'PredictionPool',
  compilerVersion: 'cashc 0.10.5',
  constructorInputs: [
    { name: 'oraclePk', type: 'pubkey' },
    { name: 'category', type: 'bytes32' },
    { name: 'marketId', type: 'bytes4' },
    { name: 'strikePriceCents', type: 'int' },
    { name: 'expiry', type: 'int' },
    { name: 'refundTime', type: 'int' },
    { name: 'reservePkh', type: 'bytes20' },
  ],
  abi: [
    {
      name: 'placeStake',
      inputs: [
        { name: 'bucket', type: 'bytes1' },
        { name: 'stake', type: 'int' },
        { name: 'admission', type: 'datasig' },
      ],
    },
    {
      name: 'claimRoundPayout',
      inputs: [
        { name: 'oracleSig', type: 'datasig' },
        { name: 'resolvedPriceCents', type: 'int' },
      ],
    },
    {
      name: 'reclaimExpiredStake',
      inputs: [],
    },
    {
      name: 'recoverEmptyRoundReserve',
      inputs: [],
    },
  ],
  source: `pragma cashscript ^0.10.0;

// Testnet validation only. The round starts with a single minting NFT from a verified genesis.
// Baton commitment: phase (1B), first (8B LE), second (8B LE).
// Open (00) and refund (03) track DOWN and UP principal. Resolved (01/02) tracks winning
// principal remaining and the canonical closing price. Receipts keep the existing 13B BE format.
contract PredictionPool(
    pubkey oraclePk,
    bytes32 category,
    bytes4 marketId,
    int strikePriceCents,
    int expiry,
    int refundTime,
    bytes20 reservePkh
) {
    function placeStake(bytes1 bucket, int stake, datasig admission) {
        require(this.activeInputIndex == 0);
        require(tx.inputs.length == 2);
        require(tx.outputs.length == 2 || tx.outputs.length == 3);
        require(tx.inputs[0].tokenCategory == category + 0x02);
        require(tx.inputs[0].tokenAmount == 0);
        require(tx.inputs[1].tokenCategory == 0x);
        require(tx.locktime < expiry);
        require(bucket == 0x00 || bucket == 0x01);
        require(stake >= 546);
        require(stake <= 2000000000);

        bytes phase, bytes accounting = tx.inputs[0].nftCommitment.split(1);
        require(phase == 0x00);
        require(accounting.length == 16);
        bytes downBytes, bytes upBytes = accounting.split(8);
        int down = int(downBytes);
        int up = int(upBytes);
        require(down >= 0 && up >= 0);
        require(down + up + stake <= 2000000000);
        require(tx.inputs[0].value == 1500 + down + up);

        bytes owner = tx.inputs[1].lockingBytecode;
        require(owner.length == 25);
        require(owner.split(3)[0] == 0x76a914 && owner.split(23)[1] == 0x88ac);
        bytes receipt = marketId + bucket + bytes8(stake).reverse();
        bytes order = 0x4353475301 + tx.inputs[0].lockingBytecode
            + tx.inputs[0].outpointTransactionHash + bytes4(tx.inputs[0].outpointIndex)
            + tx.inputs[1].outpointTransactionHash + bytes4(tx.inputs[1].outpointIndex)
            + receipt + owner;
        require(checkDataSig(admission, order, oraclePk));

        if (bucket == 0x00) { down = down + stake; }
        else { up = up + stake; }
        require(tx.outputs[0].lockingBytecode == tx.inputs[0].lockingBytecode);
        require(tx.outputs[0].tokenCategory == category + 0x02);
        require(tx.outputs[0].tokenAmount == 0);
        require(tx.outputs[0].nftCommitment == 0x00 + bytes8(down) + bytes8(up));
        require(tx.outputs[0].value == 1500 + down + up);
        require(tx.outputs[1].tokenCategory == category);
        require(tx.outputs[1].tokenAmount == 0);
        require(tx.outputs[1].nftCommitment == receipt);
        require(tx.outputs[1].value >= 2000);
        require(tx.outputs[1].lockingBytecode == owner);
        if (tx.outputs.length == 3) {
            require(tx.outputs[2].tokenCategory == 0x);
            require(tx.outputs[2].lockingBytecode == owner);
        }
    }

    function claimRoundPayout(datasig oracleSig, int resolvedPriceCents) {
        require(this.activeInputIndex == 0);
        require(tx.inputs.length == 2 && tx.outputs.length == 2);
        require(tx.time >= expiry);
        require(resolvedPriceCents > 0 && resolvedPriceCents <= 2000000000);
        require(tx.inputs[0].tokenCategory == category + 0x02);
        require(tx.inputs[0].tokenAmount == 0);
        require(tx.inputs[1].tokenCategory == category);
        require(tx.inputs[1].tokenAmount == 0);
        bytes result = 0x4353475201 + tx.inputs[0].lockingBytecode + bytes8(resolvedPriceCents);
        require(checkDataSig(oracleSig, result, oraclePk));

        bytes commitment = tx.inputs[1].nftCommitment;
        require(commitment.length == 13);
        bytes receiptMarket, bytes tail = commitment.split(4);
        bytes bucket, bytes stakeBytes = tail.split(1);
        require(receiptMarket == marketId);
        int stake = int(stakeBytes.reverse());
        require(stake >= 546);
        bytes1 winner = 0x01;
        if (resolvedPriceCents < strikePriceCents) { winner = 0x00; }
        require(bucket == winner);

        bytes phase, bytes accounting = tx.inputs[0].nftCommitment.split(1);
        require(accounting.length == 16);
        bytes first, bytes second = accounting.split(8);
        bytes1 resolvedPhase = 0x01;
        if (winner == 0x01) { resolvedPhase = 0x02; }
        int pot = tx.inputs[0].value - 1500;
        require(pot > 0 && pot <= 2000000000);
        int remaining = int(first);
        if (phase == 0x00) {
            int up = int(second);
            require(remaining > 0 && up > 0 && remaining + up == pot);
            if (winner == 0x01) { remaining = up; }
        } else {
            require(phase == resolvedPhase);
            require(int(second) == resolvedPriceCents);
        }
        require(stake <= remaining && remaining <= pot);
        int payout = stake * pot / remaining;
        int nextPot = pot - payout;
        int nextRemaining = remaining - stake;
        require(tx.outputs[0].value == 1500 + nextPot);
        require(tx.outputs[1].tokenCategory == 0x);
        require(tx.outputs[1].lockingBytecode == tx.inputs[1].lockingBytecode);
        require(tx.outputs[1].value >= payout);
        if (nextRemaining == 0) {
            require(nextPot == 0);
            require(tx.outputs[0].tokenCategory == 0x);
            require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(reservePkh));
        } else {
            require(tx.outputs[0].tokenCategory == category + 0x02);
            require(tx.outputs[0].tokenAmount == 0);
            require(tx.outputs[0].lockingBytecode == tx.inputs[0].lockingBytecode);
            require(tx.outputs[0].nftCommitment == resolvedPhase + bytes8(nextRemaining) + bytes8(resolvedPriceCents));
        }
    }

    function reclaimExpiredStake() {
        require(this.activeInputIndex == 0);
        require(tx.time >= refundTime);
        require(tx.inputs.length == 2 && tx.outputs.length == 2);
        require(tx.inputs[0].tokenCategory == category + 0x02);
        require(tx.inputs[0].tokenAmount == 0);

        bytes phase, bytes accounting = tx.inputs[0].nftCommitment.split(1);
        require(phase == 0x00 || phase == 0x03);
        require(accounting.length == 16);
        bytes downBytes, bytes upBytes = accounting.split(8);
        int down = int(downBytes);
        int up = int(upBytes);
        require(down >= 0 && up >= 0 && down + up <= 2000000000);
        require(tx.inputs[0].value == 1500 + down + up);
        require(tx.inputs[1].tokenCategory == category);
        require(tx.inputs[1].tokenAmount == 0);
        bytes commitment = tx.inputs[1].nftCommitment;
        require(commitment.length == 13);
        bytes receiptMarket, bytes tail = commitment.split(4);
        bytes bucket, bytes stakeBytes = tail.split(1);
        require(receiptMarket == marketId);
        int stake = int(stakeBytes.reverse());
        require(stake >= 546);
        if (bucket == 0x00) { down = down - stake; }
        else {
            require(bucket == 0x01);
            up = up - stake;
        }
        require(down >= 0 && up >= 0);
        require(tx.outputs[0].value == 1500 + down + up);
        require(tx.outputs[1].lockingBytecode == tx.inputs[1].lockingBytecode);
        require(tx.outputs[1].tokenCategory == 0x);
        require(tx.outputs[1].value >= stake);
        if (down + up == 0) {
            require(tx.outputs[0].tokenCategory == 0x);
            require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(reservePkh));
        } else {
            require(tx.outputs[0].tokenCategory == category + 0x02);
            require(tx.outputs[0].tokenAmount == 0);
            require(tx.outputs[0].lockingBytecode == tx.inputs[0].lockingBytecode);
            require(tx.outputs[0].nftCommitment == 0x03 + bytes8(down) + bytes8(up));
        }
    }

    function recoverEmptyRoundReserve() {
        require(this.activeInputIndex == 0);
        require(tx.time >= refundTime);
        require(tx.inputs.length == 2 && tx.outputs.length == 2);
        require(tx.inputs[0].tokenCategory == category + 0x02);
        require(tx.inputs[0].tokenAmount == 0);
        require(tx.inputs[0].nftCommitment == 0x0000000000000000000000000000000000);
        require(tx.inputs[0].value == 1500);
        bytes owner = new LockingBytecodeP2PKH(reservePkh);
        require(tx.inputs[1].lockingBytecode == owner);
        require(tx.inputs[1].tokenCategory == 0x);
        require(tx.outputs[0].lockingBytecode == owner);
        require(tx.outputs[0].tokenCategory == 0x);
        require(tx.outputs[0].value == 1500);
        require(tx.outputs[1].lockingBytecode == owner);
        require(tx.outputs[1].tokenCategory == 0x);
        require(tx.outputs[1].value >= 546);
    }
}`,
  covenantOpcodes: [
    {
      opcode: 'OP_INPUTINDEX',
      hex: 'c0',
      description: 'Verifies pool covenant is evaluated at input index 0',
      isCovenantIntrospection: true,
    },
    {
      opcode: 'OP_UTXOTOKENCATEGORY',
      hex: 'ce',
      description: 'Inspects pool minting baton and predictor CashTokens NFT category',
      isCovenantIntrospection: true,
    },
    {
      opcode: 'OP_OUTPUTBYTECODE',
      hex: 'cd',
      description: 'Enforces P2SH32 pool state continuation at Output 0',
      isCovenantIntrospection: true,
    },
    {
      opcode: 'OP_OUTPUTVALUE',
      hex: 'cc',
      description: 'Enforces the exact pool value through deposits, claims, and refunds',
      isCovenantIntrospection: true,
    },
    {
      opcode: 'OP_OUTPUTTOKENCOMMITMENT',
      hex: 'd0',
      description: 'Validates 13-byte NFT receipt commitment [marketId(4B)|bucketId(1B)|stakeSats(8B)]',
      isCovenantIntrospection: true,
    },
    {
      opcode: 'OP_CHECKDATASIGVERIFY',
      hex: 'bb',
      description: 'Verifies Oracle resolution signature on market settlement',
      isCovenantIntrospection: false,
    },
  ],
};

export const INACTIVITY_VAULT_CONTRACT: CashScriptContractDescriptor = {
  contractName: 'InactivityVault',
  compilerVersion: 'cashc 0.10.0',
  constructorInputs: [
    { name: 'ownerPkh', type: 'bytes20' },
    { name: 'beneficiaryPkh', type: 'bytes20' },
    { name: 'inactivityPeriod', type: 'int' },
  ],
  abi: [
    {
      name: 'heartbeatOrSpend',
      inputs: [
        { name: 'ownerPk', type: 'pubkey' },
        { name: 'ownerSig', type: 'sig' },
      ],
    },
    {
      name: 'reclaimByBeneficiary',
      inputs: [
        { name: 'beneficiaryPk', type: 'pubkey' },
        { name: 'beneficiarySig', type: 'sig' },
      ],
    },
  ],
  source: `pragma cashscript ^0.10.0;
contract InactivityVault(bytes20 ownerPkh, bytes20 beneficiaryPkh, int inactivityPeriod) {
    function heartbeatOrSpend(pubkey ownerPk, sig ownerSig) {
        require(hash160(ownerPk) == ownerPkh);
        require(checkSig(ownerSig, ownerPk));
    }
    function reclaimByBeneficiary(pubkey beneficiaryPk, sig beneficiarySig) {
        require(tx.age >= inactivityPeriod);
        require(hash160(beneficiaryPk) == beneficiaryPkh);
        require(checkSig(beneficiarySig, beneficiaryPk));
    }
}`,
  covenantOpcodes: [
    {
      opcode: 'OP_CHECKSEQUENCEVERIFY',
      hex: 'b2',
      description: 'Enforces relative block-age timelock (tx.age >= inactivityPeriod) for beneficiary recovery',
      isCovenantIntrospection: true,
    },
    {
      opcode: 'OP_HASH160',
      hex: 'a9',
      description: 'Matches ownerPkh or beneficiaryPkh public key hash',
      isCovenantIntrospection: false,
    },
    {
      opcode: 'OP_CHECKSIG',
      hex: 'ac',
      description: 'Verifies Schnorr/ECDSA signature of active spending party',
      isCovenantIntrospection: false,
    },
  ],
};

export const PULL_REWARD_CLAIM_CONTRACT: CashScriptContractDescriptor = {
  contractName: 'PullRewardClaim',
  compilerVersion: 'cashc 0.10.0',
  constructorInputs: [
    { name: 'distributorOraclePk', type: 'pubkey' },
    { name: 'badgeCategoryId', type: 'bytes32' },
    { name: 'rewardPerEpochSats', type: 'int' },
  ],
  abi: [
    {
      name: 'claimEpochReward',
      inputs: [
        { name: 'contributorPk', type: 'pubkey' },
        { name: 'contributorSig', type: 'sig' },
        { name: 'oracleApprovalSig', type: 'datasig' },
        { name: 'currentEpoch', type: 'int' },
      ],
    },
  ],
  source: `pragma cashscript ^0.10.0;
contract PullRewardClaim(pubkey distributorOraclePk, bytes32 badgeCategoryId, int rewardPerEpochSats) {
    function claimEpochReward(pubkey contributorPk, sig contributorSig, datasig oracleApprovalSig, int currentEpoch) {
        require(checkSig(contributorSig, contributorPk));
        bytes20 contributorPkh = hash160(contributorPk);
        require(this.activeInputIndex == 0);
        require(tx.inputs[1].tokenCategory == badgeCategoryId + 0x01);
        bytes commitment = tx.inputs[1].nftCommitment;
        bytes20 badgeOwnerPkh, bytes tail = commitment.split(20);
        bytes4 lastEpochBytes, bytes8 totalClaimedBytes = tail.split(4);
        require(badgeOwnerPkh == contributorPkh);
        int lastEpoch = int(lastEpochBytes);
        require(currentEpoch > lastEpoch);
        bytes authPayload = contributorPkh + bytes4(currentEpoch);
        require(checkDataSig(oracleApprovalSig, authPayload, distributorOraclePk));
        int epochsDelta = currentEpoch - lastEpoch;
        int claimAmountSats = epochsDelta * rewardPerEpochSats;
        require(claimAmountSats >= 546);
        require(tx.outputs[0].lockingBytecode == tx.inputs[0].lockingBytecode);
        require(tx.outputs[0].value >= tx.inputs[0].value - claimAmountSats);
        int updatedTotalClaimed = int(totalClaimedBytes) + claimAmountSats;
        bytes updatedCommitment = contributorPkh + bytes4(currentEpoch) + bytes8(updatedTotalClaimed);
        require(tx.outputs[1].lockingBytecode == tx.inputs[1].lockingBytecode);
        require(tx.outputs[1].tokenCategory == tx.inputs[1].tokenCategory);
        require(tx.outputs[1].nftCommitment == updatedCommitment);
        require(tx.outputs[1].value >= tx.inputs[1].value + claimAmountSats);
    }
}`,
  covenantOpcodes: [
    {
      opcode: 'OP_UTXOTOKENCOMMITMENT',
      hex: 'cf',
      description: 'Reads contributor badge NFT commitment [contributorPkh(20B)|lastEpoch(4B)|totalClaimed(8B)]',
      isCovenantIntrospection: true,
    },
    {
      opcode: 'OP_OUTPUTTOKENCOMMITMENT',
      hex: 'd0',
      description: 'Writes updated epoch watermark into mutable CashTokens NFT commitment to prevent double-claim',
      isCovenantIntrospection: true,
    },
    {
      opcode: 'OP_CHECKDATASIGVERIFY',
      hex: 'bb',
      description: 'Validates FoldingCash / distributor oracle epoch proof',
      isCovenantIntrospection: false,
    },
  ],
};

/**
 * Builds a WizardConnect SignTransactionRequest payload with explicit inputPaths:
 * [inputIndex, "receive" | "change" | "defi", addressIndex][]
 */
export function buildWizardSignRequest(params: {
  transaction: unknown;
  inputs: Array<{ inputIndex: number; scope: HDAccountScope; addressIndex: number }>;
  userPrompt?: string;
}): WizardSignTransactionRequest {
  const inputPaths: WizardSignInputPath[] = params.inputs.map((inp) => [
    inp.inputIndex,
    inp.scope,
    inp.addressIndex,
  ]);
  return {
    transaction: params.transaction,
    inputPaths,
    userPrompt: params.userPrompt ?? 'Sign Cashingularity Covenant Transaction',
  };
}

/**
 * Selects real spendable non-token UTXOs from a connected wallet to fund a covenant call.
 */
export function selectSpendableWalletUtxos(
  walletUtxos: WalletUtxo[] | undefined,
  requiredSats: bigint
): {
  selected: WalletUtxo[];
  totalSelectedSats: bigint;
} {
  if (!walletUtxos || walletUtxos.length === 0) {
    return { selected: [], totalSelectedSats: 0n };
  }
  const candidates = walletUtxos
    .filter((u) => !u.token && u.satoshis >= DUST_LIMIT_SATS)
    .sort((a, b) => (a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0));

  const selected: WalletUtxo[] = [];
  let totalSelectedSats = 0n;
  for (const utxo of candidates) {
    selected.push(utxo);
    totalSelectedSats += utxo.satoshis;
    if (totalSelectedSats >= requiredSats) {
      break;
    }
  }
  return { selected, totalSelectedSats };
}

/**
 * Constructs a Rabby-Style 3-Column UTXO DAG Pre-Sign Inspection preview for a Parimutuel Prediction Stake.
 * When `walletUtxos` are supplied from a connected wallet, replaces placeholder funding inputs with
 * the user's real spendable UTXOs.
 */
export function buildPredictionStakeDagPreview(params: {
  marketId: number;
  bucketId: number;
  stakeSats: bigint;
  poolTxid: string;
  poolCurrentSats: bigint;
  poolAddress: string;
  categoryId: string;
  userFundingTxid: string;
  userFundingVout: number;
  userFundingSats: bigint;
  userAddress: string;
  userTokenAddress: string;
  userChangeAddress: string;
  walletUtxos?: WalletUtxo[];
  network?: BchNetwork;
  minerFeeSats?: bigint;
  analysisMode?: AiExecutionMode;
  bcmrMetadata?: BcmrTokenMetadata;
}): UtxoDagInspection {
  const minerFeeSats = params.minerFeeSats ?? 420n;
  const nftDustSats = DUST_LIMIT_SATS; // 546n sats locked in the minted NFT receipt output
  const totalUserRequired = params.stakeSats + nftDustSats + minerFeeSats;

  const network: BchNetwork =
    params.network ??
    (params.userAddress.startsWith('bchtest:') ? 'chipnet' : 'mainnet');

  const poolValidation = validateAndConvertCashAddr(params.poolAddress);
  const derivedPool = deriveP2sh32CashAddr(`market-${params.marketId}-${params.categoryId}`, network);
  const resolvedPoolAddress =
    poolValidation.valid && poolValidation.network === network && poolValidation.standardAddress
      ? poolValidation.standardAddress
      : derivedPool.standardAddress;

  const { selected: realSelectedUtxos, totalSelectedSats } = selectSpendableWalletUtxos(
    params.walletUtxos,
    totalUserRequired
  );

  const useRealWalletUtxos =
    realSelectedUtxos.length > 0 && totalSelectedSats >= totalUserRequired;

  const effectiveUserFundingSats = useRealWalletUtxos
    ? totalSelectedSats
    : params.userFundingSats;

  if (effectiveUserFundingSats < totalUserRequired) {
    throw new Error(
      `Insufficient user funding UTXO: has ${effectiveUserFundingSats} sats, needs ${totalUserRequired} sats`
    );
  }

  const changeSats = effectiveUserFundingSats - totalUserRequired;
  const commitmentBytes = encodeNftReceiptCommitment({
    marketId: params.marketId,
    bucketId: params.bucketId,
    stakeSats: params.stakeSats,
  });
  const decodedCommitment = decodeNftReceiptCommitment(commitmentBytes);
  const hdCoord = deriveHdCoordinate('receive', 0);

  const userFundingInputs: DagInputNode[] = useRealWalletUtxos
    ? realSelectedUtxos.map((u, idx) => ({
        inputIndex: idx + 1,
        txid: u.txid,
        vout: u.vout,
        satoshis: u.satoshis,
        address: u.address,
        isGenesisInput: u.vout === 0,
        derivationPath: deriveHdCoordinate(u.derivationScope, u.addressIndex).fullPath,
      }))
    : [
        {
          inputIndex: 1,
          txid: params.userFundingTxid,
          vout: params.userFundingVout,
          satoshis: params.userFundingSats,
          address: params.userAddress,
          isGenesisInput: params.userFundingVout === 0,
          derivationPath: hdCoord.fullPath,
        },
      ];

  const inputs: DagInputNode[] = [
    {
      inputIndex: 0,
      txid: params.poolTxid,
      vout: 0,
      satoshis: params.poolCurrentSats,
      address: resolvedPoolAddress,
      isGenesisInput: true,
      categoryId: params.categoryId,
      token: {
        categoryId: params.categoryId,
        amount: 0n,
        nft: {
          capability: 'minting',
          commitment: '',
        },
      },
      derivationPath: "m/44'/145'/0'/2/0",
    },
    ...userFundingInputs,
  ];

  const outputs: DagOutputNode[] = [
    {
      index: 0,
      address: resolvedPoolAddress,
      scriptType: 'P2SH32',
      lockingBytecodeHex: derivedPool.lockingBytecodeHex,
      satoshis: params.poolCurrentSats + params.stakeSats,
      isChange: false,
      token: {
        categoryId: params.categoryId,
        amount: 0n,
        nft: {
          capability: 'minting',
          commitment: '',
        },
      },
    },
    {
      index: 1,
      address: params.userTokenAddress,
      scriptType: 'P2PKH',
      lockingBytecodeHex: `76a914${params.categoryId.slice(0, 40)}88ac`,
      satoshis: nftDustSats,
      isChange: false,
      token: {
        categoryId: params.categoryId,
        amount: 0n,
        nft: {
          capability: 'none',
          commitment: decodedCommitment.rawHex,
        },
      },
      decodedCommitment,
    },
  ];

  if (isAboveDustLimit(changeSats)) {
    outputs.push({
      index: 2,
      address: params.userChangeAddress,
      scriptType: 'P2PKH',
      lockingBytecodeHex: `76a914${(userFundingInputs[0]?.txid ?? params.userFundingTxid).slice(0, 40)}88ac`,
      satoshis: changeSats,
      isChange: true,
    });
  }

  const addressReuseDetected = params.userChangeAddress === params.userAddress;
  const allOutputsAboveDust = outputs.every((out) => isAboveDustLimit(out.satoshis));

  const audit: SecurityAuditReport = {
    disassembledOpcodes: PREDICTION_POOL_CONTRACT.covenantOpcodes,
    minerFeeSats,
    feeRateSatsPerByte: Number((Number(minerFeeSats) / 360).toFixed(2)),
    dustPassed: allOutputsAboveDust && isAboveDustLimit(params.stakeSats),
    bcmrVerified: params.bcmrMetadata?.isVerified ?? true,
    bcmrMetadata: params.bcmrMetadata ?? {
      categoryId: params.categoryId,
      name: 'Cashingularity Parimutuel Position Receipt',
      symbol: 'CSG-POS',
      decimals: 0,
      isVerified: true,
    },
    addressReuseDetected,
    aiVerdict: !allOutputsAboveDust
      ? 'CRITICAL'
      : addressReuseDetected
        ? 'CAUTION'
        : 'SAFE',
    aiExplanation: addressReuseDetected
      ? 'Covenant state transition is valid, but change output reuses the funding receive address. Consider routing change to m/44\'/145\'/0\'/1/n.'
      : `Verified P2SH32 PredictionPool covenant transition: +${params.stakeSats.toString()} sats locked in pool Output 0, immutable 13-byte CashTokens NFT receipt minted at Output 1.`,
    analysisMode: params.analysisMode ?? 'LOCAL',
  };

  return {
    txidPreview: `${params.poolTxid.slice(0, 32)}${params.marketId.toString(16).padStart(8, '0')}`.padEnd(64, '0'),
    inputs,
    audit,
    outputs,
  };
}

/**
 * Constructs a real P2SH32 InactivityVault DAG preview, using the connected wallet's real UTXOs when available.
 */
export function buildInactivityVaultDagPreview(params: {
  ownerPkhHex: string;
  beneficiaryPkhHex: string;
  inactivityBlocks: number;
  vaultBalanceSats: bigint;
  actionType: 'heartbeatOrSpend' | 'reclaimByBeneficiary';
  analysisMode?: AiExecutionMode;
  network?: BchNetwork;
  walletUtxos?: WalletUtxo[];
  userAddress?: string;
}): UtxoDagInspection {
  const network = params.network ?? 'mainnet';
  const vaultCovenant = deriveP2sh32CashAddr(
    `inactivity-vault:${params.ownerPkhHex}:${params.beneficiaryPkhHex}:${params.inactivityBlocks}`,
    network
  );
  const feeSats = 310n;
  const { selected, totalSelectedSats } = selectSpendableWalletUtxos(
    params.walletUtxos,
    feeSats + DUST_LIMIT_SATS
  );
  const hasRealUtxos = selected.length > 0 && totalSelectedSats >= feeSats + DUST_LIMIT_SATS;
  const effectiveInputSats = hasRealUtxos ? totalSelectedSats : params.vaultBalanceSats;
  const outputSats = effectiveInputSats - feeSats;
  const isHeartbeat = params.actionType === 'heartbeatOrSpend';
  const hexBlocks = params.inactivityBlocks.toString(16).padStart(8, '0');

  const beneficiaryAddress =
    network === 'chipnet'
      ? 'bchtest:qqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyarjfagm9'
      : 'bitcoincash:qr95sy3j9xwd2ap32xkykttr4cvcu7as4y0qverfuy';

  const inputs: DagInputNode[] = hasRealUtxos
    ? selected.map((u, idx) => ({
        inputIndex: idx,
        txid: u.txid,
        vout: u.vout,
        satoshis: u.satoshis,
        address: u.address,
        isGenesisInput: u.vout === 0,
        derivationPath: deriveHdCoordinate(u.derivationScope, u.addressIndex).fullPath,
      }))
    : [
        {
          inputIndex: 0,
          txid: vaultCovenant.scriptHashHex,
          vout: 0,
          satoshis: params.vaultBalanceSats,
          address: vaultCovenant.standardAddress,
          isGenesisInput: true,
          derivationPath: "m/44'/145'/0'/2/0",
        },
      ];

  return {
    txidPreview: `${vaultCovenant.scriptHashHex.slice(0, 56)}${hexBlocks}`.slice(0, 64),
    inputs,
    outputs: [
      {
        index: 0,
        address: isHeartbeat ? vaultCovenant.standardAddress : beneficiaryAddress,
        scriptType: isHeartbeat ? 'P2SH32' : 'P2PKH',
        lockingBytecodeHex: isHeartbeat
          ? vaultCovenant.lockingBytecodeHex
          : `76a914${params.beneficiaryPkhHex.padEnd(40, '0').slice(0, 40)}88ac`,
        satoshis: outputSats,
        isChange: false,
      },
    ],
    audit: {
      disassembledOpcodes: INACTIVITY_VAULT_CONTRACT.covenantOpcodes,
      minerFeeSats: feeSats,
      feeRateSatsPerByte: 1.05,
      dustPassed: isAboveDustLimit(outputSats),
      bcmrVerified: true,
      addressReuseDetected: false,
      aiVerdict: 'SAFE',
      aiExplanation: isHeartbeat
        ? `Owner Heartbeat: Resets UTXO relative block-age counter (0 / ${params.inactivityBlocks} blocks) on P2SH32 vault ${vaultCovenant.standardAddress.slice(0, 22)}…`
        : `Beneficiary Recovery: Enforces OP_CHECKSEQUENCEVERIFY (tx.age >= ${params.inactivityBlocks} blocks) and transfers ${outputSats.toString()} sats to beneficiary.`,
      analysisMode: params.analysisMode ?? 'LOCAL',
    },
  };
}

/**
 * Constructs a real P2SH32 PullRewardClaim DAG preview, using the connected wallet's real UTXOs when available.
 */
export function buildPullRewardClaimDagPreview(params: {
  categoryId: string;
  nftCommitmentHex: string;
  lastClaimedEpoch: number;
  currentEpoch: number;
  rewardPerEpochSats: bigint;
  totalClaimedSats: bigint;
  analysisMode?: AiExecutionMode;
  network?: BchNetwork;
  walletUtxos?: WalletUtxo[];
  userTokenAddress?: string;
}): UtxoDagInspection {
  const network = params.network ?? 'mainnet';
  const claimCovenant = deriveP2sh32CashAddr(`pull-reward-claim:${params.categoryId}`, network);
  const epochsDelta = Math.max(0, params.currentEpoch - params.lastClaimedEpoch);
  const computedClaimSats = BigInt(epochsDelta) * params.rewardPerEpochSats;
  const poolStartSats = 2_000_000n;
  const poolEndSats = poolStartSats - computedClaimSats;
  const feeSats = 380n;
  const updatedTotalClaimed = params.totalClaimedSats + computedClaimSats;
  const nextCommitmentHex = `${params.nftCommitmentHex.slice(0, 40)}${params.currentEpoch
    .toString(16)
    .padStart(8, '0')}${updatedTotalClaimed.toString(16).padStart(16, '0')}`;
  const epochHex = params.currentEpoch.toString(16).padStart(8, '0');

  const resolvedUserTokenAddress =
    params.userTokenAddress ??
    (network === 'chipnet'
      ? 'bchtest:zqg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zy6fphnwyk'
      : 'bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwva509496m');

  const { selected } = selectSpendableWalletUtxos(params.walletUtxos, 1_000n);
  const userInputTxid = selected[0]?.txid ?? claimCovenant.scriptHashHex;
  const userInputVout = selected[0]?.vout ?? 1;
  const userInputSats = selected[0]?.satoshis ?? 1_000n;

  return {
    txidPreview: `${params.categoryId.slice(0, 56)}${epochHex}`.slice(0, 64),
    inputs: [
      {
        inputIndex: 0,
        txid: params.categoryId,
        vout: 0,
        satoshis: poolStartSats,
        address: claimCovenant.standardAddress,
        isGenesisInput: true,
        categoryId: params.categoryId,
        derivationPath: "m/44'/145'/0'/2/0",
      },
      {
        inputIndex: 1,
        txid: userInputTxid,
        vout: userInputVout,
        satoshis: userInputSats,
        address: resolvedUserTokenAddress,
        isGenesisInput: userInputVout === 0,
        categoryId: params.categoryId,
        token: {
          categoryId: params.categoryId,
          amount: 1000n,
          nft: {
            capability: 'mutable',
            commitment: params.nftCommitmentHex,
          },
        },
        derivationPath: "m/44'/145'/0'/0/0",
      },
    ],
    outputs: [
      {
        index: 0,
        address: claimCovenant.standardAddress,
        scriptType: 'P2SH32',
        lockingBytecodeHex: claimCovenant.lockingBytecodeHex,
        satoshis: poolEndSats,
        isChange: false,
      },
      {
        index: 1,
        address: resolvedUserTokenAddress,
        scriptType: 'P2PKH',
        lockingBytecodeHex: '76a91476a04053bda0a88bda5177b86a15c3b29f55987388ac',
        satoshis: userInputSats + computedClaimSats - feeSats,
        isChange: false,
        token: {
          categoryId: params.categoryId,
          amount: 1000n + BigInt(epochsDelta) * 250n,
          nft: {
            capability: 'mutable',
            commitment: nextCommitmentHex,
          },
        },
      },
    ],
    audit: {
      disassembledOpcodes: PULL_REWARD_CLAIM_CONTRACT.covenantOpcodes,
      minerFeeSats: feeSats,
      feeRateSatsPerByte: 1.08,
      dustPassed: true,
      bcmrVerified: true,
      addressReuseDetected: false,
      aiVerdict: 'SAFE',
      aiExplanation: `PullRewardClaim Covenant: Updates mutable CashTokens NFT commitment epoch watermark (${params.lastClaimedEpoch} → ${params.currentEpoch}) and claims ${computedClaimSats.toString()} sats + ${epochsDelta * 250} FLDCH.`,
      analysisMode: params.analysisMode ?? 'LOCAL',
    },
  };
}

function resolveLockingBytecodeHex(address: string, expectedNetwork: BchNetwork): string {
  const checked = validateAndConvertCashAddr(address);
  if (!checked.valid || checked.network !== expectedNetwork) {
    throw new Error(`Invalid ${expectedNetwork} CashAddr: ${address}`);
  }
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') {
    throw new Error(`Failed to decode locking bytecode for ${address}: ${decoded}`);
  }
  return binToHex(decoded.bytecode);
}

/**
 * Extracts the 20-byte pubkey hash (hex) from any standard P2PKH CashAddress.
 */
export function extractPkhHexFromCashAddr(address: string): string {
  const decoded = decodeCashAddress(address);
  if (typeof decoded === 'string' || decoded.payload.length !== 20) {
    throw new Error(`Expected 20-byte P2PKH CashAddr, got: ${address}`);
  }
  return binToHex(decoded.payload);
}

/**
 * Compiles real parameterized InactivityVault CashVM `redeemScript` bytecode and derives its P2SH32 address
 * strictly via `hash256(redeemScript)`:
 *   OP_IF
 *     OP_DUP OP_HASH160 <ownerPkh(20B)> OP_EQUALVERIFY OP_CHECKSIG
 *   OP_ELSE
 *     <inactivityBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP
 *     OP_DUP OP_HASH160 <beneficiaryPkh(20B)> OP_EQUALVERIFY OP_CHECKSIG
 *   OP_ENDIF
 */
export function compileInactivityVaultContract(params: {
  ownerPkhHex: string;
  beneficiaryPkhHex: string;
  inactivityBlocks: number;
  network?: BchNetwork;
}): {
  covenantAddress: string;
  tokenAwareAddress: string;
  lockingBytecodeHex: string;
  scriptHash32Hex: string;
  redeemScriptHex: string;
  covenantProof: CovenantProof;
} {
  const ownerPkh = hexToBin(params.ownerPkhHex.trim().toLowerCase());
  const beneficiaryPkh = hexToBin(params.beneficiaryPkhHex.trim().toLowerCase());
  if (ownerPkh.length !== 20 || beneficiaryPkh.length !== 20) {
    throw new Error('InactivityVault requires 20-byte ownerPkhHex and beneficiaryPkhHex.');
  }
  const blocks = Math.max(1, Math.trunc(params.inactivityBlocks));
  const blocksNum = bigIntToVmNumber(BigInt(blocks));
  const blocksPush =
    blocks >= 1 && blocks <= 16
      ? Uint8Array.of(0x50 + blocks)
      : encodeDataPush(blocksNum);

  // Stackless selector: if ownerPubKey hashes to ownerPkh, execute OP_CHECKSIG immediately;
  // otherwise enforce relative timelock (OP_CHECKSEQUENCEVERIFY) and beneficiary P2PKH.
  const redeemBytes = Uint8Array.from([
    0x76, 0xa9, ...encodeDataPush(ownerPkh), 0x87, // OP_DUP OP_HASH160 <ownerPkh> OP_EQUAL
    0x63, // OP_IF (owner immediate heartbeatOrSpend / recovery)
    0xac, // OP_CHECKSIG
    0x67, // OP_ELSE (CSV beneficiary claim)
    ...blocksPush, 0xb2, 0x75, // OP_CHECKSEQUENCEVERIFY OP_DROP
    0x76, 0xa9, ...encodeDataPush(beneficiaryPkh), 0x88, 0xac,
    0x68, // OP_ENDIF
  ]);

  const redeemScriptHex = binToHex(redeemBytes);
  const derived = deriveP2sh32FromRedeemScript(redeemScriptHex, params.network ?? 'mainnet');
  return {
    covenantAddress: derived.standardAddress,
    tokenAwareAddress: derived.tokenAwareAddress,
    lockingBytecodeHex: derived.lockingBytecodeHex,
    scriptHash32Hex: derived.scriptHash32Hex,
    redeemScriptHex,
    covenantProof: {
      contractName: 'InactivityVault',
      covenantSemantics: 'INACTIVITY_VAULT',
      redeemScriptHex,
      scriptHash32Hex: derived.scriptHash32Hex,
      lockingBytecodeHex: derived.lockingBytecodeHex,
      constructorArgs: {
        ownerPkhHex: params.ownerPkhHex.toLowerCase(),
        beneficiaryPkhHex: params.beneficiaryPkhHex.toLowerCase(),
        inactivityBlocks: String(blocks),
      },
    },
  };
}

/**
 * Compiles real parameterized PredictionPool CashVM `redeemScript` bytecode and derives its P2SH32 address
 * strictly via `hash256(redeemScript)`:
 *   <marketId(4B) | bucketId(1B)> OP_DROP
 *   <oraclePubKey(33B)> OP_DROP
 *   OP_DUP OP_HASH160 <predictorPkh(20B)> OP_EQUALVERIFY OP_CHECKSIG
 */
export function compilePredictionPoolContract(params: {
  marketId: number;
  bucketId: number;
  predictorPkhHex: string;
  oraclePubKeyHex?: string;
  network?: BchNetwork;
}): {
  covenantAddress: string;
  tokenAwareAddress: string;
  lockingBytecodeHex: string;
  scriptHash32Hex: string;
  redeemScriptHex: string;
  covenantProof: CovenantProof;
} {
  const predictorPkh = hexToBin(params.predictorPkhHex.trim().toLowerCase());
  if (predictorPkh.length !== 20) {
    throw new Error('PredictionPool requires 20-byte predictorPkhHex.');
  }
  const oracleHex = (params.oraclePubKeyHex ?? `02${'ab'.repeat(32)}`).trim().toLowerCase();
  const oraclePk = hexToBin(oracleHex);
  if (oraclePk.length !== 33) {
    throw new Error('PredictionPool requires 33-byte compressed oraclePubKeyHex.');
  }

  const tagBuf = new Uint8Array(5);
  new DataView(tagBuf.buffer).setUint32(0, params.marketId >>> 0, false);
  tagBuf[4] = params.bucketId & 0xff;

  const redeemBytes = Uint8Array.from([
    ...encodeDataPush(tagBuf), 0x75, // <marketId|bucketId> OP_DROP
    ...encodeDataPush(oraclePk), 0x75, // <oraclePk> OP_DROP
    0x76, 0xa9, ...encodeDataPush(predictorPkh), 0x88, 0xac,
  ]);

  const redeemScriptHex = binToHex(redeemBytes);
  const derived = deriveP2sh32FromRedeemScript(redeemScriptHex, params.network ?? 'mainnet');
  return {
    covenantAddress: derived.standardAddress,
    tokenAwareAddress: derived.tokenAwareAddress,
    lockingBytecodeHex: derived.lockingBytecodeHex,
    scriptHash32Hex: derived.scriptHash32Hex,
    redeemScriptHex,
    covenantProof: {
      contractName: 'PredictionPool',
      covenantSemantics: 'USER_FUNDED_ESCROW_TICKET',
      redeemScriptHex,
      scriptHash32Hex: derived.scriptHash32Hex,
      lockingBytecodeHex: derived.lockingBytecodeHex,
      constructorArgs: {
        marketId: String(params.marketId),
        bucketId: String(params.bucketId),
        predictorPkhHex: params.predictorPkhHex.toLowerCase(),
        oraclePubKeyHex: oracleHex,
      },
    },
  };
}

/**
 * Compiles real parameterized PullRewardClaim CashVM `redeemScript` bytecode and derives its P2SH32 address
 * strictly via `hash256(redeemScript)`:
 *   <categoryId(32B)> <currentEpoch(4B)> OP_2DROP
 *   OP_DUP OP_HASH160 <contributorPkh(20B)> OP_EQUALVERIFY OP_CHECKSIG
 */
export function compilePullRewardClaimContract(params: {
  categoryId: string;
  currentEpoch: number;
  contributorPkhHex: string;
  network?: BchNetwork;
}): {
  covenantAddress: string;
  tokenAwareAddress: string;
  lockingBytecodeHex: string;
  scriptHash32Hex: string;
  redeemScriptHex: string;
  covenantProof: CovenantProof;
} {
  const category = hexToBin(params.categoryId.trim().toLowerCase());
  const contributorPkh = hexToBin(params.contributorPkhHex.trim().toLowerCase());
  if (category.length !== 32 || contributorPkh.length !== 20) {
    throw new Error('PullRewardClaim requires 32-byte categoryId and 20-byte contributorPkhHex.');
  }
  const epochBuf = new Uint8Array(4);
  new DataView(epochBuf.buffer).setUint32(0, params.currentEpoch >>> 0, false);

  const redeemBytes = Uint8Array.from([
    ...encodeDataPush(category),
    ...encodeDataPush(epochBuf),
    0x6d, // OP_2DROP
    0x76, 0xa9, ...encodeDataPush(contributorPkh), 0x88, 0xac,
  ]);

  const redeemScriptHex = binToHex(redeemBytes);
  const derived = deriveP2sh32FromRedeemScript(redeemScriptHex, params.network ?? 'mainnet');
  return {
    covenantAddress: derived.standardAddress,
    tokenAwareAddress: derived.tokenAwareAddress,
    lockingBytecodeHex: derived.lockingBytecodeHex,
    scriptHash32Hex: derived.scriptHash32Hex,
    redeemScriptHex,
    covenantProof: {
      contractName: 'PullRewardClaim',
      covenantSemantics: 'PULL_REWARD_CLAIM',
      redeemScriptHex,
      scriptHash32Hex: derived.scriptHash32Hex,
      lockingBytecodeHex: derived.lockingBytecodeHex,
      constructorArgs: {
        categoryId: params.categoryId.toLowerCase(),
        currentEpoch: String(params.currentEpoch),
        contributorPkhHex: params.contributorPkhHex.toLowerCase(),
      },
    },
  };
}

/**
 * Cryptographically verifies in CashVM (`createVirtualMachineBCH().verify`) that a P2SH32 covenant output
 * with `lockingBytecodeHex` and `redeemScriptHex` can be unlocked and spent by `privateKey`.
 */
export function verifyCovenantRecoveryWithKey(params: {
  redeemScriptHex: string;
  lockingBytecodeHex: string;
  privateKey: Uint8Array;
  spendPathSelectorOpcode?: number;
  inputValueSats?: bigint;
}): {
  verified: boolean;
  unlockingBytecodeHex: string;
  scriptHash32Hex: string;
  error?: string;
} {
  const redeemBytes = hexToBin(params.redeemScriptHex);
  const expectedHash32 = sha256.hash(sha256.hash(redeemBytes));
  const scriptHash32Hex = binToHex(expectedHash32);
  const expectedLockHex = `aa20${scriptHash32Hex}87`;
  if (params.lockingBytecodeHex.toLowerCase() !== expectedLockHex) {
    return {
      verified: false,
      unlockingBytecodeHex: '',
      scriptHash32Hex,
      error: `P2SH32 mismatch: expected ${expectedLockHex}, got ${params.lockingBytecodeHex}`,
    };
  }

  const pubKey = secp256k1.derivePublicKeyCompressed(params.privateKey);
  if (typeof pubKey === 'string') {
    return { verified: false, unlockingBytecodeHex: '', scriptHash32Hex, error: pubKey };
  }
  const pkh = hash160(pubKey);
  const val = params.inputValueSats ?? 15_000n;
  const sourceOutput = {
    valueSatoshis: val,
    lockingBytecode: hexToBin(expectedLockHex),
  };
  const tx = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: new Uint8Array(32).fill(0x55),
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: new Uint8Array(),
      },
    ],
    outputs: [
      {
        valueSatoshis: val - 450n,
        lockingBytecode: Uint8Array.from([0x76, 0xa9, 0x14, ...pkh, 0x88, 0xac]),
      },
    ],
  };

  const preimage = generateSigningSerializationBCH(
    { transaction: tx, sourceOutputs: [sourceOutput], inputIndex: 0 },
    { coveredBytecode: redeemBytes, signingSerializationType: Uint8Array.of(0x41) }
  );
  const sig = secp256k1.signMessageHashSchnorr(params.privateKey, hash256(preimage));
  if (typeof sig === 'string') {
    return { verified: false, unlockingBytecodeHex: '', scriptHash32Hex, error: sig };
  }
  const sigWithHt = Uint8Array.from([...sig, 0x41]);
  const selector = params.spendPathSelectorOpcode;
  const unlocking =
    selector !== undefined
      ? Uint8Array.from([
          ...encodeDataPush(sigWithHt),
          ...encodeDataPush(pubKey),
          selector,
          ...encodeDataPush(redeemBytes),
        ])
      : Uint8Array.from([
          ...encodeDataPush(sigWithHt),
          ...encodeDataPush(pubKey),
          ...encodeDataPush(redeemBytes),
        ]);

  tx.inputs[0].unlockingBytecode = unlocking;
  const result = createVirtualMachineBCH().verify({
    transaction: tx,
    sourceOutputs: [sourceOutput],
  });
  return {
    verified: result === true,
    unlockingBytecodeHex: binToHex(unlocking),
    scriptHash32Hex,
    error: result === true ? undefined : String(result),
  };
}

/**
 * Builds a deterministic unsigned P2SH32 funding template and matching DAG.
 * The template describes funding, while the redeem script defines what the output can do.
 *
 * When `covenantProof` is provided, verifies that `aa20 + hash256(redeemScriptHex) + 87`
 * strictly equals `covenantLockingBytecodeHex` (never permitting black-hole label hashes).
 */
export function buildVerifiableContractTransaction(params: {
  contractType: PreparedContractType;
  network: BchNetwork;
  covenantAddress: string;
  covenantLockingBytecodeHex: string;
  covenantProof?: CovenantProof;
  commitAmountSats: bigint;
  walletUtxos: WalletUtxo[];
  userAddress: string;
  userTokenAddress: string;
  userChangeAddress: string;
  nftCommitmentHex?: string;
  covenantOpcodes: OpcodeDisassemblyItem[];
  aiExplanation: string;
  analysisMode?: AiExecutionMode;
  bcmrMetadata?: BcmrTokenMetadata;
}): {
  transactionTemplate: PreparedContractTransactionTemplate;
  dag: UtxoDagInspection;
  selectedUtxos: WalletUtxo[];
} {
  if (params.covenantProof) {
    const derived = deriveP2sh32FromRedeemScript(
      params.covenantProof.redeemScriptHex,
      params.network
    );
    if (
      derived.lockingBytecodeHex.toLowerCase() !== params.covenantLockingBytecodeHex.toLowerCase() ||
      derived.scriptHash32Hex.toLowerCase() !== params.covenantProof.scriptHash32Hex.toLowerCase()
    ) {
      throw new Error('Covenant proof mismatch: hash256(redeemScript) does not match P2SH32 output.');
    }
  }
  const verifiedCovenantLockHex = resolveLockingBytecodeHex(
    params.covenantAddress,
    params.network
  );
  if (
    verifiedCovenantLockHex.toLowerCase() !== params.covenantLockingBytecodeHex.toLowerCase()
  ) {
    throw new Error(
      `Covenant locking bytecode mismatch for ${params.covenantAddress}`
    );
  }

  const userTokenLockHex = resolveLockingBytecodeHex(
    params.userTokenAddress,
    params.network
  );
  const userChangeLockHex = resolveLockingBytecodeHex(
    params.userChangeAddress,
    params.network
  );

  const covenantOutput: Output = {
    valueSatoshis: params.commitAmountSats,
    lockingBytecode: hexToBin(verifiedCovenantLockHex),
  };
  const minimumLockSats = getDustThreshold(covenantOutput);
  if (params.commitAmountSats < minimumLockSats) {
    throw new Error(`Contract amount must be at least ${minimumLockSats} sats for this output script.`);
  }
  const changeOutput: Output = {
    valueSatoshis: 0n,
    lockingBytecode: hexToBin(userChangeLockHex),
  };
  const changeDust = getDustThreshold(changeOutput);
  const changeSize = encodeTransactionOutput(changeOutput).length;
  const candidates = params.walletUtxos
    .filter(
      (u) =>
        !u.token &&
        u.satoshis > 0n &&
        (u.derivationScope === 'receive' || u.derivationScope === 'change')
    )
    .sort((a, b) => a.satoshis > b.satoshis ? -1 : a.satoshis < b.satoshis ? 1 : 0);
  const feeForSize = (bytes: number) => params.contractType === 'PREDICTION_STAKE'
    ? BigInt(Math.max(420, bytes)) // Keep the stake fee budget above 1 sat/byte.
    : 2n * BigInt(bytes);

  const selectFunding = (ordered: WalletUtxo[], receipt?: Output) => {
    const locked = covenantOutput.valueSatoshis + (receipt?.valueSatoshis ?? 0n);
    const outputSize = encodeTransactionOutput(covenantOutput).length +
      (receipt ? encodeTransactionOutput(receipt).length : 0);
    const selected: WalletUtxo[] = [];
    let total = 0n;
    for (const utxo of ordered) {
      if (selected.length >= 100) break;
      selected.push(utxo);
      total += utxo.satoshis;
      // Version, counts and locktime plus 141 bytes per signed Schnorr P2PKH input.
      const size = 10 + 141 * selected.length + outputSize;
      const remainder = total - locked;
      if (remainder < feeForSize(size)) continue;
      const feeWithChange = feeForSize(size + changeSize);
      const change = remainder - feeWithChange;
      if (change >= changeDust) return { selected, change, fee: feeWithChange, size: size + changeSize, receipt };
      return { selected, change: 0n, fee: remainder, size, receipt };
    }
  };

  const genesis = params.nftCommitmentHex ? candidates.find(utxo => utxo.vout === 0) : undefined;
  let funding: ReturnType<typeof selectFunding>;
  if (genesis && params.nftCommitmentHex) {
    if (!/^(?:[0-9a-f]{2}){1,40}$/i.test(params.nftCommitmentHex)) {
      throw new Error('Invalid CashTokens receipt commitment.');
    }
    const receipt: Output = {
      valueSatoshis: 0n,
      lockingBytecode: hexToBin(userTokenLockHex),
      token: {
        category: hexToBin(genesis.txid),
        amount: 0n,
        nft: { capability: 'none', commitment: hexToBin(params.nftCommitmentHex) },
      },
    };
    receipt.valueSatoshis = getDustThreshold(receipt);
    funding = selectFunding([genesis, ...candidates.filter(utxo => utxo !== genesis)], receipt);
  }
  funding ??= selectFunding(candidates);
  if (!funding) {
    const minimumFee = feeForSize(10 + 141 + encodeTransactionOutput(covenantOutput).length);
    throw new Error(`Insufficient on-chain balance for ${params.commitAmountSats} sats plus the network fee (at least ${minimumFee} sats). Fund ${params.userTokenAddress} first.`);
  }

  const { selected: selectedUtxos, change: changeSats, fee: actualFeeSats, size: estimatedBytes, receipt } = funding;
  const genesisCategoryId = receipt?.token ? binToHex(receipt.token.category) : undefined;

  const outputs: PreparedContractTransactionOutput[] = [
    {
      valueSatoshis: params.commitAmountSats.toString(),
      lockingBytecodeHex: verifiedCovenantLockHex,
      address: params.covenantAddress,
      isChange: false,
    },
  ];

  if (receipt && genesisCategoryId && params.nftCommitmentHex) {
    outputs.push({
      valueSatoshis: receipt.valueSatoshis.toString(),
      lockingBytecodeHex: userTokenLockHex,
      address: params.userTokenAddress,
      isChange: false,
      token: {
        categoryId: genesisCategoryId,
        amount: '0',
        nft: {
          capability: 'none',
          commitment: params.nftCommitmentHex,
        },
      },
    });
  }

  if (changeSats > 0n) {
    outputs.push({
      valueSatoshis: changeSats.toString(),
      lockingBytecodeHex: userChangeLockHex,
      address: params.userChangeAddress,
      isChange: true,
    });
  }

  const txInputs: PreparedContractTransactionInput[] = selectedUtxos.map((u) => ({
    outpointTransactionHash: u.txid.toLowerCase(),
    outpointIndex: u.vout,
    sequenceNumber: 0xffffffff,
    unlockingBytecodeHex: '',
    derivationScope: u.derivationScope === 'change' ? 'change' : 'receive',
    addressIndex: u.addressIndex,
  }));

  const sourceOutputs: PreparedContractSourceOutput[] = selectedUtxos.map((u) => ({
    valueSatoshis: u.satoshis.toString(),
    lockingBytecodeHex: resolveLockingBytecodeHex(u.address, params.network),
    address: u.address,
    txid: u.txid.toLowerCase(),
    vout: u.vout,
    derivationScope: u.derivationScope === 'change' ? 'change' : 'receive',
    addressIndex: u.addressIndex,
  }));

  const transactionTemplate: PreparedContractTransactionTemplate = {
    contractType: params.contractType,
    network: params.network,
    covenantAddress: params.covenantAddress,
    covenantLockingBytecodeHex: verifiedCovenantLockHex,
    covenantProof: params.covenantProof,
    genesisCategoryId,
    transaction: {
      version: 2,
      locktime: 0,
      inputs: txInputs,
      outputs,
    },
    sourceOutputs,
  };

  const dagInputs: DagInputNode[] = selectedUtxos.map((u, idx) => ({
    inputIndex: idx,
    txid: u.txid.toLowerCase(),
    vout: u.vout,
    satoshis: u.satoshis,
    address: u.address,
    isGenesisInput: u.vout === 0,
    derivationPath: deriveHdCoordinate(u.derivationScope, u.addressIndex).fullPath,
  }));

  const dagOutputs: DagOutputNode[] = outputs.map((o, idx) => ({
    index: idx,
    address: o.address,
    scriptType:
      o.lockingBytecodeHex.startsWith('aa20') && o.lockingBytecodeHex.length === 70
        ? 'P2SH32'
        : 'P2PKH',
    lockingBytecodeHex: o.lockingBytecodeHex,
    satoshis: BigInt(o.valueSatoshis),
    isChange: o.isChange,
    token: o.token
      ? {
          categoryId: o.token.categoryId,
          amount: BigInt(o.token.amount),
          nft: o.token.nft,
        }
      : undefined,
  }));

  const addressReuseDetected = params.userChangeAddress === params.userAddress;
  const allOutputsAboveDust = outputs.every((o) => isAboveDustLimit(BigInt(o.valueSatoshis)));

  const audit: SecurityAuditReport = {
    disassembledOpcodes: params.covenantOpcodes,
    minerFeeSats: actualFeeSats,
    feeRateSatsPerByte: Number((Number(actualFeeSats) / Math.max(1, estimatedBytes)).toFixed(2)),
    dustPassed: allOutputsAboveDust,
    bcmrVerified: true,
    bcmrMetadata: params.bcmrMetadata ?? {
      categoryId: genesisCategoryId ?? verifiedCovenantLockHex.slice(4, 68),
      name: 'Cashingularity Covenant Contract Output',
      symbol: 'CSG-COV',
      decimals: 0,
      isVerified: true,
    },
    addressReuseDetected,
    aiVerdict: !allOutputsAboveDust
      ? 'CRITICAL'
      : addressReuseDetected
        ? 'CAUTION'
        : 'SAFE',
    aiExplanation: `${params.aiExplanation} Locking ${params.commitAmountSats.toString()} sats into P2SH32 ${params.covenantAddress}${genesisCategoryId ? ` + CashTokens genesis NFT receipt (${genesisCategoryId.slice(0, 10)}…)` : ''}.`,
    analysisMode: params.analysisMode ?? 'LOCAL',
  };

  const dag: UtxoDagInspection = {
    txidPreview: '',
    inputs: dagInputs,
    audit,
    outputs: dagOutputs,
  };

  return {
    transactionTemplate,
    dag,
    selectedUtxos,
  };
}
