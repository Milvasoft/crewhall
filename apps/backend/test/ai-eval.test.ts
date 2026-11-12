import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE, SCENARIOS, runScenario, startWorld, type EvalWorld } from './ai-eval/harness';

/**
 * The assistant's Turkish eval set (ai-eval/scenarios.ts). In CI it runs against a scripted mock:
 * it measures the server's routing, resolving, carrying and reporting. `pnpm eval:ai` runs the same
 * scenarios against a real model (harness.ts). The pass rate is printed as EVAL_SUMMARY.
 */

let world: EvalWorld;
const outcome: { id: string; area: string; ok: boolean; why?: string }[] = [];

beforeAll(async () => {
  world = await startWorld();
}, 120_000);

afterAll(async () => {
  const passed = outcome.filter((o) => o.ok).length;
  const areas = [...new Set(outcome.map((o) => o.area))].map((area) => {
    const of = outcome.filter((o) => o.area === area);
    return `${area} ${of.filter((o) => o.ok).length}/${of.length}`;
  });
  console.log(
    `EVAL_SUMMARY ${LIVE ? 'live' : 'mock'} ${passed}/${outcome.length} · ${areas.join(' · ')}`,
  );
  for (const o of outcome.filter((x) => !x.ok)) console.log(`EVAL_FAIL ${o.id}: ${o.why}`);
  await world?.close();
});

describe(`assistant eval (${LIVE ? 'live model' : 'mock model'})`, () => {
  for (const scenario of SCENARIOS) {
    it(
      scenario.id,
      async () => {
        try {
          await runScenario(world, scenario);
          outcome.push({ id: scenario.id, area: scenario.area, ok: true });
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          outcome.push({ id: scenario.id, area: scenario.area, ok: false, why });
          throw err;
        }
      },
      LIVE ? 180_000 : 60_000,
    );
  }
});

// Nothing else: a run with no scenarios would look green.
it('has scenarios across the modules', () => {
  expect(new Set(SCENARIOS.map((s) => s.area)).size).toBeGreaterThanOrEqual(7);
  expect(SCENARIOS.length).toBeGreaterThanOrEqual(25);
});
