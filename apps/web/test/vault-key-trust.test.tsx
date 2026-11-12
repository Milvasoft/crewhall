import {
  encryptSettings,
  fingerprint,
  generateKeyPair,
  toB64,
  unwrapVaultKey,
} from '@crewhall/crypto';
import { screen, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acceptSettingsAsTheyAre,
  createSpaceVault,
  saveSettings,
  unlockWithPassword,
} from '@/lib/vault/api';
import { KeysToConfirmError, rotateVault } from '@/lib/vault/rotation';
import { currentSettings, getSession, lock } from '@/lib/vault/session';
import { pinKeys, trustOf } from '@/lib/vault/tofu';
import { db } from '@/mocks/db';
import { SPACE, USER } from '@/mocks/seed';
import { vaultState } from '@/mocks/vault';
import { setUpVault, VAULT_PASSWORD } from './support/vault';

/**
 * What a server that lies can do to the keys a vault key is sealed to (doc 17 §7 "Sahte açık
 * anahtar"): swap a member's public key during a rotation, or hand back an older copy of the
 * settings the pins live in, or none, so that a swap would pass for a first sight.
 */

afterEach(() => lock('manual'));

/** Gives someone a fresh key pair on the mock server, as a server swapping their key would. */
function newKeyOf(userId: string) {
  const pair = generateKeyPair();
  const keys = vaultState(db()).keys;
  keys[userId] = {
    ...keys[USER.bugra]!,
    publicKey: toB64(pair.publicKey),
    fingerprint: fingerprint(pair.publicKey),
  };
  return {
    privateKey: pair.privateKey,
    publicKey: keys[userId].publicKey,
    fp: keys[userId].fingerprint,
  };
}

async function vaultWith(userId: string) {
  const infra = await createSpaceVault(SPACE.altyapi, 'Sunucular');
  vaultState(db()).members.push({
    vaultId: infra.id,
    userId,
    role: 'read',
    wrappedKey: '',
    keyVersion: infra.keyVersion,
    grantedBy: USER.bugra,
    grantedAt: new Date().toISOString(),
  });
  return infra;
}

const memberOf = (vaultId: string, userId: string) =>
  vaultState(db()).members.find((m) => m.vaultId === vaultId && m.userId === userId)!;
const keyVersionOf = (vaultId: string) =>
  vaultState(db()).vaults.find((v) => v.id === vaultId)!.keyVersion;
const seenAs = (id: string, fp: string) => ({
  user: { id },
  fingerprint: fp,
});
const pinsOn = async (pins: Record<string, string>) =>
  saveSettings({ ...currentSettings(), pins: { ...currentSettings().pins, ...pins } });

async function confirmationFor(run: Promise<unknown>) {
  const e = await run.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(KeysToConfirmError);
  return (e as KeysToConfirmError).people;
}

