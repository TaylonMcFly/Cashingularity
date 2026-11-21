import { describe, expect, it } from "vitest";
import {
  binToHex,
  cashAddressToLockingBytecode,
  createVirtualMachineBCH,
  hexToBin,
  lockingBytecodeToCashAddress,
  sha256,
  type Output,
  type Transaction,
} from "@bitauth/libauth";
import type { UtxoDagInspection } from "@cashingularity/shared";
import { BchWalletService } from "./bchWalletService.js";
import {
  assertCovenantMatchesPreview,
  verifyCovenantProof,
  type CovenantTemplate,
} from "./paymentService.js";
import type { ConnectedWalletProfile } from "./walletRuntime.js";
const mnemonic = "abandon ".repeat(11) + "about"; // Public zero-entropy BIP39 test vector.
function fixture() {
  const signer = new BchWalletService();
  const addresses = signer.importLocalWallet(mnemonic, "chipnet");
  const walletLock = cashAddressToLockingBytecode(addresses.receiveAddress);
  if (typeof walletLock === "string") throw new Error(walletLock);
  const hash = sha256.hash(sha256.hash(Uint8Array.of(0x51)));
  const contractLock = Uint8Array.from([0xaa, 0x20, ...hash, 0x87]);
  const contractAddress = lockingBytecodeToCashAddress({
    bytecode: contractLock,
    prefix: "bchtest",
  });
  if (typeof contractAddress === "string") throw new Error(contractAddress);
  const category = hexToBin("22".repeat(32));
  const sourceOutputs: Output[] = [
    {
      lockingBytecode: contractLock,
      valueSatoshis: 50000n,
      token: {
        category,
        amount: 0n,
        nft: { capability: "minting", commitment: new Uint8Array() },
      },
    },
    { lockingBytecode: walletLock.bytecode, valueSatoshis: 200000n },
  ];
  const transaction: Transaction = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: hexToBin("33".repeat(32)),
        outpointIndex: 1,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: Uint8Array.of(1, 0x51),
      },
      {
        outpointTransactionHash: hexToBin("44".repeat(32)),
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: new Uint8Array(),
      },
    ],
    outputs: [
      {
        lockingBytecode: contractLock,
        valueSatoshis: 150000n,
        token: {
          category,
          amount: 0n,
          nft: { capability: "minting", commitment: new Uint8Array() },
        },
      },
      {
        lockingBytecode: walletLock.bytecode,
        valueSatoshis: 1000n,
        token: {
          category,
          amount: 0n,
          nft: { capability: "none", commitment: Uint8Array.of(1, 2, 3) },
        },
      },
      { lockingBytecode: walletLock.bytecode, valueSatoshis: 98546n },
    ],
  };
  const token = {
    categoryId: "22".repeat(32),
    amount: 0n,
    nft: { capability: "minting" as const, commitment: "" },
  };
  const dag: UtxoDagInspection = {
    txidPreview: "",
    inputs: [
      {
        inputIndex: 0,
        txid: "33".repeat(32),
        vout: 1,
        satoshis: 50000n,
        address: contractAddress.address,
        isGenesisInput: false,
        token,
        unlockingBytecodeHex: "0151",
      },
      {
        inputIndex: 1,
        txid: "44".repeat(32),
        vout: 0,
        satoshis: 200000n,
        address: addresses.receiveAddress,
        isGenesisInput: true,
      },
    ],
    outputs: [
      {
        index: 0,
        address: contractAddress.address,
        scriptType: "P2SH32",
        lockingBytecodeHex: binToHex(contractLock),
        satoshis: 150000n,
        isChange: false,
        token,
      },
      {
        index: 1,
        address: addresses.receiveTokenAddress,
        scriptType: "P2PKH",
        lockingBytecodeHex: binToHex(walletLock.bytecode),
        satoshis: 1000n,
        isChange: false,
        token: {
          categoryId: "22".repeat(32),
          amount: 0n,
          nft: { capability: "none", commitment: "010203" },
        },
      },
      {
        index: 2,
        address: addresses.receiveAddress,
        scriptType: "P2PKH",
        lockingBytecodeHex: binToHex(walletLock.bytecode),
        satoshis: 98546n,
        isChange: true,
      },
    ],
    audit: {
      disassembledOpcodes: [],
      minerFeeSats: 454n,
      feeRateSatsPerByte: 1,
      dustPassed: true,
      bcmrVerified: false,
      addressReuseDetected: false,
      aiVerdict: "CAUTION",
      aiExplanation: "test",
      analysisMode: "LOCAL",
    },
  };
  const wallet: ConnectedWalletProfile = {
    ...addresses,
    connectionType: "BUILTIN_HD_XO",
    walletLabel: "Test",
    isConnected: true,
    receiveDerivationPath: "m/44'/145'/0'/0/0",
    changeDerivationPath: "m/44'/145'/0'/1/0",
    balanceSats: 200000n,
    utxoSource: "test",
    utxos: [
      {
        txid: "44".repeat(32),
        vout: 0,
        satoshis: 200000n,
        address: addresses.receiveAddress,
        tokenAddress: addresses.receiveTokenAddress,
        derivationScope: "receive",
        addressIndex: 0,
        isGenesisCapable: true,
      },
    ],
  };
  const template: CovenantTemplate = {
    transaction,
    sourceOutputs,
    walletInputs: [{ inputIndex: 1, scope: "receive", addressIndex: 0 }],
    reviewedVersion: 2,
    reviewedLocktime: 0,
    reviewedSequences: [0xffffffff, 0xffffffff],
  };
  return { signer, dag, wallet, template };
}
describe("reviewed covenant transaction templates", () => {
  it("verifies the exact script hash and an owner-signature recovery in CashVM", () => {
    const f = fixture();
    const redeem = cashAddressToLockingBytecode(f.wallet.receiveAddress);
    if (typeof redeem === "string") throw new Error(redeem);
    const hash = binToHex(sha256.hash(sha256.hash(redeem.bytecode)));
    const lockingBytecodeHex = `aa20${hash}87`;
    f.template.transaction.outputs[0].lockingBytecode =
      hexToBin(lockingBytecodeHex);
    f.dag.outputs[0].lockingBytecodeHex = lockingBytecodeHex;
    const address = lockingBytecodeToCashAddress({
      bytecode: hexToBin(lockingBytecodeHex),
      prefix: "bchtest",
    });
    if (typeof address === "string") throw new Error(address);
    f.dag.outputs[0].address = address.address;
    const proof = {
      redeemScriptHex: binToHex(redeem.bytecode),
      scriptHash32Hex: hash,
      lockingBytecodeHex,
    };
    expect(() =>
      verifyCovenantProof(
        proof,
        0,
        f.template.transaction,
        f.dag,
        f.wallet,
        f.signer,
      ),
    ).not.toThrow();
    expect(() =>
      verifyCovenantProof(
        { ...proof, scriptHash32Hex: "00".repeat(32) },
        0,
        f.template.transaction,
        f.dag,
        f.wallet,
        f.signer,
      ),
    ).toThrow(/does not match/);
    const altered = structuredClone(f.dag);
    altered.outputs[0].satoshis++;
    expect(() =>
      verifyCovenantProof(
        proof,
        0,
        f.template.transaction,
        altered,
        f.wallet,
        f.signer,
      ),
    ).toThrow(/does not match/);
    f.signer.lock();
  });
  it("rejects a script that embeds the wallet hash but cannot be recovered", () => {
    const f = fixture();
    const addressScript = cashAddressToLockingBytecode(f.wallet.receiveAddress);
    if (typeof addressScript === "string") throw new Error(addressScript);
    // Pushing the wallet hash and dropping it is not authorization.
    const redeem = Uint8Array.from([
      0x14,
      ...addressScript.bytecode.slice(3, 23),
      0x75,
      0x51,
    ]);
    const hash = binToHex(sha256.hash(sha256.hash(redeem)));
    const lockingBytecodeHex = `aa20${hash}87`;
    f.template.transaction.outputs[0].lockingBytecode =
      hexToBin(lockingBytecodeHex);
    f.dag.outputs[0].lockingBytecodeHex = lockingBytecodeHex;
    const address = lockingBytecodeToCashAddress({
      bytecode: hexToBin(lockingBytecodeHex),
      prefix: "bchtest",
    });
    if (typeof address === "string") throw new Error(address);
    f.dag.outputs[0].address = address.address;
    expect(() =>
      verifyCovenantProof(
        {
          redeemScriptHex: binToHex(redeem),
          scriptHash32Hex: hash,
          lockingBytecodeHex,
        },
        0,
        f.template.transaction,
        f.dag,
        f.wallet,
        f.signer,
      ),
    ).toThrow(/recovery could not be verified/);
    f.signer.lock();
  });
  it("verifies an explicit owner branch and rejects the wrong selector", () => {
    const f = fixture();
    const ownerScript = cashAddressToLockingBytecode(f.wallet.receiveAddress);
    if (typeof ownerScript === "string") throw new Error(ownerScript);
    const redeem = Uint8Array.from([
      0x63,
      ...ownerScript.bytecode,
      0x67,
      0x00,
      0x68,
    ]);
    const hash = binToHex(sha256.hash(sha256.hash(redeem)));
    const lockingBytecodeHex = `aa20${hash}87`;
    f.template.transaction.outputs[0].lockingBytecode =
      hexToBin(lockingBytecodeHex);
    f.dag.outputs[0].lockingBytecodeHex = lockingBytecodeHex;
    const address = lockingBytecodeToCashAddress({
      bytecode: hexToBin(lockingBytecodeHex),
      prefix: "bchtest",
    });
    if (typeof address === "string") throw new Error(address);
    f.dag.outputs[0].address = address.address;
    const proof = {
      redeemScriptHex: binToHex(redeem),
      scriptHash32Hex: hash,
      lockingBytecodeHex,
      spendPathSelectorOpcode: 0x51,
    };
    expect(() =>
      verifyCovenantProof(
        proof,
        0,
        f.template.transaction,
        f.dag,
        f.wallet,
        f.signer,
      ),
    ).not.toThrow();
    expect(() =>
      verifyCovenantProof(
        { ...proof, spendPathSelectorOpcode: 0 },
        0,
        f.template.transaction,
        f.dag,
        f.wallet,
        f.signer,
      ),
    ).toThrow(/recovery could not be verified/);
    f.signer.lock();
  });
  it("matches reviewed fields, signs only wallet inputs, and verifies the complete VM program", () => {
    const { signer, dag, wallet, template } = fixture();
    assertCovenantMatchesPreview(template, dag, wallet);
    const signed = signer.signWalletInputs(
      template.transaction,
      template.sourceOutputs,
      template.walletInputs,
    );
    expect(binToHex(signed.inputs[0].unlockingBytecode)).toBe("0151");
    expect(signed.inputs[1].unlockingBytecode.length).toBeGreaterThan(0);
    expect(
      createVirtualMachineBCH().verify({
        transaction: signed,
        sourceOutputs: template.sourceOutputs,
      }),
    ).toBe(true);
    signer.lock();
  });
  it("rejects changed transaction fields, token details, source data and unlockings", () => {
    const f = fixture();
    const mutations: Array<(t: CovenantTemplate) => void> = [
      (t) => {
        t.transaction.locktime = 1;
      },
      (t) => {
        t.transaction.version = 1;
      },
      (t) => {
        t.transaction.inputs[1].sequenceNumber = 1;
      },
      (t) => {
        t.transaction.inputs[1].outpointIndex = 9;
      },
      (t) => {
        t.sourceOutputs[0].valueSatoshis += 1n;
      },
      (t) => {
        t.sourceOutputs[0].lockingBytecode[4] ^= 1;
      },
      (t) => {
        t.sourceOutputs[0].token!.nft!.capability = "mutable";
      },
      (t) => {
        t.transaction.inputs[0].unlockingBytecode = Uint8Array.of(0);
      },
      (t) => {
        t.transaction.outputs[0].valueSatoshis += 1n;
      },
      (t) => {
        t.transaction.outputs[0].lockingBytecode[2] ^= 1;
      },
      (t) => {
        t.transaction.outputs[1].token!.nft!.commitment = Uint8Array.of(9);
      },
      (t) => {
        t.transaction.outputs[1].token!.nft!.capability = "mutable";
      },
      (t) => {
        t.transaction.outputs[1].token!.category[0] ^= 1;
      },
      (t) => {
        t.transaction.outputs[1].token!.amount = 1n;
      },
      (t) => {
        t.walletInputs[0].scope = "change";
      },
    ];
    for (const mutate of mutations) {
      const altered = structuredClone(f.template);
      mutate(altered);
      expect(() =>
        assertCovenantMatchesPreview(altered, f.dag, f.wallet),
      ).toThrow();
    }
    f.signer.lock();
  });
  it("rejects a preview that mislabels the output script type", () => {
    const f = fixture();
    const preview = structuredClone(f.dag);
    preview.outputs[0].scriptType = "P2PKH";
    expect(() =>
      assertCovenantMatchesPreview(f.template, preview, f.wallet),
    ).toThrow(/script type/);
    f.signer.lock();
  });
  it("rejects an external output falsely labeled as change", () => {
    const f = fixture();
    const preview = structuredClone(f.dag);
    preview.outputs[0].isChange = true;
    expect(() =>
      assertCovenantMatchesPreview(f.template, preview, f.wallet),
    ).toThrow(/change does not belong/);
    f.signer.lock();
  });
  it("fails closed without covenant unlocking bytecode and when VM verification fails", () => {
    const f = fixture();
    const missing = structuredClone(f.dag);
    delete missing.inputs[0].unlockingBytecodeHex;
    expect(() =>
      assertCovenantMatchesPreview(f.template, missing, f.wallet),
    ).toThrow(/unlocking bytecode/);
    const broken = structuredClone(f.template);
    broken.transaction.inputs[0].unlockingBytecode = Uint8Array.of(1, 0x00);
    expect(() =>
      f.signer.signWalletInputs(
        broken.transaction,
        broken.sourceOutputs,
        broken.walletInputs,
      ),
    ).toThrow(/verification failed/);
    f.signer.lock();
  });
  it("rejects a wallet-only payment to an unverified P2SH output", () => {
    const f = fixture();
    const template = structuredClone(f.template);
    const dag = structuredClone(f.dag);
    template.transaction.inputs.shift();
    template.sourceOutputs.shift();
    template.reviewedSequences.shift();
    template.walletInputs[0].inputIndex = 0;
    dag.inputs.shift();
    dag.inputs[0].inputIndex = 0;
    expect(() => assertCovenantMatchesPreview(template, dag, f.wallet)).toThrow(
      /No covenant input/,
    );
    f.signer.lock();
  });
});
