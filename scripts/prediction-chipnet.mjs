import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect } from 'node:tls';
import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { binToHex, decodeTransaction, encodeCashAddress, hashTransaction, hexToBin, sha256 } from '@bitauth/libauth';
import { TransactionBuilder, SignatureTemplate } from 'cashscript';
import {
  artifact, assertCashVm, claim, createRound, genesis, inspect, publicKey, refundReceipt, reserveOwner,
  stakeOrder, utxo, verifyGenesis, walletLock,
} from '../packages/contracts-cashscript/dist/predictionRoundQa.js';

const hosts = ['chipnet.bch.ninja', 'chipnet.imaginary.cash'];
const genesisHash = '000000001dd410c49a788668ce26751718cc797474d3152a5fc073dd44fd9f7b';
const checkpoint = [339169, '0000000054a6b4cea78ee40540d927be564ae9937d6236f217bf0994c8c79fff'];
const json = (value) => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() :
  item instanceof Uint8Array ? binToHex(item) : item, 2);

function rpc(host, calls) {
  return new Promise((resolve, reject) => {
    const pending = new Map(calls.map((_, i) => [i, undefined]));
    let buffer = '';
    const socket = connect({ host, port: 50002, servername: host }, () => {
      socket.write(calls.map(([method, params], id) => JSON.stringify({ jsonrpc: '2.0', id, method, params })).join('\n') + '\n');
    });
    socket.setEncoding('utf8').setTimeout(9000);
    socket.on('timeout', () => socket.destroy(new Error(`${host} timed out`)));
    socket.on('error', reject);
    socket.on('end', () => { if ([...pending.values()].some(value => value === undefined)) reject(new Error('Incomplete Electrum response.')); });
    socket.on('data', chunk => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (pending.has(msg.id)) pending.set(msg.id, msg.error || msg.result);
        } catch (error) { socket.destroy(error); return; }
      }
      const result = [...pending.values()];
      if (result.every(value => value !== undefined)) { socket.end(); resolve(result); }
    });
  });
}
const both = (calls) => Promise.all(hosts.map(host => rpc(host, calls)));
function decoded(raw, txid) {
  assert.equal(typeof raw, 'string', raw?.message || 'Expected raw Chipnet transaction');
  const bytes = hexToBin(raw);
  assert.equal(hashTransaction(bytes), txid);
  const value = decodeTransaction(bytes);
  assert.equal(typeof value, 'object', value);
  return value;
}
async function anchor() {
  for (const [root, block] of await both([['blockchain.block.header', [0]], ['blockchain.block.header', [checkpoint[0]]]])) {
    assert.equal(hashTransaction(hexToBin(root)), genesisHash);
    assert.equal(hashTransaction(hexToBin(block)), checkpoint[1]);
  }
}
async function medianTimePast() {
  const times = await Promise.all(hosts.map(async host => {
    const [{ height, hex }] = await rpc(host, [['blockchain.headers.subscribe', []]]);
    assert.ok(Number.isSafeInteger(height));
    const [headers] = await rpc(host, [['blockchain.block.headers', [height - 10, 11]]]);
    assert.equal(headers.count, 11);
    assert.equal(headers.hex.length, 11 * 160);
    assert.equal(headers.hex.slice(-160), hex, 'Tip changed between observations.');
    const bytes = hexToBin(headers.hex);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return Array.from({ length: 11 }, (_, i) => view.getUint32(80 * i + 68, true)).sort((a, b) => a - b)[5];
  }));
  return Math.min(...times);
}
async function waitFor(label, deadlineMs, poll) {
  const deadline = Date.now() + deadlineMs;
  let lastError;
  do {
    try {
      const value = await poll();
      if (value !== undefined) return value;
    } catch (error) { lastError = error; }
    await setTimeout(5000);
  } while (Date.now() < deadline);
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}
const sameTransaction = (id) => waitFor(`Both peers observing ${id}`, 180_000, async () => {
  const results = await both([['blockchain.transaction.get', [id]]]);
  if (results.some(([raw]) => typeof raw !== 'string')) return;
  assert.equal(results[0][0], results[1][0]);
  decoded(results[0][0], id);
  return results[0][0];
});
const waitLocktime = (seconds) => waitFor(`Chipnet median time passing ${new Date(seconds * 1000).toISOString()}`, 900_000, async () => {
  const current = await medianTimePast();
  if (current > seconds) return current;
});
const verifyAnchors = () => waitFor('Both peers verifying the Chipnet chain', 75_000, async () => {
  await anchor();
  return true;
});
const provider = { network: 'chipnet' }; // Builders only. All RPC goes through the anchored TLS peers below.

