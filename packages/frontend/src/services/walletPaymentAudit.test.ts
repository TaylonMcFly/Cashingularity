import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  binToHex, cashAddressToLockingBytecode, createVirtualMachineBCH, deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic, deriveHdPublicNode, encodeHdPublicKey, encodeTransaction,
  generateSigningSerializationBCH, hash256, secp256k1,
} from '@bitauth/libauth';
import { satsToBchString, type WalletUtxo } from '@cashingularity/shared';
import { RelayMsgAction, type RelayClient } from '@wizardconnect/core';
import type { DappConnectionManager } from '@wizardconnect/dapp';
import { BchWalletService } from './bchWalletService.js';
import { preparePayment } from './paymentService.js';
import { WalletRuntime, wizardProfile } from './walletRuntime.js';
import { createWizardRelay } from './wizardRelay.js';

const publicVector = `${'abandon '.repeat(11)}about`;
const recipient = 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a';

async function fixture() {
  const key = new BchWalletService();
  const addresses = key.importLocalWallet(publicVector, 'mainnet');
  const native: WalletUtxo = {
    txid: '21'.repeat(32), vout: 0, satoshis: 10000n, address: addresses.receiveAddress,
    tokenAddress: addresses.receiveTokenAddress, derivationScope: 'receive', addressIndex: 0, isGenesisCapable: true,
  };
  const token = { ...native, txid: '22'.repeat(32), satoshis: 101000n, token: { categoryId: '33'.repeat(32), amount: 100n } };
  const snapshot = { utxos: [native, token], history: [], source: 'deterministic-fixture', height: 500 };
  const fetch = vi.fn(async () => { throw new Error('Network disabled in wallet audit tests'); });
  vi.stubGlobal('fetch', fetch);
  const sign = vi.fn<() => Promise<{ signedTransaction: string }>>().mockRejectedValue(new Error('Unexpected signing request'));
  const manager = { isWalletDiscovered: () => true, signTransaction: sign } as unknown as DappConnectionManager;
  const runtime = new WalletRuntime((_wallet, onUpdate) => ({
    refresh: async () => { onUpdate(snapshot); return snapshot; }, close: () => {},
  }));
  runtime.activateSavedProfile({ ...wizardProfile(addresses.receiveAddress, addresses.changeAddress, 'Fixture', 'mainnet', true), profileId: 'fixture' }, undefined, manager, undefined, {
    network: 'mainnet', addresses: [{ address: native.address, index: 0, scope: 'receive' }],
  });
  const profile = await runtime.refreshOnChainBalance();
  // Use the existing two-output fee budget. This test never uses the live deposit or recipient.
  const payment = preparePayment(profile, [{ address: recipient, satoshis: 9562n }], 'LOCAL');
  const signFixture = () => key.signWalletInputs(payment.transaction, payment.sourceOutputs, [{ inputIndex: 0, scope: 'receive' }]);
  return { key, native, token, snapshot, fetch, sign, manager, runtime, profile, payment, signFixture };
}

afterEach(() => vi.unstubAllGlobals());

