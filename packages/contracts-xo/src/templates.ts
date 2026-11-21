/**
 * @cashingularity/contracts-xo - Validated XOTemplates & Allowlist Hash Registry
 * BCH BLAZE 2026 - Track B (Build with XO & Migrate a Contract to XO)
 */

import { p2pkhTemplate } from '@xo-cash/templates';
import type { XOTemplate, XOTemplateIdentifier } from '@xo-cash/types';
import {
  generateTemplateIdentifier,
  parseTemplate,
  serializeTemplate,
} from '@xo-cash/utils';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_JSON_PATH = resolve(__dirname, '../xo-prediction-template.json');

/**
 * Loads and validates the Cashingularity Parimutuel Prediction Pool XOTemplate
 * directly from `xo-prediction-template.json` using `@xo-cash/utils` `parseTemplate()`.
 */
export function loadCashingularityPredictionTemplate(): {
  template: XOTemplate;
  templateIdentifier: XOTemplateIdentifier;
  serialized: string;
} {
  const rawJson = readFileSync(TEMPLATE_JSON_PATH, 'utf-8');
  const template = parseTemplate(rawJson);
  const templateIdentifier = generateTemplateIdentifier(template);
  const serialized = serializeTemplate(template);
  return {
    template,
    templateIdentifier,
    serialized,
  };
}

export const cashingularityPredictionTemplate: XOTemplate =
  loadCashingularityPredictionTemplate().template;

export const CASHINGULARITY_PREDICTION_TEMPLATE_ID: XOTemplateIdentifier =
  generateTemplateIdentifier(cashingularityPredictionTemplate);

export const VALIDATED_P2PKH_TEMPLATE: XOTemplate = parseTemplate(p2pkhTemplate);

export const P2PKH_TEMPLATE_ID: XOTemplateIdentifier =
  generateTemplateIdentifier(VALIDATED_P2PKH_TEMPLATE);

/**
 * Audited Template Allowlist mapping template names to deterministic content hashes.
 */
export const ALLOWED_TEMPLATE_IDENTIFIERS: Readonly<Record<string, XOTemplateIdentifier>> =
  Object.freeze({
    p2pkh: P2PKH_TEMPLATE_ID,
    cashingularityPrediction: CASHINGULARITY_PREDICTION_TEMPLATE_ID,
  });

/**
 * Verifies that an incoming or untrusted XOTemplate matches our audited allowlist hash.
 */
export function verifyAllowedTemplateHash(
  untrustedTemplate: string | XOTemplate
): {
  allowed: boolean;
  template: XOTemplate;
  templateIdentifier: XOTemplateIdentifier;
  matchedAlias?: string;
} {
  const parsed = parseTemplate(untrustedTemplate);
  const identifier = generateTemplateIdentifier(parsed);

  for (const [alias, expectedHash] of Object.entries(ALLOWED_TEMPLATE_IDENTIFIERS)) {
    if (identifier === expectedHash) {
      return {
        allowed: true,
        template: parsed,
        templateIdentifier: identifier,
        matchedAlias: alias,
      };
    }
  }

  return {
    allowed: false,
    template: parsed,
    templateIdentifier: identifier,
  };
}