describe('rotation only seals to keys the person saw or confirmed', () => {
  it('stops at a swapped key, and only the confirmed fingerprint gets through', async () => {
    await setUpVault();
    const honest = newKeyOf(USER.mert);
    const infra = await vaultWith(USER.mert);
    await pinsOn({ [USER.mert]: honest.fp });

    const attacker = newKeyOf(USER.mert);
    const people = await confirmationFor(
      rotateVault(infra.id, [], { seen: [seenAs(USER.mert, attacker.fp)] }),
    );
    expect(people).toMatchObject([{ userId: USER.mert, why: 'changed', fingerprint: attacker.fp }]);
    expect(keyVersionOf(infra.id)).toBe(1);

    // A checkbox ticked for one key does not vouch for the next one.
    const later = newKeyOf(USER.mert);
    await confirmationFor(rotateVault(infra.id, [], { accepted: { [USER.mert]: attacker.fp } }));
    expect(keyVersionOf(infra.id)).toBe(1);

    await rotateVault(infra.id, [], { accepted: { [USER.mert]: later.fp } });
    expect(keyVersionOf(infra.id)).toBe(2);
    expect(trustOf(USER.mert, later.publicKey, later.fp)).toBe('pinned');
    expect(
      unwrapVaultKey(later.privateKey, memberOf(infra.id, USER.mert).wrappedKey, {
        vaultId: infra.id,
        keyVersion: 2,
        userId: USER.mert,
      }),
    ).toHaveLength(32);
  }, 60_000);

  it('stops at a member not on the list, and at a first-seen key until it is confirmed', async () => {
    await setUpVault();
    const mert = newKeyOf(USER.mert);
    const infra = await vaultWith(USER.mert);

    // The server slips someone in only for the rotation.
    newKeyOf(USER.selin);
    vaultState(db()).members.push({ ...memberOf(infra.id, USER.mert), userId: USER.selin });
    const people = await confirmationFor(
      rotateVault(infra.id, [], { seen: [seenAs(USER.mert, mert.fp)] }),
    );
    expect(people).toMatchObject([
      { userId: USER.mert, why: 'first_seen' },
      { userId: USER.selin, why: 'unlisted' },
    ]);
    expect(keyVersionOf(infra.id)).toBe(1);

    // On the list and all, the list is the server's word: it takes the person's confirmation.
    await rotateVault(infra.id, [USER.selin], {
      seen: [seenAs(USER.mert, mert.fp)],
      accepted: { [USER.mert]: mert.fp },
    });
    expect(keyVersionOf(infra.id)).toBe(2);
    expect(trustOf(USER.mert, mert.publicKey, mert.fp)).toBe('pinned');
  }, 60_000);

  it('refuses when my own key is not the one that opened my private key', async () => {
    await setUpVault();
    const infra = await vaultWith(USER.mert);
    newKeyOf(USER.mert);
    const mine = vaultState(db()).keys[USER.bugra]!;
    const real = { publicKey: mine.publicKey, fingerprint: mine.fingerprint };
    const swapped = generateKeyPair();
    mine.publicKey = toB64(swapped.publicKey);
    mine.fingerprint = fingerprint(swapped.publicKey);
    await expect(rotateVault(infra.id, [])).rejects.toThrow('fingerprint_mismatch');
    Object.assign(mine, real);
    expect(keyVersionOf(infra.id)).toBe(1);
  }, 60_000);

  it('pins nothing from looking, asks on the access page, and forgets who was removed', async () => {
    const view = await setUpVault();
    const honest = newKeyOf(USER.mert);
    const selin = newKeyOf(USER.selin);
    const zeynep = newKeyOf(USER.zeynep);
    const infra = await vaultWith(USER.mert);
    vaultState(db()).members.push(
      { ...memberOf(infra.id, USER.mert), userId: USER.selin },
      { ...memberOf(infra.id, USER.mert), userId: USER.zeynep },
    );
    await pinsOn({ [USER.mert]: honest.fp, [USER.selin]: selin.fp });
    const blobBefore = vaultState(db()).keys[USER.bugra]!.settings;
    await act(() =>
      view.router.navigate({ to: '/vault/$vaultId/access', params: { vaultId: infra.id } }),
    );
    const remove = await screen.findByRole('button', { name: /^Erişimi kaldır: Selin/ });
    // Zeynep is on the list, and looking at it saves nothing: she could be made up.
    expect(screen.getByText(/^Zeynep/)).toBeInTheDocument();
    expect(trustOf(USER.zeynep, zeynep.publicKey, zeynep.fp)).toBe('new');
    expect(vaultState(db()).keys[USER.bugra]!.settings).toBe(blobBefore);

    // The server swaps Mert's key after the page loaded.
    const attacker = newKeyOf(USER.mert);
    await view.user.click(remove);
    const dialog = await screen.findByRole('dialog');
    const run = within(dialog).getByRole('button', { name: 'Kaldır ve anahtarı döndür' });
    await view.user.click(run);

    const alert = await within(dialog).findByRole('alert');
    expect(within(alert).getByText(/daha önce gördüğünden farklı/)).toBeInTheDocument();
    expect(within(alert).getByText(/daha önce kimse onaylamadı/)).toBeInTheDocument();
    expect(keyVersionOf(infra.id)).toBe(1);
    expect(run).toBeDisabled();

    await view.user.click(within(alert).getByRole('checkbox'));
    await view.user.click(run);
    expect(await within(dialog).findByRole('button', { name: 'Tamam' })).toBeInTheDocument();
    expect(keyVersionOf(infra.id)).toBe(2);
    expect(trustOf(USER.mert, attacker.publicKey, attacker.fp)).toBe('pinned');
    expect(trustOf(USER.zeynep, zeynep.publicKey, zeynep.fp)).toBe('pinned');
    // Removed, so a server showing Selin again gets asked about, not waved through.
    await expect.poll(() => trustOf(USER.selin, selin.publicKey, selin.fp)).toBe('new');
  }, 60_000);

  it('a grant asks again when another device has pinned this person since', async () => {
    const view = await setUpVault();
    const pinned = newKeyOf(USER.mert);
    const infra = await createSpaceVault(SPACE.altyapi, 'Sunucular');
    await act(() =>
      view.router.navigate({ to: '/vault/$vaultId/access', params: { vaultId: infra.id } }),
    );
    const u = getSession().unlocked!;
    vaultState(db()).keys[USER.bugra]!.settings = encryptSettings(u.privateKey, u.userId, {
      revision: Date.now() + 3_600_000,
      pins: { [USER.mert]: pinned.fp },
    });
    newKeyOf(USER.mert);

    await view.user.click(await screen.findByRole('button', { name: 'Erişim ver' }));
    const dialog = await screen.findByRole('dialog');
    await view.user.click(await within(dialog).findByText(/^Mert/));
    await view.user.click(within(dialog).getByRole('button', { name: 'Erişim ver' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/farklı/);
    expect(memberOf(infra.id, USER.mert)).toBeUndefined();
  }, 60_000);
});

describe('an older copy of my settings, or none, is noticed', () => {
  async function pinnedThenReplayed() {
    const view = await setUpVault();
    const mert = newKeyOf(USER.mert);
    await saveSettings({ ...currentSettings(), autoLockMinutes: 30 });
    const old = vaultState(db()).keys[USER.bugra]!.settings;
    await pinsOn({ [USER.mert]: mert.fp });
    expect(trustOf(USER.mert, mert.publicKey, mert.fp)).toBe('pinned');
    return { view, mert, old };
  }
  const reopenWith = async (blob: string | null) => {
    lock('manual');
    vaultState(db()).keys[USER.bugra]!.settings = blob;
    await unlockWithPassword(USER.bugra, VAULT_PASSWORD);
  };
  const stateNow = () => getSession().unlocked?.settingsState;

  it('takes nobody for new after a replay, and a preference saved meanwhile keeps the warning', async () => {
    const { mert, old } = await pinnedThenReplayed();
    await reopenWith(old);
    expect(stateNow()).toBe('rolled_back');
    expect(trustOf(USER.mert, mert.publicKey, mert.fp)).toBe('unverified');

    const infra = await vaultWith(USER.mert);
    const people = await confirmationFor(
      rotateVault(infra.id, [], { seen: [seenAs(USER.mert, mert.fp)] }),
    );
    expect(people).toMatchObject([{ why: 'unverified' }]);

    await saveSettings({ ...currentSettings(), autoLockMinutes: 15 });
    await reopenWith(vaultState(db()).keys[USER.bugra]!.settings);
    expect(stateNow()).toBe('rolled_back');
    expect(currentSettings().autoLockMinutes).toBe(15);

    // Only the person's own decision ends it, and a key without a pin is not "first seen" then.
    await acceptSettingsAsTheyAre();
    expect(stateNow()).toBe('ok');
    expect(trustOf(USER.mert, mert.publicKey, mert.fp)).toBe('unverified');
    await reopenWith(vaultState(db()).keys[USER.bugra]!.settings);
    expect(stateNow()).toBe('ok');
    expect(trustOf(USER.mert, mert.publicKey, mert.fp)).toBe('unverified');
    await rotateVault(infra.id, [], { accepted: { [USER.mert]: mert.fp } });
    expect(trustOf(USER.mert, mert.publicKey, mert.fp)).toBe('pinned');
  }, 60_000);

  it('notices settings gone, and shows it on the access page', async () => {
    const { view, mert } = await pinnedThenReplayed();
    const infra = await vaultWith(USER.mert);
    await reopenWith(null);
    expect(stateNow()).toBe('rolled_back');
    expect(trustOf(USER.mert, mert.publicKey, mert.fp)).toBe('unverified');
    await act(() =>
      view.router.navigate({ to: '/vault/$vaultId/access', params: { vaultId: infra.id } }),
    );
    expect(await screen.findByText(/bu cihazda en son gördüğünden eski/)).toBeInTheDocument();
    await view.user.click(screen.getByRole('button', { name: 'Anladım, bu ayarlarla devam et' }));
    await expect.poll(stateNow).toBe('ok');
  }, 60_000);

  it('builds on what another device saved, also with a clock behind it', async () => {
    await setUpVault();
    const mert = newKeyOf(USER.mert);
    const selin = newKeyOf(USER.selin);
    const u = getSession().unlocked!;
    await saveSettings({ ...currentSettings(), autoLockMinutes: 30 });

    // Another device, its clock an hour ahead, pins Mert and changes a preference.
    const ahead = Date.now() + 3_600_000;
    vaultState(db()).keys[USER.bugra]!.settings = encryptSettings(u.privateKey, u.userId, {
      ...currentSettings(),
      revision: ahead,
      clipboardSeconds: 120,
      pins: { [USER.mert]: mert.fp },
    });

    // This open session saves its own change without undoing that.
    await saveSettings({ ...currentSettings(), autoLockMinutes: 15 });
    expect(currentSettings()).toMatchObject({ autoLockMinutes: 15, clipboardSeconds: 120 });
    expect(currentSettings().pins[USER.mert]).toBe(mert.fp);
    expect(currentSettings().revision).toBeGreaterThan(ahead);

    // A pin added here goes next to the one from there.
    const swapped = newKeyOf(USER.mert);
    await pinKeys([{ userId: USER.selin, publicKey: selin.publicKey }]);
    expect(currentSettings().pins).toMatchObject({ [USER.mert]: mert.fp, [USER.selin]: selin.fp });
    await reopenWith(vaultState(db()).keys[USER.bugra]!.settings);
    expect(stateNow()).toBe('ok');
    expect(trustOf(USER.mert, swapped.publicKey, swapped.fp)).toBe('changed');
  }, 60_000);

  it('judges keys for a rotation on what is stored now, not on this session', async () => {
    await setUpVault();
    const mert = newKeyOf(USER.mert);
    const infra = await vaultWith(USER.mert);
    const u = getSession().unlocked!;
    vaultState(db()).keys[USER.bugra]!.settings = encryptSettings(u.privateKey, u.userId, {
      revision: Date.now() + 3_600_000,
      pins: { [USER.mert]: mert.fp },
    });
    const swapped = newKeyOf(USER.mert);
    const people = await confirmationFor(
      rotateVault(infra.id, [], { seen: [seenAs(USER.mert, swapped.fp)] }),
    );
    expect(people).toMatchObject([{ userId: USER.mert, why: 'changed' }]);
  }, 60_000);

  it('does not save over settings that would not open', async () => {
    await pinnedThenReplayed();
    await reopenWith('AAAAAAAA');
    expect(stateNow()).toBe('unreadable');
    await saveSettings({ ...currentSettings(), autoLockMinutes: 15 });
    expect(currentSettings().autoLockMinutes).toBe(15);
    expect(vaultState(db()).keys[USER.bugra]!.settings).toBe('AAAAAAAA');
  }, 60_000);

  it('stamps a blob from before revisions at unlock, and a new device takes what it gets', async () => {
    await setUpVault();
    const mert = newKeyOf(USER.mert);
    const u = getSession().unlocked!;
    const before = encryptSettings(u.privateKey, u.userId, { pins: { [USER.mert]: mert.fp } });
    await reopenWith(before);
    expect(stateNow()).toBe('ok');
    expect(trustOf(USER.mert, mert.publicKey, mert.fp)).toBe('pinned');
    await expect.poll(() => vaultState(db()).keys[USER.bugra]!.settings).not.toBe(before);
    await expect.poll(() => currentSettings().revision).toBeGreaterThan(0);

    // This device now tells the old blob from the stamped one...
    await reopenWith(before);
    expect(stateNow()).toBe('rolled_back');

    // ...and one with no memory cannot: the known limit of a floor kept on the device.
    localStorage.clear();
    await reopenWith(before);
    expect(stateNow()).toBe('ok');
  }, 60_000);
});
