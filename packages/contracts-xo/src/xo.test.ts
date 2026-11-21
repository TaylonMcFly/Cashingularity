import { describe, expect, it } from 'vitest';
import {
  deserializeInvitation,
  generateTemplateIdentifier,
  parseTemplate,
  serializeInvitation,
} from '@xo-cash/utils';
import type { XOInvitation } from '@xo-cash/types';
import {
  ALLOWED_TEMPLATE_IDENTIFIERS,
  CASHINGULARITY_PREDICTION_TEMPLATE_ID,
  cashingularityPredictionTemplate,
  decodeChipnetAddressToLockingBytecodeHex,
  encodeLockingBytecodeToChipnetAddress,
  loadCashingularityPredictionTemplate,
  P2PKH_TEMPLATE_ID,
  VALIDATED_P2PKH_TEMPLATE,
  verifyAllowedTemplateHash,
  XoBridgeService,
} from './index.js';

describe('@cashingularity/contracts-xo - XOTemplate Migration, Serialization & Sidecar Bridge', () => {
  it('validates xo-prediction-template.json against @xo-cash/utils parseTemplate() and schema rules', () => {
    const loaded = loadCashingularityPredictionTemplate();
    expect(loaded.template.name).toBe('Cashingularity Parimutuel Prediction Pool');
    expect(loaded.templateIdentifier).toBe(CASHINGULARITY_PREDICTION_TEMPLATE_ID);
    expect(loaded.template.supported).toContain('BCH_2026_05');
    expect(loaded.template.resources?.[0]?.url).toContain('PredictionPool.cash');

    // Verify roles: predictor & service
    expect(Object.keys(loaded.template.roles ?? {})).toEqual(['predictor', 'service']);

    // Verify shared pool outputs & lockingScript set selectable: false and predictor relevant: false
    const poolOut = loaded.template.outputs?.poolStakeContinuationOutput;
    expect(poolOut?.selectable).toBe(false);
    expect(poolOut?.roles?.predictor?.relevant).toBe(false);

    const poolLock = loaded.template.lockingScripts?.predictionPoolContract;
    expect(poolLock?.selectable).toBe(false);
    expect(poolLock?.roles?.predictor?.relevant).toBe(false);

    // Verify follow-up actions claimRoundPayout & reclaimExpiredStake with secrets: [{ predictorKey: null }]
    const predictorActions =
      loaded.template.lockingScripts?.predictorReceiptLockingScript?.roles?.predictor?.actions ?? [];
    expect(predictorActions.map((a) => a.action)).toEqual([
      'claimRoundPayout',
      'reclaimExpiredStake',
    ]);
    expect(predictorActions[0].secrets).toEqual([{ predictorKey: null }]);
  });

  it('verifies allowlisted template hashes and rejects tampered templates', () => {
    const p2pkhCheck = verifyAllowedTemplateHash(VALIDATED_P2PKH_TEMPLATE);
    expect(p2pkhCheck.allowed).toBe(true);
    expect(p2pkhCheck.matchedAlias).toBe('p2pkh');
    expect(p2pkhCheck.templateIdentifier).toBe(P2PKH_TEMPLATE_ID);

    const predCheck = verifyAllowedTemplateHash(cashingularityPredictionTemplate);
    expect(predCheck.allowed).toBe(true);
    expect(predCheck.matchedAlias).toBe('cashingularityPrediction');

    const tampered = parseTemplate({
      ...cashingularityPredictionTemplate,
      description: 'Tampered description altering templateIdentifier hash',
    });
    const tamperedCheck = verifyAllowedTemplateHash(tampered);
    expect(tamperedCheck.allowed).toBe(false);
    expect(tamperedCheck.templateIdentifier).not.toBe(
      ALLOWED_TEMPLATE_IDENTIFIERS.cashingularityPrediction
    );
  });

  it('preserves exact commit JSON key ordering and Extended JSON types across serializeInvitation / deserializeInvitation', () => {
    const sampleInvitation: XOInvitation = {
      invitationIdentifier: 'a'.repeat(64),
      templateIdentifier: CASHINGULARITY_PREDICTION_TEMPLATE_ID,
      actionIdentifier: 'placePredictionStake',
      createdAtTimestamp: 1763200000000,
      commits: [
        {
          commitIdentifier: 'b'.repeat(64),
          previousCommitIdentifier: undefined,
          entityIdentifier: 'tpubD6NzVbkrYhZ4XgiXtGrdW5XDAPFCL9h7we1vwNCpn8tGbBcgfVYjXyhWo4E1xkh56hjod1RhGjxbaTLV3X4FyWuejifB9jusQ46QzG87VKp',
          createdAtTimestamp: 1763200000000,
          data: {
            roleIdentifier: 'predictor',
            variables: [
              {
                variableIdentifier: 'stakeSatoshis',
                roleIdentifier: 'predictor',
                value: 10000n,
              },
            ],
            inputs: [
              {
                outpointTransactionHash: new Uint8Array(32).fill(0x11),
                outpointIndex: 0,
              },
            ],
          },
          signature: 'c'.repeat(128),
          expiresAtTimestamp: 1763218000000,
        },
      ],
    };

    const wire = serializeInvitation(sampleInvitation);
    expect(wire).toContain('<bigint: 10000n>');
    expect(wire).toContain('<uint8array: 11111111');

    const restored = deserializeInvitation(wire);
    expect(restored.invitationIdentifier).toBe(sampleInvitation.invitationIdentifier);
    expect(restored.commits[0].data.variables?.[0]?.value).toBe(10000n);
    expect(Object.keys(restored.commits[0].data)).toEqual([
      'roleIdentifier',
      'variables',
      'inputs',
    ]);
  });

  it('enforces Chipnet CashAddr prefix guards and JSON-RPC error boundaries on XoBridgeService', async () => {
    const p2pkhHex = '76a91400112233445566778899aabbccddeeff0011223388ac';
    const chipnetAddr = encodeLockingBytecodeToChipnetAddress(p2pkhHex);
    expect(chipnetAddr.startsWith('bchtest:q')).toBe(true);
    expect(decodeChipnetAddressToLockingBytecodeHex(chipnetAddr)).toBe(p2pkhHex);

    expect(() =>
      decodeChipnetAddressToLockingBytecodeHex(
        'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'
      )
    ).toThrow(/Network prefix mismatch/);

    const bridge = new XoBridgeService();
    const unopenResp = await bridge.handleJsonRpcRequest({
      id: 'req-1',
      method: 'wallet.getReceiveAddress',
    });
    expect(unopenResp.error).toBeDefined();
    expect(unopenResp.error?.message).toContain('not open');

    const badMnemonicResp = await bridge.handleJsonRpcRequest({
      id: 'req-2',
      method: 'wallet.openChipnetAccount',
      params: { mnemonic: 'invalid short seed' },
    });
    expect(badMnemonicResp.error).toBeDefined();
    expect(badMnemonicResp.error?.message).toContain('12 or 24 words');
  });
});
