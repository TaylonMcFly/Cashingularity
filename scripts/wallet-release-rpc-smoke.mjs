import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { encodeCashAddress } from '@bitauth/libauth';
import { WALLET_SYNC_ADDRESS_LIMIT, WALLET_SYNC_BATCH_SIZE } from '@cashingularity/shared';
import { registerWalletSync } from '../packages/backend/dist/electrumWalletSync.js';
import { cashAddrToElectrumScriptHash } from '../packages/backend/dist/bchNetworkService.js';

// The compiled backend uses its actual TLS Electrum client and WebSocket route against a private,
// deterministic listener. There is no traffic to public peers or support for spending methods.
const scratch = await mkdtemp(join(tmpdir(), 'cashingularity-rpc-audit-'));
const certFile = join(scratch, 'cert.pem');
const keyFile = join(scratch, 'key.pem');
const makeHash = data => createHash('sha256').update(data).digest();
const genesis = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
const baseTip = { height: 500, hex: '00'.repeat(80) };
const originalConnect = tls.connect;
const sockets = new Set();
const outputs = new Map();
const addresses = Array.from({ length: 10_000 }, (_, index) => {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(index + 1);
  const address = encodeCashAddress({ prefix: 'bitcoincash', type: 'p2pkh', payload }).address;
  if (index % 20 === 0) {
    const { scriptHash } = cashAddrToElectrumScriptHash(address);
    outputs.set(scriptHash, { tx_hash: makeHash(payload).toString('hex'), height: 499, tx_pos: 0, value: 2000 });
  }
  return address;
});
let tip = baseTip;
let counts = {};
let peak = 0;
const reset = () => { counts = {}; peak = 0; };

function openElectrum({ key, cert }) {
  return tls.createServer({ key, cert }, socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    let inFlight = 0;
    socket.on('data', chunk => {
      buffer += chunk;
      for (let end; (end = buffer.indexOf('\n')) !== -1;) {
        const { id, method, params } = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        counts[method] = (counts[method] ?? 0) + 1;
        peak = Math.max(peak, ++inFlight);
        const utxo = outputs.get(params?.[0]);
        const result = {
          'server.version': ['Audit Fulcrum fixture', '1.6'],
          'server.features': { genesis_hash: genesis },
          'blockchain.headers.subscribe': tip,
          'blockchain.block.header': baseTip.hex,
          'blockchain.scripthash.subscribe': utxo ? makeHash(`${utxo.tx_hash}:${utxo.height}:`).toString('hex') : null,
          'blockchain.scripthash.get_history': utxo ? [{ tx_hash: utxo.tx_hash, height: utxo.height }] : [],
          'blockchain.scripthash.listunspent': utxo ? [utxo] : [],
          'server.ping': null,
        }[method];
        assert.notEqual(result, undefined, 'The audit fixture accepts only read operations.');
        setImmediate(() => {
          inFlight--;
          if (!socket.destroyed) socket.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
        });
      }
    });
  });
}

function waitMessage(socket, match, timeout = 24_000) {
  const events = new AbortController();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.abort(); reject(Error('Timed out waiting for the wallet socket')); }, timeout);
    const finish = (action, value) => { clearTimeout(timer); events.abort(); action(value); };
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (match(message)) finish(resolve, message);
    }, { signal: events.signal });
    socket.addEventListener('close', event => finish(reject, Error(event.reason)), { signal: events.signal });
  });
}

let electrum, app;
try {
  const openssl = process.env.OPENSSL_PATH || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', keyFile, '-out', certFile], { stdio: 'ignore' });
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  electrum = openElectrum({ key, cert });
  electrum.listen(0, '127.0.0.1');
  await once(electrum, 'listening');
  tls.connect = options => originalConnect({ ...options, host: '127.0.0.1', port: electrum.address().port,
    servername: 'localhost', ca: cert, rejectUnauthorized: true });
  app = Fastify({ logger: false });
  await app.register(websocket);
  registerWalletSync(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  for (const requested of [200, 2000, 10000]) {
    reset();
    tip = baseTip;
    const socket = new WebSocket('ws://127.0.0.1:' + app.server.address().port + '/ws/wallet');
    let requests = 0;
    const query = async (addresses, verify) => {
      const id = ++requests;
      const reply = waitMessage(socket, message => message.id === id);
      socket.send(JSON.stringify({ id, network: 'mainnet', addresses, tipUpdates: true, ...(verify && { verify: true }) }));
      return reply;
    };
    const watched = Math.min(requested, WALLET_SYNC_ADDRESS_LIMIT);
    try {
      await once(socket, 'open', { signal: AbortSignal.timeout(5000) });
      const started = performance.now();
      const heartbeat = waitMessage(socket, message => message.type === 'heartbeat');
      for (let offset = 0; offset < watched; offset += WALLET_SYNC_BATCH_SIZE) {
        const batch = await query(addresses.slice(offset, offset + WALLET_SYNC_BATCH_SIZE));
        assert.equal(batch.type, 'snapshot');
      }
      assert.equal((await query([addresses[0]], true)).verified, true);
      const cold = { ms: Math.round(performance.now() - started), requests, rpc: counts, maxInFlight: peak };
      reset();
      await heartbeat;
      const recheck = { atMs: Math.round(performance.now() - started), rpc: counts, maxInFlight: peak };
      assert.equal(recheck.rpc['blockchain.scripthash.subscribe'], watched);
      assert.equal(recheck.rpc['blockchain.headers.subscribe'], 2);
      reset();
      const advanced = waitMessage(socket, message => message.type === 'tip');
      tip = { height: baseTip.height + 1, hex: '01'.repeat(4) + makeHash(makeHash(Buffer.from(baseTip.hex, 'hex'))).toString('hex') + '00'.repeat(44) };
      for (const peer of sockets) peer.write(JSON.stringify({ method: 'blockchain.headers.subscribe', params: [tip] }) + '\n');
      assert.equal((await advanced).height, tip.height);
      const extension = { rpc: counts, maxInFlight: peak };
      assert.equal(extension.rpc['blockchain.scripthash.subscribe'], watched);
      let cap;
      if (requested > watched) {
        reset();
        const closed = once(socket, 'close', { signal: AbortSignal.timeout(5000) });
        socket.send(JSON.stringify({ id: ++requests, network: 'mainnet', addresses: [addresses[watched]], tipUpdates: true }));
        const [event] = await closed;
        assert.equal(event.code, 1011);
        cap = { rejectedAddress: watched + 1, closeCode: event.code, rpc: counts };
      }
      console.log(JSON.stringify({ requested, watched, cold, recheck, extension, ...(cap && { cap }) }));
    } finally {
      if (socket.readyState < WebSocket.CLOSING) { const closed = once(socket, 'close'); socket.close(); await closed; }
    }
  }
} finally {
  tls.connect = originalConnect;
  await app?.close();
  for (const socket of sockets) socket.destroy();
  if (electrum?.listening) await new Promise(resolve => electrum.close(resolve));
  await Promise.allSettled([unlink(keyFile), unlink(certFile)]);
  await rmdir(scratch);
}
