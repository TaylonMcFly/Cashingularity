import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { binToHex, encodeTransaction, hash256, hexToBin, sha256 } from '@bitauth/libauth';
import {
  artifact, assertCashVm, cancelUnfilledOrder, claim, createRound, genesis, inspect, publicKey,
  recoverEmptyReserve, refundReceipt, reserve, reserveOwner, stakeOrder, utxo, verifyGenesis, walletLock,
} from '../packages/contracts-cashscript/dist/predictionRoundQa.js';
import {
  both, checkpoint, decoded, genesisHash, hosts, json, record, rpc, sameTransaction,
  verifyAnchors, verifyReceipts, waitFor, waitLocktime,
} from './prediction-chipnet.mjs';

const provider = { network: 'chipnet' };
const minimumFunding = 40_000;
const scriptHash = lock => binToHex(sha256.hash(lock).reverse());
const inputId = input => binToHex(input.outpointTransactionHash);
const outpoint = coin => coin.txid + ':' + coin.vout;
const sum = outputs => outputs.reduce((total, output) => total + output.valueSatoshis, 0n);
const [mode, outputPath] = process.argv.slice(2);
if (!['--run', '--view', '--verify-live'].includes(mode) || !outputPath) {
  throw new Error('Use --run, --view, or --verify-live followed by a receipt file path.');
}
if (mode === '--run' && existsSync(outputPath)) throw new Error('Choose a new receipt path for this run.');

async function readUtxos(lock) {
  const responses = await both([['blockchain.scripthash.listunspent', [scriptHash(lock), 'include_tokens']]]);
  const snapshots = responses.map(([rows]) => {
    assert.ok(Array.isArray(rows), 'Expected a live UTXO list from both Chipnet peers.');
    return rows.toSorted((a, b) => a.tx_hash.localeCompare(b.tx_hash) || a.tx_pos - b.tx_pos);
  });
  assert.deepEqual(snapshots[0], snapshots[1], 'Chipnet peers disagree on the UTXO set.');
  return snapshots[0];
}

async function confirmation(txid, lock) {
  const results = await Promise.all(hosts.map(async host => {
    const [history, tip] = await rpc(host, [
      ['blockchain.scripthash.get_history', [scriptHash(lock)]],
      ['blockchain.headers.subscribe', []],
    ]);
    const height = Array.isArray(history) && history.find(item => item.tx_hash === txid)?.height;
    if (!height || height < 1 || tip.height < height) return;
    const [header, proof] = await rpc(host, [
      ['blockchain.block.header', [height]],
      ['blockchain.transaction.get_merkle', [txid, height]],
    ]);
    assert.equal(proof?.block_height, height);
    assert.ok(Number.isSafeInteger(proof.pos) && proof.pos >= 0);
    let hash = hexToBin(txid).reverse();
    let position = proof.pos;
    for (const sibling of proof.merkle) {
      assert.match(sibling, /^[0-9a-f]{64}$/);
      const bytes = hexToBin(sibling).reverse();
      hash = hash256(position % 2 ? Uint8Array.of(...bytes, ...hash) : Uint8Array.of(...hash, ...bytes));
      position = Math.floor(position / 2);
    }
    assert.equal(position, 0);
    assert.equal(binToHex(hash), header.slice(72, 136), 'Merkle proof did not match the Chipnet header.');
    return { height, blockHash: binToHex(hash256(hexToBin(header)).reverse()), confirmations: tip.height - height + 1 };
  }));
  if (results.some(value => !value)) return;
  assert.equal(results[0].blockHash, results[1].blockHash, 'Chipnet peers disagree on the confirmation block.');
  return { height: results[0].height, blockHash: results[0].blockHash, confirmations: Math.min(...results.map(item => item.confirmations)) };
}

async function confirmed(txid, lockingBytecode) {
  return waitFor('Confirmation on both Chipnet peers for ' + txid, 900_000, () => confirmation(txid, lockingBytecode));
}

