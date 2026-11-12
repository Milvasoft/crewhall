// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/git-memo/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { GIT_MEMO, filterGitMemo } from './logic';

describe('git-memo', () => {
  it('has grouped commands', () => {
    expect(GIT_MEMO.length).toBeGreaterThan(3);
    expect(GIT_MEMO[0]!.commands.length).toBeGreaterThan(0);
  });

  it('filters by command or description', () => {
    const stash = filterGitMemo('stash');
    expect(stash.flatMap((g) => g.commands).some((c) => c.command.includes('stash'))).toBe(true);

    const undo = filterGitMemo('undo');
    expect(undo.length).toBeGreaterThan(0);
  });

  it('returns everything for an empty query', () => {
    expect(filterGitMemo('')).toBe(GIT_MEMO);
  });

  it('treats a whitespace-only query as empty', () => {
    expect(filterGitMemo('   ')).toBe(GIT_MEMO);
  });

  it('matches case-insensitively', () => {
    const upper = filterGitMemo('STASH');
    const lower = filterGitMemo('stash');
    expect(upper).toEqual(lower);
    expect(upper.length).toBeGreaterThan(0);
  });

  it('returns no groups when nothing matches', () => {
    expect(filterGitMemo('xyzzyfrobnicate')).toEqual([]);
  });

  it('omits groups that have no matching commands', () => {
    const result = filterGitMemo('clone');
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Setup & config');
    expect(result[0]!.commands.some((c) => c.command.includes('clone'))).toBe(true);
  });
});