function record(outputPath, data) {
  writeFileSync(outputPath + '.tmp', json(data) + '\n');
  renameSync(outputPath + '.tmp', outputPath);
}

async function transmit(data, outputPath) {
  for (const transaction of data.transactions) {
    if (transaction.observedAt) continue;
    if (transaction.locktime) await waitLocktime(transaction.locktime);
    // Replaying identical signed bytes is idempotent when a relay accepted the earlier request.
    const replies = await Promise.allSettled(hosts.map(host => rpc(host, [['blockchain.transaction.broadcast', [transaction.raw]]])));
    transaction.responseObserved ||= replies.some(r => r.status === 'fulfilled' && r.value[0] === transaction.txid);
    record(outputPath, data);
    if (!transaction.responseObserved) {
      const errors = replies.map(r => r.status === 'fulfilled' ? r.value[0]?.message : r.reason.message).filter(Boolean);
      console.log('CHIPNET_RELAY_PENDING', transaction.label, errors.join(' | '));
    }
    assert.equal(await sameTransaction(transaction.txid), transaction.raw);
    transaction.observedAt = new Date().toISOString();
    record(outputPath, data);
    console.log('CHIPNET_VERIFIED', transaction.label, transaction.txid);
  }
}

async function run(outputPath) {
  await verifyAnchors();
  const fundingKey = Uint8Array.from(randomBytes(32));
  const counterpartyKey = Uint8Array.from(randomBytes(32));
  const oracle = Uint8Array.from(randomBytes(32));
  try {
    const receiveLock = walletLock(fundingKey);
    const tokenAddress = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload: reserveOwner(fundingKey) }).address;
    const scripthash = binToHex(sha256.hash(receiveLock).reverse());
    console.log('CHIPNET_FAUCET_ADDRESS', tokenAddress);
    const coin = await waitFor('Chipnet faucet funding of at least 30,000 test sats', 900_000, async () => {
      const [first, second] = await both([['blockchain.scripthash.listunspent', [scripthash, 'include_tokens']]]);
      const result = first[0];
      if (!Array.isArray(result) || !Array.isArray(second[0])) return;
      return result.find(u => !u.token_data && u.value >= 30000 && second[0].some(r => r.tx_hash === u.tx_hash && r.tx_pos === u.tx_pos && r.value === u.value && !r.token_data));
    });
    const faucetRaw = await sameTransaction(coin.tx_hash);
    const funds = decoded(faucetRaw, coin.tx_hash).outputs[coin.tx_pos];
    assert.deepEqual(funds.lockingBytecode, receiveLock);
    assert.equal(funds.valueSatoshis, BigInt(coin.value));
    assert.equal(funds.token, undefined);
    const planned = new Map([[coin.tx_hash, faucetRaw]]);
    const data = {
      network: 'chipnet', genesisHash, checkpoint, peers: hosts,
      address: tokenAddress, artifact: binToHex(sha256.hash(new TextEncoder().encode(artifact.bytecode))),
      faucet: { txid: coin.tx_hash, vout: coin.tx_pos, valueSatoshis: funds.valueSatoshis, raw: faucetRaw },
      rounds: [], transactions: [], planComplete: false,
    };
    const stage = (label, builder, validate = () => {}, locktime) => {
      const candidate = inspect(builder);
      const actual = candidate.transaction.inputs.map(input => {
        const txid = binToHex(input.outpointTransactionHash);
        const raw = planned.get(txid);
        assert.ok(raw, 'Every input must originate from the faucet or a verified step in this plan.');
        return decoded(raw, txid).outputs[input.outpointIndex];
      });
      assert.deepEqual(JSON.parse(json(actual)), JSON.parse(json(candidate.sourceOutputs)));
      assertCashVm(candidate.transaction, actual);
      validate(candidate.transaction, actual);
      const feeSats = actual.reduce((value, o) => value + o.valueSatoshis, 0n) -
        candidate.transaction.outputs.reduce((value, o) => value + o.valueSatoshis, 0n);
      assert.ok(feeSats >= BigInt(candidate.raw.length / 2), 'Chipnet relay needs at least one satoshi per byte.');
      data.transactions.push({ label, txid: candidate.txid, raw: candidate.raw, feeSats, sourceOutputs: actual,
        locktime, responseObserved: false, observedAt: null });
      planned.set(candidate.txid, candidate.raw);
      return candidate.transaction.outputs.map((o, vout) => utxo(candidate.txid, vout, o));
    };

    const unlock = new SignatureTemplate(fundingKey).unlockP2PKH();
    const [settlementSeed, secondFunding, refundFunding] = stage('split faucet funding',
      new TransactionBuilder({ provider }).addInput(utxo(coin.tx_hash, coin.tx_pos, funds), unlock)
        .addOutput({ to: receiveLock, amount: 10_000n })
        .addOutput({ to: walletLock(counterpartyKey), amount: 8_000n })
        .addOutput({ to: receiveLock, amount: funds.valueSatoshis - 18_500n }));
    const [refundSeed] = stage('isolate refund genesis input',
      new TransactionBuilder({ provider }).addInput(refundFunding, unlock)
        .addOutput({ to: receiveLock, amount: refundFunding.satoshis - 500n }));
    const start = await waitFor('Chipnet median time from both peers', 75_000, medianTimePast);
    const construct = (seed, marketId) => createRound({ categoryId: seed.txid, marketId, strikePriceCents: 20_000,
      expiry: start + 240, refundTime: start + 300, oraclePublicKey: publicKey(oracle), reservePkh: reserveOwner(fundingKey) }, provider);

    const settlementRound = construct(settlementSeed, 20261120);
    const refundRound = construct(refundSeed, 20261121);
    for (const round of [settlementRound, refundRound]) data.rounds.push({
      categoryId: round.categoryId, address: round.contract.address, lockingBytecode: round.lock,
      marketId: round.marketId, strikePriceCents: round.strikePriceCents, expiry: round.expiry, refundTime: round.refundTime,
      oraclePublicKey: round.oraclePublicKey, reservePkh: round.reservePkh,
    });
    const bootstrap = (name, round, seed) => stage(name, genesis(round, seed, fundingKey), (transaction, inputs) => {
      verifyGenesis(round, transaction, inputs[0]);
    });
    const [settlementPool, downFunding] = bootstrap('settlement genesis', settlementRound, settlementSeed);
    const [refundPool, refundableFunding] = bootstrap('refund genesis', refundRound, refundSeed);
    const [one] = stage('stake DOWN', stakeOrder(settlementRound, settlementPool, downFunding, fundingKey, 0, 1000n, oracle));
    const [two, upReceipt] = stage('stake UP', stakeOrder(settlementRound, one, secondFunding, counterpartyKey, 1, 1200n, oracle));
    const [refundState, timeoutReceipt] = stage('stake for timeout', stakeOrder(refundRound, refundPool, refundableFunding, fundingKey, 0, 1100n, oracle));
    console.log('WAIT_FOR_CHIPNET_MEDIAN_TIME', settlementRound.expiry, refundRound.refundTime);
    const [releasedReserve, payment] = stage('UP settlement', claim(settlementRound, two, upReceipt, counterpartyKey, 20_000, oracle), undefined, settlementRound.expiry);
    assert.equal(releasedReserve.satoshis, 1500n);
    assert.equal(payment.satoshis, 2500n);
    const [refundReserve, refundPayment] = stage('timeout refund', refundReceipt(refundRound, refundState, timeoutReceipt, fundingKey), undefined, refundRound.refundTime);
    assert.equal(refundReserve.satoshis, 1500n);
    assert.equal(refundPayment.satoshis, 1400n);
    data.planComplete = true;
    record(outputPath, data);
    await transmit(data, outputPath);
  } finally {
    fundingKey.fill(0);
    counterpartyKey.fill(0);
    oracle.fill(0);
  }
}

