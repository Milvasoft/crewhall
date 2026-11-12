import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { VAULT_DEVICE } from '../common/ipc';
import {
  CHALLENGE_TTL_MS,
  DeviceCheckError,
  b64url,
  deviceUsable,
  verifyAssertion,
  verifyRegistration,
  type StoredDevice,
} from '../common/vault-device';
import type { DesktopApp } from './app';

const Stored = z.object({
  unlockId: z.string().min(1),
  secret: z.string().min(1),
  credentialId: z.string().min(1),
  publicKey: z.string().min(1),
  alg: z.number().int(),
  signCount: z.number().int().nonnegative(),
  enrolledAt: z.number(),
  passwordAt: z.number(),
  stamp: z.string(),
});
const Store = z.record(z.string(), Stored);

const UserId = z.string().min(1).max(100);
const Stamp = z.string().max(200);
const B64url = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(16_384);
const Registration = z.object({
  credentialId: B64url,
  clientDataJSON: B64url,
  authenticatorData: B64url,
  publicKey: B64url,
  alg: z.number().int(),
});
const Assertion = z.object({
  credentialId: B64url,
  clientDataJSON: B64url,
  authenticatorData: B64url,
  signature: B64url,
});
const Enrol = z.object({
  unlockId: z.string().min(1).max(100),
  /** The device secret (base64), 32 bytes. */
  secret: z.base64().length(44),
  stamp: Stamp,
  credential: Registration,
});

/**
 * Windows Hello vault unlock, main process side (common/vault-device). Only the main window's
 * page of the organization's server may use it; the secret is kept encrypted by the OS and
 * leaves this process only after a verified Hello assertion.
 */
export class VaultDevice {
  private readonly file = join(app.getPath('userData'), 'vault-device.json');
  private store: Record<string, StoredDevice> = {};
  /** One-time challenges by page (webContents id). */
  private challenges = new Map<
    number,
    { challenge: string; purpose: 'enrol' | 'unlock'; scope: string; at: number }
  >();

  constructor(private readonly d: DesktopApp) {
    try {
      this.store = Store.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      this.store = {};
    }
  }

  /** Windows (Hello) with OS encryption; macOS only in a signed build with Touch ID set up. */
  static supported(macKeychainGroup: string): boolean {
    if (process.platform !== 'win32' && !(process.platform === 'darwin' && macKeychainGroup))
      return false;
    return safeStorage.isEncryptionAvailable();
  }

  register(): void {
    const handle = <T>(
      channel: string,
      fn: (scope: string, args: unknown[], e: IpcMainInvokeEvent) => T | Promise<T>,
    ) =>
      ipcMain.handle(channel, (e, userId: unknown, ...args: unknown[]) => {
        const scope = this.scopeFor(e, userId);
        return fn(scope, args, e);
      });

    handle(VAULT_DEVICE.status, (scope, [stamp]) => this.status(scope, Stamp.parse(stamp)));
    handle(VAULT_DEVICE.challenge, (scope, [purpose], e) =>
      this.challenge(scope, z.enum(['enrol', 'unlock']).parse(purpose), e.sender.id),
    );
    handle(VAULT_DEVICE.enrol, (scope, [input], e) => this.enrol(scope, Enrol.parse(input), e));
    handle(VAULT_DEVICE.unlock, (scope, [input], e) =>
      this.unlock(scope, Assertion.parse(input), e),
    );
    handle(VAULT_DEVICE.passwordUnlocked, (scope, [stamp]) =>
      this.passwordUnlocked(scope, Stamp.parse(stamp)),
    );
    handle(VAULT_DEVICE.forget, (scope) => this.forget(scope));
  }

