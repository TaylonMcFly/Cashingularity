import { binToHex, sha256, type Output } from '@bitauth/libauth';
import { decodeNftReceiptCommitment } from '@cashingularity/shared';
import { compileString } from 'cashc';
import { MockNetworkProvider, type TransactionBuilder } from 'cashscript';
import { describe, expect, it } from 'vitest';
import { PREDICTION_POOL_CONTRACT } from './index.js';
import {
  artifact, assertCashVm, cancelUnfilledOrder, claim, createRound, genesis, inspect, publicKey, recoverEmptyReserve, refundReceipt,
  reserve, reserveOwner, resolutionSignature, stakeOrder, utxo, verifyGenesis, walletLock,
} from './predictionRoundQa.js';

const oracle = new Uint8Array(32).fill(5);
const secondOracle = new Uint8Array(32).fill(6);
const wallet = new Uint8Array(32).fill(4);
const otherWallet = new Uint8Array(32).fill(3);
const expiry = 133500;
const refundTime = 133600;
const strike = 20_000;

function mockRound() {
  const provider = new MockNetworkProvider();
  provider.reset();
  const available = new Map<string, Output>();
  let fundingIndex = 0;
  const fund = (key = wallet, amount = 15_000n) => {
    const txid = binToHex(sha256.hash(Uint8Array.of(fundingIndex++)));
    const output = { valueSatoshis: amount, lockingBytecode: walletLock(key) };
    available.set(`${txid}:0`, output);
    return utxo(txid, 0, output);
  };
  const funding = fund();
  const round = createRound({ categoryId: funding.txid, marketId: 24, strikePriceCents: strike,
    expiry, refundTime, oraclePublicKey: publicKey(oracle), reservePkh: reserveOwner(wallet) }, provider);
  const apply = async (proposal: TransactionBuilder) => {
    const candidate = inspect(proposal);
    const inputs = candidate.transaction.inputs.map(input => `${binToHex(input.outpointTransactionHash)}:${input.outpointIndex}`);
    if (new Set(inputs).size !== inputs.length || inputs.some(input => !available.has(input))) {
      throw new Error('Unknown or already spent outpoint.');
    }
    assertCashVm(candidate.transaction, inputs.map(input => available.get(input)!));
    const txid = await provider.sendRawTransaction(candidate.raw);
    expect(txid).toBe(candidate.txid);
    inputs.forEach(input => available.delete(input));
    return candidate.transaction.outputs.map((output, index) => {
      available.set(`${txid}:${index}`, output);
      return utxo(txid, index, output);
    });
  };
  const bootstrap = () => {
    const builder = genesis(round, funding, wallet);
    const data = inspect(builder);
    verifyGenesis(round, data.transaction, data.sourceOutputs[0]);
    return apply(builder);
  };
  return { ...round, round, funding, bootstrap, apply, fund };
}

const verify = (proposal: TransactionBuilder) => {
  const data = inspect(proposal);
  assertCashVm(data.transaction, data.sourceOutputs);
};

