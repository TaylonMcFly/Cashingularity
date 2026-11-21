import { describe, expect, it } from 'vitest';
import { binToHex, hash160, secp256k1, sha256, hexToBin } from '@bitauth/libauth';
import {
  buildPredictionStakeDagPreview,
  buildWizardSignRequest,
  compileInactivityVaultContract,
  compilePredictionPoolContract,
  compilePullRewardClaimContract,
  INACTIVITY_VAULT_CONTRACT,
  PREDICTION_POOL_CONTRACT,
  PULL_REWARD_CLAIM_CONTRACT,
  verifyCovenantRecoveryWithKey,
} from './index.js';

describe('@cashingularity/contracts-cashscript - Covenants, UTXO DAG & WizardConnect Builder', () => {
  it('exports PredictionPool, InactivityVault, and PullRewardClaim CashScript descriptors', () => {
    expect(PREDICTION_POOL_CONTRACT.contractName).toBe('PredictionPool');
    expect(PREDICTION_POOL_CONTRACT.abi.map((f) => f.name)).toEqual([
      'placeStake',
      'claimRoundPayout',
      'reclaimExpiredStake',
      'recoverEmptyRoundReserve',
    ]);

    expect(INACTIVITY_VAULT_CONTRACT.contractName).toBe('InactivityVault');
    expect(INACTIVITY_VAULT_CONTRACT.source).toContain('tx.age >= inactivityPeriod');

    expect(PULL_REWARD_CLAIM_CONTRACT.contractName).toBe('PullRewardClaim');
    expect(PULL_REWARD_CLAIM_CONTRACT.source).toContain('claimEpochReward');
  });

  it('constructs WizardConnect SignTransactionRequest with [inputIndex, scope, addressIndex] tuples', () => {
    const req = buildWizardSignRequest({
      transaction: { version: 2, inputs: [], outputs: [] },
      inputs: [
        { inputIndex: 0, scope: 'defi', addressIndex: 0 },
        { inputIndex: 1, scope: 'receive', addressIndex: 2 },
      ],
      userPrompt: 'Sign Prediction Stake',
    });

    expect(req.inputPaths).toEqual([
      [0, 'defi', 0],
      [1, 'receive', 2],
    ]);
    expect(req.userPrompt).toBe('Sign Prediction Stake');
  });

  it('builds a 3-column Rabby-style UTXO DAG preview with 13-byte NFT receipt commitment', () => {
    const categoryId = 'a'.repeat(64);
    const dag = buildPredictionStakeDagPreview({
      marketId: 7,
      bucketId: 1,
      stakeSats: 10_000n,
      poolTxid: 'b'.repeat(64),
      poolCurrentSats: 500_000n,
      poolAddress: 'bitcoincash:p00000000000000000000000000000000000000000',
      categoryId,
      userFundingTxid: 'c'.repeat(64),
      userFundingVout: 0,
      userFundingSats: 50_000n,
      userAddress: 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      userTokenAddress: 'bitcoincash:zpm2qsznhks23z7629mms6s4cwef74vcwva509496m',
      userChangeAddress: 'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy',
      minerFeeSats: 400n,
    });

    expect(dag.inputs).toHaveLength(2);
    expect(dag.inputs[0].isGenesisInput).toBe(true);
    expect(dag.outputs).toHaveLength(3);
    expect(dag.outputs[0].satoshis).toBe(510_000n);
    expect(dag.outputs[1].decodedCommitment?.marketId).toBe(7);
    expect(dag.outputs[1].decodedCommitment?.bucketId).toBe(1);
    expect(dag.outputs[1].decodedCommitment?.stakeSats).toBe(10_000n);
    expect(dag.audit.dustPassed).toBe(true);
    expect(dag.audit.addressReuseDetected).toBe(false);
    expect(dag.audit.aiVerdict).toBe('SAFE');
  });

  it('compiles spendable P2SH32 redeemScripts with hash256 proof and passes CashVM recovery for all 3 covenants', () => {
    const privKey = new Uint8Array(32).fill(0x11);
    const pubKey = secp256k1.derivePublicKeyCompressed(privKey);
    if (typeof pubKey === 'string') throw new Error(pubKey);
    const pkhHex = binToHex(hash160(pubKey));

    const vault = compileInactivityVaultContract({
      ownerPkhHex: pkhHex,
      beneficiaryPkhHex: '22'.repeat(20),
      inactivityBlocks: 4320,
      network: 'chipnet',
    });
    const pool = compilePredictionPoolContract({
      marketId: 1,
      bucketId: 1,
      predictorPkhHex: pkhHex,
      network: 'chipnet',
    });
    const claim = compilePullRewardClaimContract({
      categoryId: 'f1'.repeat(32),
      currentEpoch: 14,
      contributorPkhHex: pkhHex,
      network: 'chipnet',
    });

    for (const c of [vault, pool, claim]) {
      const expectedHash = binToHex(sha256.hash(sha256.hash(hexToBin(c.redeemScriptHex))));
      expect(c.scriptHash32Hex).toBe(expectedHash);
      expect(c.lockingBytecodeHex).toBe(`aa20${expectedHash}87`);
      const recovery = verifyCovenantRecoveryWithKey({
        redeemScriptHex: c.redeemScriptHex,
        lockingBytecodeHex: c.lockingBytecodeHex,
        privateKey: privKey,
      });
      expect(recovery.verified).toBe(true);
    }
  });
});
