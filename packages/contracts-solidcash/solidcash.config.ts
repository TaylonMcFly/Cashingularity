/**
 * SolidCash Compiler & Composition Configuration (BCH BLAZE 2026)
 * Supports `direct` (default single-contract P2SH32 covenant) and `framed`
 * (multi-contract message-bus / kernel composition) conventions.
 */

export interface SolidCashProjectConfig {
  compilerVersion: string;
  sourceExtension: '.scash';
  contractsDir: string;
  artifactsDir: string;
  compositionConvention: 'direct' | 'framed';
  targetVm: 'BCH_2026_05';
  enforceCashTokensPreDrainOnSelfDestruct: true;
}

export const solidcashConfig: SolidCashProjectConfig = {
  compilerVersion: '0.50.0',
  sourceExtension: '.scash',
  contractsDir: './contracts',
  artifactsDir: './artifacts',
  compositionConvention: 'direct',
  targetVm: 'BCH_2026_05',
  enforceCashTokensPreDrainOnSelfDestruct: true,
};

export default solidcashConfig;