async function exactBinanceClose(expiry) {
  const openMs = (expiry - 60) * 1000;
  const url = new URL('https://api.binance.com/api/v3/klines');
  url.search = new URLSearchParams({ symbol: 'BCHUSDT', interval: '1m', startTime: String(openMs), limit: '1' }).toString();
  return waitFor('Final Binance BCH/USDT candle at ' + new Date(expiry * 1000).toISOString(), 180_000, async () => {
    if (Date.now() < expiry * 1000 + 1000) return;
    const response = await fetch(url, { signal: AbortSignal.timeout(7500) });
    assert.ok(response.ok, 'Binance returned HTTP ' + response.status);
    const [row] = await response.json();
    const priceCents = Math.round(Number(row?.[4]) * 100);
    assert.equal(row?.[0], openMs, 'Oracle candle start does not match the round.');
    assert.equal(row?.[6], expiry * 1000 - 1, 'Oracle candle close does not match the round.');
    assert.ok(Number.isSafeInteger(priceCents) && priceCents > 0);
    return { source: 'Binance BCH/USDT (USD proxy)', url: url.href, openMs, closeMs: row[6], close: row[4], priceCents };
  });
}

async function funding(wallet) {
  const lock = walletLock(wallet.address);
  const { coin, rows } = await waitFor('Confirmed funding for Wallet ' + wallet.role, 1_800_000, async () => {
    const rows = await readUtxos(lock);
    const coin = rows.find(item => !item.token_data && item.height > 0 && item.value >= minimumFunding);
    if (coin) return { coin, rows };
  });
  const raw = await sameTransaction(coin.tx_hash);
  const output = decoded(raw, coin.tx_hash).outputs[coin.tx_pos];
  assert.deepEqual(output.lockingBytecode, lock);
  assert.equal(output.valueSatoshis, BigInt(coin.value));
  assert.equal(output.token, undefined);
  wallet.beforeSats = rows.reduce((sum, item) => sum + BigInt(item.value), 0n);
  wallet.funding = { txid: coin.tx_hash, vout: coin.tx_pos, raw, valueSatoshis: output.valueSatoshis,
    confirmed: await confirmed(coin.tx_hash, lock) };
  wallet.feesSats = 0n;
  wallet.expectedSats = wallet.beforeSats;
}

function createConsole(report, viewOnly) {
  const token = randomBytes(24).toString('hex');
  let pending;
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin === 'http://localhost:3000' || origin === 'http://127.0.0.1:3000') {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Max-Age', '300');
    }
    response.setHeader('Cache-Control', 'no-store');
    const respond = (status, data) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(json(data));
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (request.headers.authorization !== 'Bearer ' + token) { respond(401, { error: 'Open the current local Chipnet run link.' }); return; }
    if (request.method === 'GET' && request.url === '/state') {
      respond(200, { report, viewOnly, pending: pending?.request });
      return;
    }
    if (viewOnly || request.method !== 'POST') { respond(405, { error: 'This proof is read-only.' }); return; }
    try {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 32768) throw new Error('Chipnet QA request is too large.');
      }
      const payload = JSON.parse(body);
      if (request.url === '/wallets') {
        const { role, address } = payload;
        if (report.status !== 'Waiting for wallets' || !['A', 'B'].includes(role)) throw new Error('Wallet assignment is closed.');
        if (typeof address !== 'string') throw new Error('Select a Chipnet wallet.');
        const lock = walletLock(address);
        if (report.wallets.some(wallet => wallet.role !== role && binToHex(walletLock(wallet.address)) === binToHex(lock))) {
          throw new Error('Select a second independent wallet.');
        }
        report.wallets = [...report.wallets.filter(wallet => wallet.role !== role), { role, address }].toSorted((a, b) => a.role.localeCompare(b.role));
      } else if (request.url === '/signature') {
        if (!pending || payload.id !== pending.request.id || typeof payload.raw !== 'string' || !/^(?:[a-f0-9]{2})+$/.test(payload.raw)) {
          throw new Error('This signing request is no longer active.');
        }
        const current = pending;
        pending = undefined;
        current.resolve(payload.raw);
      } else { respond(404, { error: 'Unknown Chipnet proof request.' }); return; }
      respond(200, { ok: true });
    } catch (error) { respond(400, { error: error.message }); }
  });
  const listening = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const url = 'http://localhost:3000/wallet#chipnet-proof=' + server.address().port + '.' + token;
      console.log('CHIPNET_BROWSER', url);
      resolve();
    });
  });
  const sign = async request => {
    let deadline;
    try {
      return await Promise.race([
        new Promise(resolve => { pending = { request: { ...request, id: randomBytes(12).toString('hex') }, resolve }; }),
        new Promise((_, reject) => { deadline = globalThis.setTimeout(() => reject(new Error('Wallet ' + request.role + ' did not approve ' + request.label)), 900_000); }),
      ]);
    } finally { clearTimeout(deadline); pending = undefined; }
  };
  return { listening, sign };
}