function verifyReceipts(report) {
  assert.equal(report.network, 'chipnet');
  const funds = report.wallets?.flatMap(wallet => wallet.funding ? [wallet.funding] : []) ?? [report.faucet];
  const trace = new Map(funds.map(funding => [funding.txid, decoded(funding.raw, funding.txid)]));
  const spent = new Set();
  // Historical receipts pin the actual script on-chain. A new artifact changes the address.
  const rounds = (report.rounds ?? []).map(({ categoryId, lockingBytecode }) => {
    assert.match(lockingBytecode, /^aa20[0-9a-f]{64}87$/);
    return { categoryId, lock: hexToBin(lockingBytecode) };
  });
  for (const receipt of report.transactions) {
    const tx = decoded(receipt.raw, receipt.txid);
    const sources = tx.inputs.map(input => {
      const id = binToHex(input.outpointTransactionHash);
      const item = `${id}:${input.outpointIndex}`;
      const previous = trace.get(id)?.outputs[input.outpointIndex];
      assert.ok(previous && !spent.has(item), 'Receipt ancestry contains a missing or repeated input.');
      spent.add(item);
      return previous;
    });
    assert.deepEqual(JSON.parse(json(sources)), receipt.sourceOutputs);
    assertCashVm(tx, sources);
    const fee = sources.reduce((sum, output) => sum + output.valueSatoshis, 0n) - tx.outputs.reduce((sum, output) => sum + output.valueSatoshis, 0n);
    if (receipt.feeSats !== undefined) assert.equal(fee, BigInt(receipt.feeSats));
    const first = tx.inputs[0];
    const genesisRound = first.outpointIndex === 0 && rounds.find(round => round.categoryId === binToHex(first.outpointTransactionHash));
    if (genesisRound) verifyGenesis(genesisRound, tx, sources[0]);
    trace.set(receipt.txid, tx);
  }
}