  /** The vault page of the app's main or further windows, for this server and person. */
  private scopeFor(e: IpcMainInvokeEvent, userId: unknown): string {
    const origin = this.d.origin;
    const main = this.d.main;
    const isMain = !!main && !main.isDestroyed() && e.sender === main.webContents;
    if (!origin || (!isMain && !this.d.extras.has(e.sender))) throw new Error('forbidden');
    if (e.senderFrame !== e.sender.mainFrame) throw new Error('forbidden');
    let pageOrigin = '';
    try {
      pageOrigin = new URL(e.sender.getURL()).origin;
    } catch {
      // not a page of the server
    }
    if (pageOrigin !== origin) throw new Error('forbidden');
    return `${origin}|${UserId.parse(userId)}`;
  }

  private get origin(): string {
    return this.d.origin ?? '';
  }

  private get rpId(): string {
    return new URL(this.origin).hostname;
  }

  status(scope: string, stamp: string) {
    if (!VaultDevice.supported(__MAC_KEYCHAIN_GROUP__)) return { available: false as const };
    const d = this.store[scope];
    if (!d) return { available: true as const, enrolled: false as const };
    const state = deviceUsable(d, stamp, Date.now());
    if (state === 'stale') {
      // A new vault password: this device has to be set up again.
      void this.drop(scope);
      return { available: true as const, enrolled: false as const, stale: d.unlockId };
    }
    return {
      available: true as const,
      enrolled: true as const,
      usable: state === 'ok',
      unlockId: d.unlockId,
    };
  }

  private challenge(scope: string, purpose: 'enrol' | 'unlock', page: number) {
    const d = this.store[scope];
    if (purpose === 'unlock' && !d) throw new Error('not_enrolled');
    const challenge = b64url(randomBytes(32));
    this.challenges.set(page, { challenge, purpose, scope, at: Date.now() });
    return {
      challenge,
      rpId: this.rpId,
      ...(purpose === 'unlock' && d ? { credentialId: d.credentialId } : {}),
    };
  }

  /** The challenge this page asked for, used once. */
  private take(page: number, scope: string, purpose: 'enrol' | 'unlock'): string {
    const c = this.challenges.get(page);
    this.challenges.delete(page);
    if (!c || c.scope !== scope || c.purpose !== purpose || Date.now() - c.at > CHALLENGE_TTL_MS)
      throw new DeviceCheckError('challenge');
    return c.challenge;
  }

  private async enrol(scope: string, input: z.infer<typeof Enrol>, e: IpcMainInvokeEvent) {
    const challenge = this.take(e.sender.id, scope, 'enrol');
    const cred = verifyRegistration(input.credential, {
      challenge,
      origin: this.origin,
      rpId: this.rpId,
    });
    const previous = this.store[scope]?.unlockId ?? null;
    const now = Date.now();
    this.store[scope] = {
      ...cred,
      unlockId: input.unlockId,
      secret: safeStorage.encryptString(input.secret).toString('base64'),
      enrolledAt: now,
      passwordAt: now,
      stamp: input.stamp,
    };
    await this.save();
    // The page removes the server side of the device it replaced.
    return { replaced: previous !== input.unlockId ? previous : null };
  }

  private async unlock(scope: string, input: z.infer<typeof Assertion>, e: IpcMainInvokeEvent) {
    const challenge = this.take(e.sender.id, scope, 'unlock');
    const d = this.store[scope];
    if (!d) throw new Error('not_enrolled');
    if (deviceUsable(d, d.stamp, Date.now()) !== 'ok') throw new Error('expired');
    d.signCount = verifyAssertion(input, d, { challenge, origin: this.origin, rpId: this.rpId });
    await this.save();
    return {
      unlockId: d.unlockId,
      secret: safeStorage.decryptString(Buffer.from(d.secret, 'base64')),
    };
  }

  private async passwordUnlocked(scope: string, stamp: string) {
    const d = this.store[scope];
    if (!d) return;
    if (d.stamp !== stamp) return this.status(scope, stamp);
    d.passwordAt = Date.now();
    await this.save();
  }

  private async forget(scope: string) {
    const unlockId = this.store[scope]?.unlockId ?? null;
    await this.drop(scope);
    return { unlockId };
  }

  private async drop(scope: string) {
    if (!this.store[scope]) return;
    delete this.store[scope];
    await this.save();
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.store), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
