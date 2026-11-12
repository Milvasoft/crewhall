// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/config-validator/logic.ts. See THIRD_PARTY.md.
import { load, loadAll } from 'js-yaml';

export type ValidatorMode = 'yaml' | 'docker-compose' | 'kubernetes';

export interface ValidationReport {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateConfig(text: string, mode: ValidatorMode): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!text.trim()) return { valid: false, errors: ['Input is empty.'], warnings };

  // Multi-document is common in Kubernetes.
  let docs: unknown[];
  try {
    docs = mode === 'kubernetes' ? (loadAll(text) as unknown[]) : [load(text)];
  } catch (e) {
    return { valid: false, errors: [`Invalid YAML: ${(e as Error).message}`], warnings };
  }

  if (mode === 'docker-compose') {
    const root = docs[0];
    if (!isRecord(root)) {
      errors.push('Top-level document must be a mapping.');
    } else {
      if (!isRecord(root.services)) {
        errors.push('Missing top-level `services:` mapping.');
      } else {
        for (const [name, svc] of Object.entries(root.services)) {
          if (!isRecord(svc)) {
            errors.push(`Service "${name}" must be a mapping.`);
            continue;
          }
          if (!svc.image && !svc.build) {
            warnings.push(`Service "${name}" has neither \`image\` nor \`build\`.`);
          }
        }
      }
      if ('version' in root) {
        warnings.push('The top-level `version` field is obsolete in the Compose spec.');
      }
    }
  }

  if (mode === 'kubernetes') {
    docs.forEach((doc, i) => {
      const label = docs.length > 1 ? `Document ${i + 1}: ` : '';
      if (!isRecord(doc)) {
        errors.push(`${label}must be a mapping.`);
        return;
      }
      if (!doc.apiVersion) errors.push(`${label}missing \`apiVersion\`.`);
      if (!doc.kind) errors.push(`${label}missing \`kind\`.`);
      const meta = doc.metadata;
      if (!isRecord(meta) || !meta.name) {
        errors.push(`${label}missing \`metadata.name\`.`);
      }
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}