describe('Wallet payment audit with public test keys and synthetic outpoints', () => {
  it('constructs exact native-only MAX, including a conservative fee for the signed size', async () => {
    const { key, native, payment, profile, signFixture, fetch } = await fixture();
    try {
      expect(payment.inputs).toEqual([native]);
      expect(payment.dag.audit.minerFeeSats).toBe(438n);
      expect(payment.transaction.outputs).toEqual([{ valueSatoshis: 9562n, lockingBytecode: (cashAddressToLockingBytecode(recipient) as { bytecode: Uint8Array }).bytecode }]);
      expect(payment.dag.outputs[0]).toMatchObject({ address: recipient, satoshis: 9562n, isChange: false });
      expect(satsToBchString(payment.dag.outputs[0].satoshis, 8)).toBe('0.00009562');
      const appSource = readFileSync(resolve(import.meta.dirname, '../App.tsx'), 'utf8');
      const batchSource = readFileSync(resolve(import.meta.dirname, '../components/PayrollBatchSender.tsx'), 'utf8');
      expect(appSource).toContain('satsToBchString(profile.balanceSats, 8)');
      expect(batchSource).not.toMatch(/satsToBchString\(\s*summary\.totalSatoshis,\s*4\s*\)/);
      const signed = signFixture();
      expect(createVirtualMachineBCH().verify({ transaction: signed, sourceOutputs: payment.sourceOutputs })).toBe(true);
      expect(encodeTransaction(signed)).toHaveLength(185);
      expect(payment.dag.audit.minerFeeSats).toBeGreaterThanOrEqual(2n * BigInt(encodeTransaction(signed).length));
      expect(() => preparePayment(profile, [{ address: 'bchtest:' + recipient.split(':')[1], satoshis: 9562n }], 'LOCAL')).toThrow(/Invalid mainnet recipient/);
      expect(fetch).not.toHaveBeenCalled();
    } finally { key.lock(); }
  });

  it('rejects changed destination bytes before requesting an external signature', async () => {
    const { key, payment, native, fetch, sign, runtime } = await fixture();
    try {
      const destination = cashAddressToLockingBytecode(native.address);
      if (typeof destination === 'string') throw Error(destination);
      payment.transaction.outputs[0].lockingBytecode = destination.bytecode;
      await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/reviewed output/i);
      expect(sign).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { key.lock(); }
  });

  it('rejects a resolved signing response if the session was invalidated before it could be used', async () => {
    const { key, payment, manager, runtime, fetch, sign, signFixture } = await fixture();
    try {
      const signedTransaction = binToHex(encodeTransaction(signFixture()));
      let answer!: (value: { signedTransaction: string }) => void;
      sign.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
      const pending = runtime.signPreparedPayment(payment);
      const rejected = expect(pending).rejects.toThrow(/disconnected during signing/i);
      await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
      answer({ signedTransaction });
      runtime.updateWizardAvailability(manager, false);
      runtime.updateWizardAvailability(manager, true);
      await rejected;
      expect(fetch).not.toHaveBeenCalled();
    } finally { key.lock(); }
  });

  it('checks unspent inputs again after an external wallet finishes signing', async () => {
    const { key, payment, token, snapshot, runtime, fetch, sign, signFixture } = await fixture();
    try {
      const signedTransaction = binToHex(encodeTransaction(signFixture()));
      let answer!: (value: { signedTransaction: string }) => void;
      sign.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
      const pending = runtime.signPreparedPayment(payment);
      const rejected = expect(pending).rejects.toThrow(/no longer spendable/i);
      await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
      snapshot.utxos = [token];
      answer({ signedTransaction });
      await rejected;
      expect(fetch).not.toHaveBeenCalled();
    } finally { key.lock(); }
  });

  it('binds a pending signature to a specific activation even across a rapid switch away and back', async () => {
    const { key, payment, profile, manager, runtime, fetch, sign, signFixture } = await fixture();
    const other = new BchWalletService();
    try {
      const signedTransaction = binToHex(encodeTransaction(signFixture()));
      const otherAddresses = other.importLocalWallet(publicVector, 'mainnet', 1);
      let answer!: (value: { signedTransaction: string }) => void;
      sign.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
      const pending = runtime.signPreparedPayment(payment);
      const rejected = expect(pending).rejects.toThrow(/wallet changed/i);
      await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
      runtime.setLocalProfile(otherAddresses, false, other);
      runtime.activateSavedProfile(profile, undefined, manager, undefined, {
        network: 'mainnet', addresses: [{ address: profile.receiveAddress, scope: 'receive', index: 0 }],
      });
      answer({ signedTransaction });
      await rejected;
      expect(fetch).not.toHaveBeenCalled();
    } finally { key.lock(); other.lock(); }
  });

  it('rejects repeated outpoints before it reaches the signer', async () => {
    const { key, payment, fetch, sign, runtime } = await fixture();
    try {
      payment.inputs.push(payment.inputs[0]);
      payment.sourceOutputs.push(payment.sourceOutputs[0]);
      payment.transaction.inputs.push(payment.transaction.inputs[0]);
      payment.dag.inputs.push({ ...payment.dag.inputs[0], inputIndex: 1 });
      payment.dag.audit.minerFeeSats += payment.inputs[0].satoshis;
      await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/duplicate input/i);
      expect(sign).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { key.lock(); }
  });

  it('rejects signatures that do not commit to all the reviewed outputs', async () => {
    const { key, payment, fetch, sign, runtime } = await fixture();
    const root = deriveHdPrivateNodeFromBip39Mnemonic(publicVector);
    const child = deriveHdPath(root, "m/44'/145'/0'/0/0");
    try {
      if (typeof child === 'string') throw Error(child);
      const signingType = Uint8Array.of(0x62); // SIGHASH_NONE, UTXOS and FORKID
      const enc = generateSigningSerializationBCH({
        transaction: payment.transaction, sourceOutputs: payment.sourceOutputs, inputIndex: 0,
      }, { coveredBytecode: payment.sourceOutputs[0].lockingBytecode, signingSerializationType: signingType });
      const sig = secp256k1.signMessageHashSchnorr(child.privateKey, hash256(enc));
      const pub = secp256k1.derivePublicKeyCompressed(child.privateKey);
      if (typeof sig === 'string' || typeof pub === 'string') throw Error('Fixture signing failed.');
      const signed = structuredClone(payment.transaction);
      signed.inputs[0].unlockingBytecode = Uint8Array.from([65, ...sig, ...signingType, 33, ...pub]);
      expect(createVirtualMachineBCH().verify({ transaction: signed, sourceOutputs: payment.sourceOutputs })).toBe(true);
      sign.mockResolvedValue({ signedTransaction: binToHex(encodeTransaction(signed)) });
      await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/commit to all/i);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      root.privateKey.fill(0);
      if (typeof child !== 'string') child.privateKey.fill(0);
      key.lock();
    }
  });

  it('rejects concurrent signing requests before revalidating or contacting the signer a second time', async () => {
    const { key, payment, manager, runtime, fetch, sign } = await fixture();
    try {
      let answer!: (value: { signedTransaction: string }) => void;
      sign.mockImplementation(() => new Promise(resolve => { answer = resolve; }));
      const first = runtime.signPreparedPayment(payment);
      const rejectedFirst = expect(first).rejects.toThrow(/disconnected during signing/i);
      await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/current.*signing request/i);
      await vi.waitFor(() => expect(sign).toHaveBeenCalledTimes(1));
      runtime.updateWizardAvailability(manager, false);
      answer({ signedTransaction: '' });
      await rejectedFirst;
      expect(sign).toHaveBeenCalledTimes(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally { key.lock(); }
  });

  it('rejects incomplete or malformed WizardConnect wallet_ready paths before reaching the SDK or console', async () => {
    const root = deriveHdPrivateNodeFromBip39Mnemonic(publicVector);
    const receiveNode = deriveHdPath(root, "m/44'/145'/0'/0");
    const changeNode = deriveHdPath(root, "m/44'/145'/0'/1");
    if (typeof receiveNode === 'string' || typeof changeNode === 'string') throw new Error('Derivation failed');
    const receiveXpub = encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(receiveNode) }).hdPublicKey;
    const changeXpub = encodeHdPublicKey({ network: 'mainnet', node: deriveHdPublicNode(changeNode) }).hdPublicKey;
    const chipnetXpub = encodeHdPublicKey({ network: 'testnet', node: deriveHdPublicNode(receiveNode) }).hdPublicKey;
    root.privateKey.fill(0);
    receiveNode.privateKey.fill(0);
    changeNode.privateKey.fill(0);

    let client!: RelayClient;
    vi.stubGlobal('navigator', { onLine: false });
    const onInvalidReady = vi.fn();
    const relay = createWizardRelay(({ client: current }) => { client = current; }, onInvalidReady);
    relay.start();
    const received = vi.fn();
    client.on('message', received);
    try {
      const base = {
        action: RelayMsgAction.WalletReady,
        wallet_name: 'Fixture Wallet',
        wallet_icon: '',
        dapp_discovered: true,
        supported_protocols: ['hdwalletv1'],
        public_key: '11'.repeat(32),
        secret: relay.credentials.secret,
        time: Math.floor(Date.now() / 1000),
      };
      // 1. Incomplete paths (missing change branch)
      expect(client.emit('message', { ...base, session: { hdwalletv1: { paths: [{ name: 'receive', xpub: receiveXpub }] } } })).toBe(false);
      // 2. Malformed xpub string
      expect(client.emit('message', {
        ...base,
        session: { hdwalletv1: { paths: [{ name: 'receive', xpub: 'not-an-xpub-secret' }, { name: 'change', xpub: changeXpub }] } },
      })).toBe(false);
      // 3. Testnet xpub on Mainnet pairing
      expect(client.emit('message', {
        ...base,
        session: { hdwalletv1: { paths: [{ name: 'receive', xpub: chipnetXpub }, { name: 'change', xpub: changeXpub }] } },
      })).toBe(false);
      // 4. Duplicate / identical receive and change xpub
      expect(client.emit('message', {
        ...base,
        session: { hdwalletv1: { paths: [{ name: 'receive', xpub: receiveXpub }, { name: 'change', xpub: receiveXpub }] } },
      })).toBe(false);
      expect(onInvalidReady).toHaveBeenCalledTimes(4);
      expect(received).not.toHaveBeenCalled();

      // 5. Empty paths (staged phone approval) and valid Mainnet paths are permitted
      expect(client.emit('message', { ...base, session: { hdwalletv1: { paths: [] } } })).toBe(true);
      expect(client.emit('message', {
        ...base,
        session: { hdwalletv1: { paths: [{ name: 'receive', xpub: receiveXpub }, { name: 'change', xpub: changeXpub }] } },
      })).toBe(true);
      expect(received).toHaveBeenCalledTimes(2);
    } finally {
      await relay.close();
    }
  });
});
