import { describe, expect, it } from 'vitest';
import {
  can,
  canGrantSpaceRole,
  effectiveNodeRole,
  type Actor,
  type OrgContext,
} from './permissions';

const org: OrgContext = { settings: { membersCanCreateSpaces: false, publicLinksEnabled: true } };
const actor = (orgRole: Actor['orgRole'], orgPermissions: Actor['orgPermissions'] = []): Actor => ({
  userId: 'u1',
  orgRole,
  orgPermissions,
});

describe('can: org', () => {
  it('only owner can transfer or delete the org', () => {
    expect(can(actor('owner'), 'org.delete', { type: 'org', org })).toBe(true);
    expect(can(actor('admin'), 'org.delete', { type: 'org', org })).toBe(false);
  });

  it('admin manages branding and members, member does not', () => {
    expect(can(actor('admin'), 'org.update_branding', { type: 'org', org })).toBe(true);
    expect(can(actor('member'), 'org.manage_members', { type: 'org', org })).toBe(false);
  });

  it('member creates spaces only when the org setting allows it', () => {
    expect(can(actor('member'), 'org.create_space', { type: 'org', org })).toBe(false);
    const open = { settings: { ...org.settings, membersCanCreateSpaces: true } };
    expect(can(actor('member'), 'org.create_space', { type: 'org', org: open })).toBe(true);
    expect(can(actor('guest'), 'org.create_space', { type: 'org', org: open })).toBe(false);
  });

  it('statistics are for owners and admins only (roadmap 21)', () => {
    expect(can(actor('owner'), 'org.view_stats', { type: 'org', org })).toBe(true);
    expect(can(actor('admin'), 'org.view_stats', { type: 'org', org })).toBe(true);
    expect(can(actor('member'), 'org.view_stats', { type: 'org', org })).toBe(false);
    expect(can(actor('guest'), 'org.view_stats', { type: 'org', org })).toBe(false);
  });

  it('chat reports are seen and closed by owners and admins only', () => {
    expect(can(actor('owner'), 'chat.review_reports', { type: 'org', org })).toBe(true);
    expect(can(actor('admin'), 'chat.review_reports', { type: 'org', org })).toBe(true);
    expect(can(actor('member'), 'chat.review_reports', { type: 'org', org })).toBe(false);
    expect(can(actor('guest'), 'chat.review_reports', { type: 'org', org })).toBe(false);
  });

  it('portal rights come from role or explicit permission', () => {
    expect(can(actor('member'), 'portal.edit', { type: 'org', org })).toBe(false);
    expect(can(actor('member', ['portal.edit']), 'portal.edit', { type: 'org', org })).toBe(true);
  });
});

describe('can: space', () => {
  const space = (myRole: 'owner' | 'admin' | 'editor' | 'viewer' | null) =>
    ({ type: 'space', org, myRole }) as const;

  it('non-members, including org owners, cannot view content', () => {
    expect(can(actor('owner'), 'space.view', space(null))).toBe(false);
  });

  it('follows the role hierarchy', () => {
    expect(can(actor('member'), 'space.view', space('viewer'))).toBe(true);
    expect(can(actor('member'), 'space.edit_content', space('viewer'))).toBe(false);
    expect(can(actor('member'), 'space.edit_content', space('editor'))).toBe(true);
    expect(can(actor('member'), 'space.purge', space('editor'))).toBe(false);
    expect(can(actor('member'), 'space.manage_members', space('admin'))).toBe(true);
    expect(can(actor('member'), 'space.delete', space('admin'))).toBe(false);
    expect(can(actor('member'), 'space.delete', space('owner'))).toBe(true);
  });

  it('public links respect org and space settings', () => {
    expect(can(actor('member'), 'space.share_link', space('editor'))).toBe(false);
    expect(
      can(actor('member'), 'space.share_link', { ...space('editor'), editorsCanShareLinks: true }),
    ).toBe(true);
    const closed = { settings: { ...org.settings, publicLinksEnabled: false } };
    expect(
      can(actor('member'), 'space.share_link', { type: 'space', org: closed, myRole: 'owner' }),
    ).toBe(false);
  });

  it('cannot grant above own role', () => {
    expect(canGrantSpaceRole('editor', 'viewer')).toBe(true);
    expect(canGrantSpaceRole('editor', 'admin')).toBe(false);
    expect(canGrantSpaceRole('owner', 'owner')).toBe(false);
  });
});

describe('effectiveNodeRole', () => {
  it('takes the stronger of space role and shares', () => {
    expect(effectiveNodeRole(null, [])).toBeNull();
    expect(effectiveNodeRole(null, ['viewer'])).toBe('viewer');
    expect(effectiveNodeRole('viewer', ['editor', 'viewer'])).toBe('editor');
    expect(effectiveNodeRole('admin', ['editor'])).toBe('admin');
  });
});