export { hosts, genesisHash, checkpoint, json, rpc, both, decoded, verifyAnchors, medianTimePast, waitFor, sameTransaction, waitLocktime, record, verifyReceipts };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
const [mode, outputPath] = process.argv.slice(2);
if (mode === '--verify-receipts' && outputPath) {
  // Verify recorded public transaction bytes before drawing any conclusions about their chain status.
  const report = JSON.parse(readFileSync(outputPath, 'utf8'));
  verifyReceipts(report);
  const observed = report.transactions.filter(transaction => transaction.observedAt).length;
  console.log(`CashVM verified ${report.transactions.length} signed test transactions. ${observed} were recorded by both Chipnet peers.`);
} else if (mode === '--continue-chipnet' && outputPath) {
  const report = JSON.parse(readFileSync(outputPath, 'utf8'));
  assert.equal(report.planComplete, true, 'Expected a complete validated Chipnet transaction plan.');
  assert.ok(report.rounds.every(round => round.expiry >= 500_000_000), 'Use a plan constructed with Chipnet median-time-past timestamps.');
  verifyReceipts(report);
  await verifyAnchors();
  assert.equal(await sameTransaction(report.faucet.txid), report.faucet.raw);
  await transmit(report, outputPath);
} else if (mode === '--execute-chipnet' && outputPath) {
  try { await run(outputPath); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
} else {
  throw new Error('Pass --execute-chipnet, --continue-chipnet or --verify-receipts followed by a receipt file path.');
}
}
