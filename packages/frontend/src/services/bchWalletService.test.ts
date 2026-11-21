import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cashAddressToLockingBytecode,
  binToHex,
  createVirtualMachineBCH,
  hashTransaction,
  hexToBin,
  encodeTransaction,
} from "@bitauth/libauth";
import {
  buildVerifiableContractTransaction,
  compileInactivityVaultContract,
  compilePredictionPoolContract,
  compilePullRewardClaimContract,
  extractPkhHexFromCashAddr,
  INACTIVITY_VAULT_CONTRACT,
  PREDICTION_POOL_CONTRACT,
  PULL_REWARD_CLAIM_CONTRACT,
} from "@cashingularity/contracts-cashscript";
import { deriveP2sh32CashAddr, type WalletUtxo } from "@cashingularity/shared";
import { BchWalletService, bchWalletService } from "./bchWalletService.js";
import {
  materializePreparedContractPayment,
  preparePayment,
} from "./paymentService.js";
import { WalletRuntime, type ConnectedWalletProfile } from "./walletRuntime.js";
import type { AccountChainSnapshot } from './walletChainSync.js';

const mnemonic = "abandon ".repeat(11) + "about"; // Public zero-entropy BIP39 test vector.
const mainnet = "mainnet" as const;
const chainSnapshot = (utxos: WalletUtxo[]): AccountChainSnapshot => ({
  utxos, source: 'test', height: 500,
  history: utxos.map(utxo => ({ txid: utxo.txid, height: 499 })),
});
const runtimeWithUtxos = (lookup: () => WalletUtxo[]) => new WalletRuntime((_wallet, update) => ({
  async refresh() { const snapshot = chainSnapshot(lookup()); update(snapshot); return snapshot; },
  close() {},
}));
afterEach(() => {
  bchWalletService.lock();
  vi.unstubAllGlobals();
});
describe("local BCH wallet", () => {
  it("derives the standard BCH BIP44 receive and change keys from a known BIP39 vector", () => {
    const service = new BchWalletService();
    const addresses = service.importLocalWallet(mnemonic, mainnet);
    const receive = cashAddressToLockingBytecode(addresses.receiveAddress);
    const change = cashAddressToLockingBytecode(addresses.changeAddress);
    if (typeof receive === "string" || typeof change === "string")
      throw new Error("Invalid address");
    expect(binToHex(receive.bytecode)).toBe(
      "76a914086a977c7dad32a56996af2ce90a727238d4899888ac",
    );
    expect(binToHex(change.bytecode)).toBe(
      "76a914cfdcdfa3e0483ddd3c7b6ab6ee13c5087c26d5f188ac",
    );
    expect(addresses.receiveTokenAddress.startsWith("bitcoincash:z")).toBe(
      true,
    );
    expect(
      service
        .importLocalWallet(mnemonic, "chipnet")
        .receiveAddress.startsWith("bchtest:q"),
    ).toBe(true);
    expect(
      service
        .importLocalWallet(`${"abandon ".repeat(23)}art`, mainnet)
        .receiveAddress.startsWith("bitcoincash:q"),
    ).toBe(true);
    expect(() =>
      service.importLocalWallet(mnemonic.replace("about", "abandon"), mainnet),
    ).toThrow(/checksum/);
    expect(() =>
      service.importLocalWallet("foo ".repeat(12), mainnet),
    ).toThrow();
    service.lock();
    expect(service.getAddresses()).toBeNull();
  });
  it("generates a valid twelve word phrase using secure entropy", () => {
    vi.stubGlobal("isSecureContext", true);
    const service = new BchWalletService();
    const phrase = service.createLocalWallet();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(
      service
        .importLocalWallet(phrase, mainnet)
        .receiveAddress.startsWith("bitcoincash:q"),
    ).toBe(true);
    service.lock();
  });
  it("signs a reviewed payment and does not select CashToken UTXOs", () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, mainnet);
    const profile: ConnectedWalletProfile = {
      ...addresses,
      connectionType: "BUILTIN_HD_XO",
      walletLabel: "HD",
      isConnected: true,
      receiveDerivationPath: "m/44'/145'/0'/0/0",
      changeDerivationPath: "m/44'/145'/0'/1/0",
      balanceSats: 200000n,
      utxoSource: "test",
      utxos: [
        {
          txid: "11".repeat(32),
          vout: 0,
          satoshis: 100000n,
          address: addresses.receiveAddress,
          tokenAddress: addresses.receiveTokenAddress,
          derivationScope: "receive",
          addressIndex: 0,
          isGenesisCapable: true,
        },
        {
          txid: "22".repeat(32),
          vout: 1,
          satoshis: 100000n,
          address: addresses.receiveAddress,
          tokenAddress: addresses.receiveTokenAddress,
          derivationScope: "receive",
          addressIndex: 0,
          isGenesisCapable: false,
          token: { categoryId: "aa".repeat(32), amount: 1n },
        },
      ],
    };
    const payment = preparePayment(
      profile,
      [{ address: addresses.changeAddress, satoshis: 25000n }],
      "LOCAL",
    );
    expect(payment.inputs).toHaveLength(1);
    expect(payment.inputs[0].txid).toBe("11".repeat(32));
    const signed = bchWalletService.signPayment(
      payment.transaction,
      payment.sourceOutputs,
      ["receive"],
    );
    expect(
      createVirtualMachineBCH().verify({
        transaction: signed,
        sourceOutputs: payment.sourceOutputs,
      }),
    ).toBe(true);
    expect(() =>
      preparePayment(
        profile,
        [{ address: addresses.changeAddress, satoshis: 200000n }],
        "LOCAL",
      ),
    ).toThrow(/Insufficient/);
    const recovered = preparePayment(profile, [{ address: addresses.changeAddress, satoshis: 120000n }], 'LOCAL');
    expect(recovered.transaction.outputs.filter(output => output.token).map(output => output.token?.amount)).toEqual([1n]);
    const signedWithTokenChange = bchWalletService.signPayment(recovered.transaction, recovered.sourceOutputs, ['receive', 'receive']);
    expect(createVirtualMachineBCH().verify({ transaction: signedWithTokenChange, sourceOutputs: recovered.sourceOutputs })).toBe(true);
    profile.utxos.push({
      txid: "77".repeat(32),
      vout: 0,
      satoshis: 50000n,
      address: addresses.changeAddress,
      tokenAddress: addresses.changeTokenAddress,
      derivationScope: "change",
      addressIndex: 0,
      isGenesisCapable: true,
    });
    const multi = preparePayment(
      profile,
      [{ address: addresses.changeAddress, satoshis: 140000n }],
      "LOCAL",
    );
    expect(multi.inputs).toHaveLength(2);
    const signedMulti = bchWalletService.signPayment(
      multi.transaction,
      multi.sourceOutputs,
      multi.inputs.map((u) =>
        u.derivationScope === "change" ? "change" : "receive",
      ),
    );
    expect(
      createVirtualMachineBCH().verify({
        transaction: signedMulti,
        sourceOutputs: multi.sourceOutputs,
      }),
    ).toBe(true);
  });
  it("broadcasts a locally verified payment signed by a discovered change key", async () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, mainnet);
    const inputAddress = bchWalletService.getAddress('change', 9);
    const lookup = vi.fn((): WalletUtxo[] => [{
      txid: '33'.repeat(32), vout: 0, satoshis: 100000n, address: inputAddress, tokenAddress: inputAddress,
      derivationScope: 'change', addressIndex: 9, isGenesisCapable: true,
    }]);
    const runtime = runtimeWithUtxos(lookup);
    runtime.setLocalProfile(addresses);
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const body = String(init?.body || "");
        calls.push({ url, body });
        const payload = JSON.parse(body) as { rawTxHex: string };
        return new Response(
          JSON.stringify({ txid: hashTransaction(hexToBin(payload.rawTxHex)) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const synced = await runtime.refreshOnChainBalance();
    expect(synced.balanceSats).toBe(100000n);
    const payment = preparePayment(
      synced,
      [{ address: addresses.changeAddress, satoshis: 25000n }],
      "LOCAL",
    );
    const result = await runtime.signPreparedPayment(payment);
    expect(result.broadcasted).toBe(true);
    expect(result.txid).toHaveLength(64);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(result.wizardRequest.inputPaths).toEqual([[0, 'change', 9]]);
    expect(calls.filter((c) => c.url.includes("/broadcast")).length).toBe(1);
    expect(JSON.stringify(calls)).not.toContain(mnemonic);
    expect(JSON.stringify(calls)).not.toContain("privateKey");
  });
  it("refuses to sign stale or token-bearing outpoints after refresh", async () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, mainnet);
    let token = false;
    const runtime = runtimeWithUtxos(() => [{
      txid: '44'.repeat(32), vout: 0, satoshis: 100000n, address: addresses.receiveAddress, tokenAddress: addresses.receiveTokenAddress,
      derivationScope: 'receive', addressIndex: 0, isGenesisCapable: true,
      ...(token ? { token: { categoryId: 'aa'.repeat(32), amount: 1n } } : {}),
    }]);
    runtime.setLocalProfile(addresses);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const synced = await runtime.refreshOnChainBalance();
    const payment = preparePayment(
      synced,
      [{ address: addresses.changeAddress, satoshis: 25000n }],
      "LOCAL",
    );
    token = true;
    await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(
      /changed/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a WizardConnect response that changes the reviewed payment", async () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, mainnet);
    const runtime = runtimeWithUtxos(() => [{
      txid: '55'.repeat(32), vout: 0, satoshis: 100000n, address: addresses.receiveAddress, tokenAddress: addresses.receiveTokenAddress,
      derivationScope: 'receive', addressIndex: 0, isGenesisCapable: true,
    }]);
    runtime.setLocalProfile(addresses);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const profile = await runtime.refreshOnChainBalance();
    const payment = preparePayment(
      profile,
      [{ address: addresses.changeAddress, satoshis: 25000n }],
      "LOCAL",
    );
    const changed = bchWalletService.signPayment(
      payment.transaction,
      payment.sourceOutputs,
      ["receive"],
    );
    changed.outputs[0].valueSatoshis += 1n;
    const manager = {
      getXpubNode: () => undefined,
      isWalletDiscovered: () => true,
      signTransaction: vi.fn(async () => ({
        signedTransaction: binToHex(encodeTransaction(changed)),
      })),
    };
    runtime.setWizardProfile(
      addresses.receiveAddress,
      addresses.changeAddress,
      "External",
      mainnet,
      manager as never,
      true,
    );
    await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(
      /changed the reviewed transaction/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects an expired fiat quote before requesting or broadcasting a transaction", async () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, mainnet);
    const runtime = new WalletRuntime();
    runtime.setLocalProfile(addresses);
    const profile: ConnectedWalletProfile = {
      ...runtime.getAddresses(),
      utxoSource: "test",
      utxos: [
        {
          txid: "88".repeat(32),
          vout: 0,
          satoshis: 100000n,
          address: addresses.receiveAddress,
          tokenAddress: addresses.receiveTokenAddress,
          derivationScope: "receive",
          addressIndex: 0,
          isGenesisCapable: true,
        },
      ],
    };
    const payment = preparePayment(
      profile,
      [{ address: addresses.changeAddress, satoshis: 25000n }],
      "LOCAL",
    );
    payment.quote = {
      id: "expired",
      expiresAtMs: Date.now() - 1,
      source: "test",
      rows: [],
    };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(
      /expired/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards an in-flight snapshot for a deselected account", async () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, mainnet);
    let complete!: () => void;
    const runtime = new WalletRuntime((_wallet, update) => ({
      refresh: () => new Promise(resolve => { complete = () => { const next = chainSnapshot([]); update(next); resolve(next); }; }),
      close() {},
    }));
    runtime.setLocalProfile(addresses);
    const refresh = runtime.refreshOnChainBalance();
    const selected = runtime.setWatchProfile(addresses.changeAddress, mainnet, 'Another account');
    complete();
    await expect(refresh).rejects.toThrow(/wallet changed/i);
    expect(runtime.getAddresses()).toBe(selected);
    expect(runtime.getAddresses().chainHistory).toBeUndefined();
  });
  it("never converts an illustrative contract preview into a BCH payment", async () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, mainnet);
    const runtime = new WalletRuntime();
    runtime.setLocalProfile(addresses);
    const profile: ConnectedWalletProfile = {
      ...runtime.getAddresses(),
      utxoSource: "test",
      utxos: [
        {
          txid: "99".repeat(32),
          vout: 0,
          satoshis: 100000n,
          address: addresses.receiveAddress,
          tokenAddress: addresses.receiveTokenAddress,
          derivationScope: "receive",
          addressIndex: 0,
          isGenesisCapable: true,
        },
      ],
    };
    const dag = preparePayment(
      profile,
      [{ address: addresses.changeAddress, satoshis: 25000n }],
      "LOCAL",
    ).dag;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const engineTrack of [
      "CASHSCRIPT_WIZARD",
      "XO_INVITATION",
      "SOLIDCASH_SCASH",
    ] as const) {
      await expect(
        runtime.signAndBroadcast({
          dag,
          mode: "MAINNET_MODE",
          engineTrack,
          userPrompt: "Review contract",
        }),
      ).rejects.toThrow(/illustrative preview/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a wallet-only P2SH32 and genesis NFT template as a prediction contract", () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, "chipnet");
    const runtime = new WalletRuntime();
    runtime.setLocalProfile(addresses);

    const txidGenesis = "77".repeat(32);
    const utxos = [
      {
        txid: txidGenesis,
        vout: 0,
        satoshis: 150_000n,
        address: addresses.receiveAddress,
        tokenAddress: addresses.receiveTokenAddress,
        derivationScope: "receive" as const,
        addressIndex: 0,
        isGenesisCapable: true,
      },
    ];

    const pool = deriveP2sh32CashAddr("market-1-test", "chipnet");
    const built = buildVerifiableContractTransaction({
      contractType: "PREDICTION_STAKE",
      network: "chipnet",
      covenantAddress: pool.standardAddress,
      covenantLockingBytecodeHex: pool.lockingBytecodeHex,
      commitAmountSats: 25_000n,
      walletUtxos: utxos,
      userAddress: addresses.receiveAddress,
      userTokenAddress: addresses.receiveTokenAddress,
      userChangeAddress: addresses.changeAddress,
      nftCommitmentHex: "000000010100000000000061a8",
      covenantOpcodes: PREDICTION_POOL_CONTRACT.covenantOpcodes,
      aiExplanation: "PredictionPool Market #1",
      analysisMode: "LOCAL",
    });

    const profile: ConnectedWalletProfile = {
      ...runtime.getAddresses(),
      utxoSource: "test",
      utxos,
    };
    expect(built.transactionTemplate.transaction.inputs).toHaveLength(1);
    expect(built.transactionTemplate.transaction.outputs[0].lockingBytecodeHex).toBe(pool.lockingBytecodeHex);
    expect(() => materializePreparedContractPayment(built.transactionTemplate, built.dag, profile)).toThrow(/No covenant input/);

  });
  it('never broadcasts a contract-labelled ordinary payment', async () => {
    const addresses=bchWalletService.importLocalWallet(mnemonic,mainnet);const runtime=new WalletRuntime();runtime.setLocalProfile(addresses);
    const profile:ConnectedWalletProfile={...runtime.getAddresses(),utxoSource:'test',utxos:[{txid:'aa'.repeat(32),vout:0,satoshis:100000n,address:addresses.receiveAddress,tokenAddress:addresses.receiveTokenAddress,derivationScope:'receive',addressIndex:0,isGenesisCapable:true}]};
    const payment=preparePayment(profile,[{address:addresses.changeAddress,satoshis:25000n}],'LOCAL');payment.contractType='PREDICTION_STAKE';
    const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/independently verified/);expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a review from a different profile even when its BCH address matches', async () => {
    const signer = new BchWalletService();
    const addresses = signer.importLocalWallet(mnemonic, mainnet);
    const runtime = new WalletRuntime();
    const first = runtime.setLocalProfile(addresses, false, signer);
    first.profileId = 'first';
    const utxos = [{
      txid: 'ab'.repeat(32), vout: 0, satoshis: 15_000n, address: addresses.receiveAddress,
      tokenAddress: addresses.receiveTokenAddress, derivationScope: 'receive' as const, addressIndex: 0, isGenesisCapable: true,
    }];
    const payment = preparePayment({ ...first, utxos, utxoSource: 'fixture' }, [{ address: addresses.changeAddress, satoshis: 5000n }], 'LOCAL');
    runtime.activateSavedProfile({ ...first, profileId: 'second' }, signer);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runtime.signPreparedPayment(payment)).rejects.toThrow('Wallet changed. Prepare the payment again.');
    expect(fetchMock).not.toHaveBeenCalled();
    signer.lock();
  });

  it('requires signing authority before refreshing or broadcasting a prepared payment', async () => {
    const signer = new BchWalletService();
    const addresses = signer.importLocalWallet(mnemonic, mainnet);
    const openChain = vi.fn(() => { throw new Error('The balance refresh should never be started.'); });
    const runtime = new WalletRuntime(openChain);
    const profile = runtime.setLocalProfile(addresses, false, signer);
    const payment = preparePayment({ ...profile, utxoSource: 'fixture', utxos: [{
      txid: '55'.repeat(32), vout: 0, satoshis: 15_000n, address: addresses.receiveAddress,
      tokenAddress: addresses.receiveTokenAddress, derivationScope: 'receive', addressIndex: 0, isGenesisCapable: true,
    }] }, [{ address: addresses.changeAddress, satoshis: 5_000n }], 'LOCAL');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    runtime.setWatchProfile(addresses.receiveAddress, mainnet, 'Watch-only BCH');
    await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/watch-only/);
    const signTransaction = vi.fn();
    const manager = { isWalletDiscovered: () => true, signTransaction };
    runtime.setWizardProfile(addresses.receiveAddress, addresses.changeAddress, 'External', mainnet, manager as never);
    await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/External wallet offline/);
    runtime.setExtensionProfile(addresses.receiveAddress, addresses.changeAddress, 'Address-only extension', mainnet, {
      key: 'bitcoinCash', name: 'Address-only extension', getAddresses: async () => [addresses.receiveAddress],
    });
    await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/does not provide a signing method/);
    runtime.setLocalProfile(addresses, false, signer);
    signer.lock();
    await expect(runtime.signPreparedPayment(payment)).rejects.toThrow(/Unlock this wallet/);
    expect(signTransaction).not.toHaveBeenCalled();
    expect(openChain).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recovery-verifies a 1,000-sat prepared stake without adding illustrative pool funds', async () => {
    const signer = new BchWalletService();
    const addresses = signer.importLocalWallet(mnemonic, mainnet);
    const runtime = new WalletRuntime();
    const wallet = runtime.setLocalProfile(addresses, undefined, signer);
    const utxos = [{ txid: '77'.repeat(32), vout: 0, satoshis: 3000n,
      address: addresses.receiveAddress, tokenAddress: addresses.receiveTokenAddress,
      derivationScope: 'receive' as const, addressIndex: 0, isGenesisCapable: true }];
    const pool = compilePredictionPoolContract({
      marketId: 1, bucketId: 0, network: mainnet,
      predictorPkhHex: extractPkhHexFromCashAddr(addresses.receiveAddress),
    });
    const built = buildVerifiableContractTransaction({
      contractType: 'PREDICTION_STAKE', network: mainnet, commitAmountSats: 1000n,
      covenantAddress: pool.covenantAddress, covenantLockingBytecodeHex: pool.lockingBytecodeHex,
      covenantProof: pool.covenantProof, walletUtxos: utxos,
      userAddress: addresses.receiveAddress, userTokenAddress: addresses.receiveTokenAddress,
      userChangeAddress: addresses.changeAddress, nftCommitmentHex: '000000010000000000000003e8',
      covenantOpcodes: [], aiExplanation: 'Funding preview',
    });
    const prepared = materializePreparedContractPayment(
      built.transactionTemplate, built.dag, { ...wallet, utxos, utxoSource: 'fixture' }, signer
    );
    expect(prepared.transaction.outputs.map(output => output.valueSatoshis)).toEqual([1000n, 690n, 890n]);
    expect(prepared.dag.audit.minerFeeSats).toBe(420n);
    const signed = signer.signPayment(prepared.transaction, prepared.sourceOutputs, ['receive']);
    expect(createVirtualMachineBCH().verify({ transaction: signed, sourceOutputs: prepared.sourceOutputs })).toBe(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(runtime.signPreparedPayment(prepared)).rejects.toThrow(/independently verified settlement contract/);
    expect(fetchMock).not.toHaveBeenCalled();
    signer.lock();
  });

  it("verifies recovery but refuses to broadcast contracts without verified on-chain semantics", async () => {
    const addresses = bchWalletService.importLocalWallet(mnemonic, "chipnet");
    const runtime = new WalletRuntime();
    runtime.setLocalProfile(addresses);
    const pkhHex = extractPkhHexFromCashAddr(addresses.receiveAddress);

    const txidGenesis = "77".repeat(32);
    const utxos = [
      {
        txid: txidGenesis,
        vout: 0,
        satoshis: 150_000n,
        address: addresses.receiveAddress,
        tokenAddress: addresses.receiveTokenAddress,
        derivationScope: "receive" as const,
        addressIndex: 0,
        isGenesisCapable: true,
      },
    ];
    const profile: ConnectedWalletProfile = {
      ...runtime.getAddresses(),
      utxoSource: "test",
      utxos,
    };

    const contracts = [
      {
        type: "PREDICTION_STAKE" as const,
        compiled: compilePredictionPoolContract({
          marketId: 1,
          bucketId: 1,
          predictorPkhHex: pkhHex,
          network: "chipnet",
        }),
        opcodes: PREDICTION_POOL_CONTRACT.covenantOpcodes,
        nftCommitmentHex: "000000010100000000000061a8",
        amount: 25_000n,
      },
      {
        type: "INACTIVITY_VAULT" as const,
        compiled: compileInactivityVaultContract({
          ownerPkhHex: pkhHex,
          beneficiaryPkhHex: "22".repeat(20),
          inactivityBlocks: 4320,
          network: "chipnet",
        }),
        opcodes: INACTIVITY_VAULT_CONTRACT.covenantOpcodes,
        nftCommitmentHex: undefined,
        amount: 10_000n,
      },
      {
        type: "PULL_REWARD_CLAIM" as const,
        compiled: compilePullRewardClaimContract({
          categoryId: "f1".repeat(32),
          currentEpoch: 14,
          contributorPkhHex: pkhHex,
          network: "chipnet",
        }),
        opcodes: PULL_REWARD_CLAIM_CONTRACT.covenantOpcodes,
        nftCommitmentHex: undefined,
        amount: 2_500n,
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/utxos")) {
          const target = new URL(url, "http://localhost").searchParams.get("address");
          return new Response(
            JSON.stringify({
              source: "test",
              utxos:
                target === addresses.receiveAddress
                  ? [{ txid: txidGenesis, vout: 0, satoshis: "150000" }]
                  : [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const payload = JSON.parse(String(init?.body || "{}")) as { rawTxHex: string };
        return new Response(
          JSON.stringify({ txid: hashTransaction(hexToBin(payload.rawTxHex)) }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    for (const c of contracts) {
      const built = buildVerifiableContractTransaction({
        contractType: c.type,
        network: "chipnet",
        covenantAddress: c.compiled.covenantAddress,
        covenantLockingBytecodeHex: c.compiled.lockingBytecodeHex,
        covenantProof: c.compiled.covenantProof,
        commitAmountSats: c.amount,
        walletUtxos: utxos,
        userAddress: addresses.receiveAddress,
        userTokenAddress: addresses.receiveTokenAddress,
        userChangeAddress: addresses.changeAddress,
        nftCommitmentHex: c.nftCommitmentHex,
        covenantOpcodes: c.opcodes,
        aiExplanation: `Verified ${c.compiled.covenantProof.contractName}`,
        analysisMode: "LOCAL",
      });
      const prepared = materializePreparedContractPayment(
        built.transactionTemplate,
        built.dag,
        profile,
        bchWalletService,
      );
      expect(prepared.covenantProof?.redeemScriptHex).toBe(c.compiled.redeemScriptHex);
      await expect(runtime.signPreparedPayment(prepared)).rejects.toThrow(/independently verified/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
