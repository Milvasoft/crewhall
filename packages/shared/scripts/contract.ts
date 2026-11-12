/**
 * Contract rule check (lint stage):
 *   tsx scripts/contract.ts --check   fails on breaking changes against contract-snapshot.json,
 *                                     or on additions without a raised API_LEVEL
 *   tsx scripts/contract.ts --write   stores the current contract as the release snapshot
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildContract, contractProblems, type ContractSnapshot } from '../src/contract/snapshot';

const file = fileURLToPath(new URL('../contract-snapshot.json', import.meta.url));
const current = buildContract();

if (process.argv.includes('--write')) {
  // One line per endpoint: compact, and a release diff still reads endpoint by endpoint.
  const { endpoints: table, ...meta } = current;
  const lines = Object.entries(table).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );
  const head = JSON.stringify(meta).slice(0, -1);
  writeFileSync(file, `${head},\n "endpoints": {\n${lines.join(',\n')}\n }\n}\n`);
  console.log(`contract snapshot written: ${Object.keys(current.endpoints).length} endpoints`);
} else {
  const old = JSON.parse(readFileSync(file, 'utf8')) as ContractSnapshot;
  const { problems, diff } = contractProblems(old, current);
  if (problems.length) {
    console.error(`contract check failed (${problems.length}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `contract ok: ${diff.additions.length} additions since the snapshot (apiLevel ${old.apiLevel} → ${current.apiLevel})`,
  );
}