async function run(report, consoleSession) {
  const save = () => record(outputPath, report);
  const setStatus = status => { report.status = status; save(); console.log('CHIPNET_STATUS', status); };
  const oracleKey = Uint8Array.from(randomBytes(32));
  const trace = new Map();
  try {
    await verifyAnchors();
    await waitFor('Two user-selected Chipnet signing wallets', 1_800_000, () => report.wallets.length === 2 ? true : undefined);
    const [walletA, walletB] = report.wallets;
    setStatus('Waiting for confirmed Chipnet funding');
    await Promise.all(report.wallets.map(funding));
    for (const wallet of report.wallets) trace.set(wallet.funding.txid, wallet.funding.raw);
    const walletCoin = wallet => utxo(wallet.funding.txid, wallet.funding.vout, decoded(wallet.funding.raw, wallet.funding.txid).outputs[wallet.funding.vout]);
    let a = walletCoin(walletA);
    let b = walletCoin(walletB);

    const spend = async (label, builder, wallet, { round, unlockTime, admissionDeadline, isGenesis } = {}) => {
      if (unlockTime) await waitLocktime(unlockTime);
      const unsigned = inspect(builder);
      const owned = walletLock(wallet.address);
      const parents = unsigned.transaction.inputs.map(input => {
        const raw = trace.get(inputId(input));
        assert.ok(raw, 'Missing ancestry for a reviewed input.');
        return raw;
      });
      const sources = unsigned.transaction.inputs.map((input, i) => decoded(parents[i], inputId(input)).outputs[input.outpointIndex]);
      assert.deepEqual(JSON.parse(json(unsigned.sourceOutputs)), JSON.parse(json(sources)));
      const walletInputs = sources.flatMap((source, i) => binToHex(source.lockingBytecode) === binToHex(owned) ? [i] : []);
      assert.equal(walletInputs.length, 1);
      const [walletInputIndex] = walletInputs;
      const feeSats = sum(sources) - sum(unsigned.transaction.outputs);
      assert.ok(feeSats > 0n && feeSats <= 2200n, 'Chipnet QA fee exceeded the expected bound.');
      if (admissionDeadline && Date.now() >= admissionDeadline * 1000) throw new Error('The round expired before approval.');
      const raw = await consoleSession.sign({ label, role: wallet.role, address: wallet.address, walletInputIndex, raw: unsigned.raw, parents, feeSats });
      if (admissionDeadline && Date.now() >= admissionDeadline * 1000) throw new Error('The round expired while waiting for approval.');
      const txid = binToHex(hash256(hexToBin(raw)).reverse());
      const tx = decoded(raw, txid);
      const reviewed = structuredClone(tx);
      reviewed.inputs[walletInputIndex].unlockingBytecode = new Uint8Array();
      assert.equal(binToHex(encodeTransaction(reviewed)), unsigned.raw, 'Signed transaction differs from the reviewed bytes.');
      assertCashVm(tx, sources);
      if (isGenesis) verifyGenesis(round, tx, sources[0]);
      assert.ok(feeSats >= BigInt(raw.length / 2), 'Fee is below one satoshi per byte.');
      const checks = await Promise.all(sources.map(source => readUtxos(source.lockingBytecode)));
      assert.ok(tx.inputs.every((input, i) => checks[i].some(entry => entry.tx_hash === inputId(input) && entry.tx_pos === input.outpointIndex)),
        'A reviewed input was spent before broadcast.');
      const entry = { txid, label, wallet: wallet.role, marketId: round?.marketId, raw, feeSats, sourceOutputs: sources, observedAt: null };
      report.transactions.push(entry);
      save();
      const replies = await Promise.allSettled(hosts.map(host => rpc(host, [['blockchain.transaction.broadcast', [raw]]])));
      if (!replies.some(reply => reply.status === 'fulfilled' && reply.value[0] === txid)) {
        console.log('CHIPNET_RELAY', label, replies.map(reply => reply.status === 'fulfilled' ? reply.value[0]?.message : reply.reason.message).join(' | '));
      }
      assert.equal(await sameTransaction(txid), raw);
      entry.observedAt = new Date().toISOString();
      trace.set(txid, raw);
      wallet.feesSats += feeSats;
      for (const item of report.wallets) {
        const hex = binToHex(walletLock(item.address));
        item.expectedSats += sum(tx.outputs.filter(output => binToHex(output.lockingBytecode) === hex)) -
          sum(sources.filter(source => binToHex(source.lockingBytecode) === hex));
      }
      save();
      console.log('CHIPNET_OBSERVED', label, txid);
      return tx.outputs.map((output, vout) => utxo(txid, vout, output));
    };

    const latest = await exactBinanceClose(Math.floor((Date.now() - 2000) / 60_000) * 60);
    const expiry = Math.ceil((Date.now() + 600_000) / 60_000) * 60;
    const refundTime = expiry + 120;
    const cases = [
      { label: 'UP resolution', strike: Math.floor(latest.priceCents * 0.9), winner: 'UP' },
      { label: 'DOWN resolution', strike: Math.ceil(latest.priceCents * 1.1), winner: 'DOWN' },
      { label: 'Timeout refunds', strike: latest.priceCents },
      { label: 'Unfilled cancellation', strike: latest.priceCents },
      { label: 'Empty reserve recovery', strike: latest.priceCents },
    ];
    const roundStates = [];
    setStatus('Wallet A opens the five test rounds and funds UP');
    for (const [index, test] of cases.entries()) {
      if (a.vout !== 0) [a] = await spend('Isolate category seed · ' + test.label, cancelUnfilledOrder({ provider }, a, walletA.address), walletA);
      const round = createRound({ categoryId: a.txid, marketId: expiry + index, strikePriceCents: test.strike, expiry, refundTime,
        oraclePublicKey: publicKey(oracleKey), reservePkh: reserveOwner(walletA.address) }, provider);
      const details = { ...test, marketId: round.marketId, categoryId: round.categoryId, address: round.contract.tokenAddress,
        lockingBytecode: round.lock, strikePriceCents: round.strikePriceCents, expiry, refundTime,
        oraclePublicKey: round.oraclePublicKey, reservePkh: round.reservePkh, stakes: [] };
      report.rounds.push(details);
      const [empty, change] = await spend('Open · ' + test.label, genesis(round, a, walletA.address), walletA, { round, isGenesis: true });
      const state = { round, details, pool: empty };
      a = change;
      details.genesisTxid = empty.txid;
      if (index <= 2) {
        [state.pool, state.up, a] = await spend('Wallet A stakes UP · ' + test.label,
          stakeOrder(round, empty, a, walletA.address, 1, 1000n, oracleKey), walletA, { round, admissionDeadline: expiry });
        details.stakes.push({ role: 'A', outcome: 'UP', sats: 1000, receipt: outpoint(state.up), txid: state.up.txid });
      }
      roundStates.push(state);
    }

    setStatus('Wallet B funds DOWN in the same rounds');
    for (const state of roundStates.slice(0, 3)) {
      const { round, details } = state;
      [state.pool, state.down, b] = await spend('Wallet B stakes DOWN · ' + details.label,
        stakeOrder(round, state.pool, b, walletB.address, 0, 1000n, oracleKey), walletB, { round, admissionDeadline: expiry });
      details.stakes.push({ role: 'B', outcome: 'DOWN', sats: 1000, receipt: outpoint(state.down), txid: state.down.txid });
    }

    const cancelled = roundStates[3];
    const unfilled = inspect(stakeOrder(cancelled.round, cancelled.pool, b, walletB.address, 0, 1000n, oracleKey));
    assert.throws(() => assertCashVm(unfilled.transaction, unfilled.sourceOutputs), /input index 1/i);
    const oldFunding = b;
    [b] = await spend('Cancel unfilled DOWN order', cancelUnfilledOrder(cancelled.round, b, walletB.address), walletB,
      { round: cancelled.round, admissionDeadline: expiry });
    await confirmed(b.txid, walletLock(walletB.address));
    assert.ok(!(await readUtxos(walletLock(walletB.address))).some(coin => coin.tx_hash === oldFunding.txid && coin.tx_pos === oldFunding.vout));
    cancelled.details.cancellation = { txid: b.txid, invalidatedInput: outpoint(oldFunding), unfilledTemplate: unfilled.raw, poolUnchanged: true };

    setStatus('Confirming locked positions on both Chipnet peers');
    for (const state of roundStates) {
      const { pool, round, details } = state;
      const verification = await confirmed(pool.txid, round.lock);
      const rows = await readUtxos(round.lock);
      const coin = rows.find(item => item.tx_hash === pool.txid && item.tx_pos === pool.vout);
      assert.equal(coin?.value, Number(pool.satoshis));
      assert.equal(coin?.token_data?.category, round.categoryId);
      assert.equal(coin?.token_data?.nft?.commitment, pool.token.nft.commitment);
      details.locked = { outpoint: outpoint(pool), sats: pool.satoshis, reserveSats: reserve,
        totalStakeSats: pool.satoshis - reserve, ...verification };
    }
    save();

    setStatus('Waiting for the exact Binance expiry candle');
    await setTimeout(Math.max(0, expiry * 1000 + 1000 - Date.now()));
    const oracle = await exactBinanceClose(expiry);
    report.oracle = oracle;
    setStatus('Signing both oracle resolutions');
    for (const state of roundStates.slice(0, 2)) {
      const { round, details, pool } = state;
      const upWon = oracle.priceCents >= round.strikePriceCents;
      assert.equal(upWon ? 'UP' : 'DOWN', details.winner, 'The observed candle did not produce the planned opposite outcome.');
      const winner = upWon ? walletA : walletB;
      const loser = upWon ? walletB : walletA;
      const losingReceipt = upWon ? state.down : state.up;
      const wrong = inspect(claim(round, pool, losingReceipt, loser.address, oracle.priceCents, oracleKey));
      assert.throws(() => assertCashVm(wrong.transaction, wrong.sourceOutputs), /input index 0/i);
      const [returned, paid] = await spend('Pay ' + details.winner + ' · Wallet ' + winner.role,
        claim(round, pool, upWon ? state.up : state.down, winner.address, oracle.priceCents, oracleKey),
        winner, { round, unlockTime: expiry });
      assert.equal(returned.satoshis, reserve);
      details.payout = { txid: paid.txid, winner: winner.role, poolPayoutSats: pool.satoshis - reserve,
        walletOutputSats: paid.satoshis, reserveReturnedSats: returned.satoshis, losingClaimRejected: true };
    }

    setStatus('Returning timeout stakes and empty reserves');
    const timeout = roundStates[2];
    const [continuation, downRefund] = await spend('Timeout refund · Wallet B', refundReceipt(timeout.round, timeout.pool, timeout.down, walletB.address),
      walletB, { round: timeout.round, unlockTime: refundTime });
    const [returned, upRefund] = await spend('Timeout refund · Wallet A', refundReceipt(timeout.round, continuation, timeout.up, walletA.address),
      walletA, { round: timeout.round, unlockTime: refundTime });
    assert.equal(returned.satoshis, reserve);
    timeout.details.refunds = [{ role: 'B', txid: downRefund.txid, principalSats: 1000, walletOutputSats: downRefund.satoshis },
      { role: 'A', txid: upRefund.txid, principalSats: 1000, walletOutputSats: upRefund.satoshis, reserveReturnedSats: reserve }];
    for (const state of roundStates.slice(3)) {
      const [recovered, change] = await spend('Recover · ' + state.details.label, recoverEmptyReserve(state.round, state.pool, a, walletA.address),
        walletA, { round: state.round, unlockTime: refundTime });
      a = change;
      assert.equal(recovered.satoshis, reserve);
      state.details.reserveRecovery = { txid: recovered.txid, reserveReturnedSats: recovered.satoshis };
    }

    setStatus('Confirming all transactions and reconciling both wallets');
    for (const entry of report.transactions) {
      const tx = decoded(entry.raw, entry.txid);
      entry.confirmed = await confirmed(entry.txid, tx.outputs[0].lockingBytecode);
      save();
    }
    for (const wallet of report.wallets) {
      const actual = await readUtxos(walletLock(wallet.address));
      assert.ok(actual.every(coin => coin.height > 0), 'Wallet has an unexpected unconfirmed output.');
      wallet.afterSats = actual.reduce((total, coin) => total + BigInt(coin.value), 0n);
      wallet.receiptSats = actual.filter(coin => coin.token_data).reduce((total, coin) => total + BigInt(coin.value), 0n);
      assert.equal(wallet.afterSats, wallet.expectedSats, 'Wallet balance does not reconcile to the confirmed transaction ledger.');
    }
    assert.equal(report.wallets.reduce((total, wallet) => total + wallet.beforeSats - wallet.afterSats - wallet.feesSats, 0n), 0n);
    verifyReceipts(JSON.parse(json(report)));
    setStatus('Confirmed and reconciled');
  } catch (error) {
    report.error = error.message;
    setStatus('Stopped');
    process.exitCode = 1;
  } finally { oracleKey.fill(0); }
}

if (mode === '--verify-live') {
  const report = JSON.parse(readFileSync(outputPath, 'utf8'));
  verifyReceipts(report);
  await verifyAnchors();
  for (const entry of report.transactions) {
    assert.equal(await sameTransaction(entry.txid), entry.raw);
    const check = await confirmation(entry.txid, decoded(entry.raw, entry.txid).outputs[0].lockingBytecode);
    assert.ok(check, 'Still awaiting confirmation for ' + entry.txid);
    console.log(entry.label, entry.txid, check.height, check.confirmations);
  }
} else {
  const report = mode === '--view' ? JSON.parse(readFileSync(outputPath, 'utf8')) : {
    network: 'chipnet', genesisHash, checkpoint, peers: hosts,
    artifact: binToHex(sha256.hash(new TextEncoder().encode(artifact.bytecode))),
    status: 'Waiting for wallets', wallets: [], rounds: [], transactions: [],
  };
  if (mode === '--view') verifyReceipts(report);
  const consoleSession = createConsole(report, mode === '--view');
  await consoleSession.listening;
  if (mode === '--run') await run(report, consoleSession);
}