describe('PredictionPool on Mocknet', () => {
  it('keeps the published descriptor byte-for-byte in sync with the testnet-only artifact and pins a unique genesis baton', () => {
    expect(compileString(PREDICTION_POOL_CONTRACT.source).bytecode).toBe(artifact.bytecode);
    expect(PREDICTION_POOL_CONTRACT.deployable).toBe(false);
    const { round, funding } = mockRound();
    const builder = genesis(round, funding, wallet);
    const data = inspect(builder);
    expect(() => verifyGenesis(round, data.transaction, data.sourceOutputs[0])).not.toThrow();
    builder.outputs[1].token = builder.outputs[0].token;
    const duplicate = inspect(builder);
    expect(() => verifyGenesis(round, duplicate.transaction, duplicate.sourceOutputs[0])).toThrow(/exactly one/);
  });

  it.each([{ winner: 0 as const, close: strike - 1 }, { winner: 1 as const, close: strike }])(
    'settles bucket $winner with exact conserved payouts, burned receipts and a returned reserve',
    async ({ winner, close }) => {
      const { round, apply, bootstrap, fund } = mockRound();
      const [initial] = await bootstrap();
      const amounts = [997n, 1453n, 1163n];
      const [firstPool, firstReceipt] = await apply(stakeOrder(round, initial, fund(), wallet, winner, amounts[0], oracle));
      const [secondPool, secondReceipt] = await apply(stakeOrder(round, firstPool, fund(otherWallet), otherWallet, winner, amounts[1], oracle));
      const [fullPool, loser] = await apply(stakeOrder(round, secondPool, fund(), wallet, winner === 0 ? 1 : 0, amounts[2], oracle));
      expect(decodeNftReceiptCommitment(firstReceipt.token!.nft!.commitment)).toMatchObject({ marketId: round.marketId, bucketId: winner, stakeSats: amounts[0] });
      expect(fullPool.satoshis - reserve).toBe(amounts[0] + amounts[1] + amounts[2]);
      expect(() => verify(claim(round, fullPool, loser, wallet, close, oracle))).toThrow();
      const firstClaim = claim(round, fullPool, firstReceipt, wallet, close, oracle);
      const [continuePool, firstPayout] = await apply(firstClaim);
      expect(firstPayout.satoshis).toBe((amounts[0] * (fullPool.satoshis - reserve) / (amounts[0] + amounts[1])) + 300n);
      expect(firstPayout.token).toBeUndefined();
      await expect(apply(firstClaim)).rejects.toThrow(/already spent/);
      expect(() => verify(claim(round, continuePool, secondReceipt, otherWallet, close + (winner ? 1 : -1), oracle))).toThrow();
      const [returnedReserve, secondPayout] = await apply(claim(round, continuePool, secondReceipt, otherWallet, close, oracle));
      expect(firstPayout.satoshis + secondPayout.satoshis - 600n).toBe(fullPool.satoshis - reserve);
      expect(returnedReserve.satoshis).toBe(reserve);
      expect(returnedReserve.token).toBeUndefined();
    },
  );

  it('rejects wrong issuance, additional outputs, wrong owners and refreshed outpoints under an old admission', async () => {
    const { round, bootstrap, apply, fund } = mockRound();
    const [start] = await bootstrap();
    const funding = fund();
    const build = () => stakeOrder(round, start, funding, wallet, 0, 3276n, oracle);
    const valid = build();
    for (const index of [0, 1]) {
      const data = inspect(valid);
      data.transaction.inputs[index].unlockingBytecode = new Uint8Array();
      expect(() => assertCashVm(data.transaction, data.sourceOutputs)).toThrow();
    }
    const wrongCategory = build();
    wrongCategory.outputs[1].token!.category = '95'.repeat(32);
    expect(() => verify(wrongCategory)).toThrow();
    const wrongEndian = build();
    wrongEndian.outputs[1].token!.nft!.commitment = '0000001800cc0c000000000000';
    expect(() => verify(wrongEndian)).toThrow();
    const redirect = build();
    redirect.outputs[1].to = walletLock(otherWallet);
    expect(() => verify(redirect)).toThrow();
    const extraMint = build();
    extraMint.outputs.push({ ...extraMint.outputs[1], amount: 900n });
    expect(() => verify(extraMint)).toThrow();
    const priceTime = build().setLocktime(expiry);
    expect(() => verify(priceTime)).toThrow();
    await apply(valid);
    const stale = build();
    const other = fund();
    stale.inputs[1] = { ...stale.inputs[1], txid: other.txid, vout: other.vout };
    expect(() => verify(stale)).toThrow();
    await expect(apply(valid)).rejects.toThrow(/already spent/);
  });

  it('enforces oracle authorization, payout and continuation scripts even with valid wallet signatures', async () => {
    const { round, bootstrap, apply, fund } = mockRound();
    const [initial] = await bootstrap();
    const [once, down] = await apply(stakeOrder(round, initial, fund(), wallet, 0, 1319n, oracle));
    const [twice] = await apply(stakeOrder(round, once, fund(), wallet, 0, 1549n, oracle));
    const [pool] = await apply(stakeOrder(round, twice, fund(), wallet, 1, 2171n, oracle));
    const build = () => claim(round, pool, down, wallet, strike - 1, oracle);
    expect(() => verify(claim(round, pool, down, wallet, strike - 1, secondOracle))).toThrow();
    const differentRound = createRound({ ...round, marketId: round.marketId + 1 }, round.provider);
    const replayedOracle = build();
    replayedOracle.inputs[0].unlocker = round.contract.unlock.claimRoundPayout(
      resolutionSignature(differentRound, strike - 1, oracle), BigInt(strike - 1),
    );
    expect(() => verify(replayedOracle)).toThrow();
    expect(() => verify(build().setLocktime(expiry - 1))).toThrow();
    const overpay = build();
    overpay.outputs[0].amount -= 1n;
    overpay.outputs[1].amount += 1n;
    expect(() => verify(overpay)).toThrow();
    const changeLock = build();
    changeLock.outputs[0].to = walletLock(otherWallet);
    expect(() => verify(changeLock)).toThrow();
    const retainReceipt = build();
    retainReceipt.outputs[1].token = down.token;
    expect(() => verify(retainReceipt)).toThrow();
    const redirect = build();
    redirect.outputs[1].to = walletLock(otherWallet);
    expect(() => verify(redirect)).toThrow();
    const [resolved] = await apply(build());
    const proposedRefund = build().setLocktime(refundTime);
    proposedRefund.inputs[0] = { ...resolved, unlocker: round.contract.unlock.reclaimExpiredStake() };
    expect(() => verify(proposedRefund)).toThrow();
  });

  it('refunds both sides for principal after the timeout and excludes later settlements', async () => {
    const { round, apply, bootstrap, fund } = mockRound();
    const [initial] = await bootstrap();
    const [once, down] = await apply(stakeOrder(round, initial, fund(), wallet, 0, 3276n, oracle));
    const [pool, up] = await apply(stakeOrder(round, once, fund(otherWallet), otherWallet, 1, 1234n, oracle));
    const refund = refundReceipt(round, pool, up, otherWallet);
    expect(() => verify(refundReceipt(round, pool, up, otherWallet).setLocktime(refundTime - 1))).toThrow();
    const underpay = refundReceipt(round, pool, up, otherWallet);
    underpay.outputs[1].amount = 1233n;
    expect(() => verify(underpay)).toThrow();
    const [continuation, upReturn] = await apply(refund);
    expect(upReturn.satoshis).toBe(1534n);
    expect(upReturn.token).toBeUndefined();
    expect(() => verify(claim(round, continuation, down, wallet, strike - 1, oracle))).toThrow();
    expect(() => verify(stakeOrder(round, continuation, fund(), wallet, 1, 997n, oracle))).toThrow();
    const [returnedReserve, downReturn] = await apply(refundReceipt(round, continuation, down, wallet));
    expect(returnedReserve.satoshis).toBe(reserve);
    expect(returnedReserve.token).toBeUndefined();
    expect(downReturn.satoshis).toBe(3576n);
    expect(downReturn.token).toBeUndefined();
  });

  it('recovers exactly the empty reserve after timeout with a separate owner fee input', async () => {
    const { round, apply, bootstrap, fund } = mockRound();
    const [empty] = await bootstrap();
    const fee = fund(wallet, 5000n);
    const build = () => recoverEmptyReserve(round, empty, fee, wallet);
    expect(() => verify(build().setLocktime(refundTime - 1))).toThrow();
    expect(() => verify(recoverEmptyReserve(round, empty, fund(otherWallet), otherWallet))).toThrow();
    const redirected = build();
    redirected.outputs[0].to = walletLock(otherWallet);
    expect(() => verify(redirected)).toThrow();
    const shortReserve = build();
    shortReserve.outputs[0].amount = reserve - 1n;
    expect(() => verify(shortReserve)).toThrow();
    const valid = build();
    const [returnedReserve, change] = await apply(valid);
    expect(returnedReserve.satoshis).toBe(reserve);
    expect(returnedReserve.token).toBeUndefined();
    expect(change.satoshis).toBe(2800n);
    await expect(apply(valid)).rejects.toThrow('already spent');
  });

  it('excludes reserve recovery after a stake and cancels an admitted but unfilled order by consuming its funds', async () => {
    const { round, apply, bootstrap, fund } = mockRound();
    const [empty] = await bootstrap();
    const firstFunding = fund(otherWallet);
    const order = stakeOrder(round, empty, firstFunding, otherWallet, 1, 1234n, oracle);
    verify(order);
    const [cancelled] = await apply(cancelUnfilledOrder(round, firstFunding, otherWallet));
    expect(cancelled.satoshis).toBe(firstFunding.satoshis - 500n);
    await expect(apply(order)).rejects.toThrow('already spent');
    const [filled] = await apply(stakeOrder(round, empty, fund(wallet), wallet, 0, 1000n, oracle));
    expect(() => verify(recoverEmptyReserve(round, filled, fund(wallet), wallet))).toThrow();
  });
});
