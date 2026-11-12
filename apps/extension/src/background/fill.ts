import { hostOf, isSafeForFilling, matchesAny } from '../shared/match';
import type { FillResult } from '../shared/messages';
import { fillLoginForm, probeLoginForm, type FillInput } from '../shared/page-functions';
import type { VaultService } from './vault';

interface Frame {
  frameId: number;
  url: string;
  hasPassword: boolean;
  hasUsername: boolean;
  hasOtp: boolean;
}

async function frames(tabId: number): Promise<Frame[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: probeLoginForm,
  });
  return results.flatMap((r) => (r.result ? [{ frameId: r.frameId, ...r.result }] : []));
}

async function fillFrame(tabId: number, frameId: number, input: FillInput): Promise<boolean> {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func: fillLoginForm,
    args: [input],
  });
  return r?.result === true;
}

const originOf = (url: string) => new URL(url).origin;

/**
 * Fills only on a click in the extension, and only into a frame whose own address matches the
 * login: nothing happens by itself when a page opens, and an embedded third party gets nothing.
 */
export async function fillLogin(vault: VaultService, itemId: string, tabId: number): Promise<FillResult> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !isSafeForFilling(tab.url)) return 'blocked';
  const { payload, vaultId } = await vault.login(itemId);
  const candidates = (await frames(tabId)).filter(
    (f) => matchesAny(payload.uris, f.url) && isSafeForFilling(f.url),
  );
  if (!candidates.length) return 'no_match';
  const frame =
    candidates.find((f) => f.frameId === 0 && (f.hasPassword || f.hasUsername || f.hasOtp)) ??
    candidates.find((f) => f.hasPassword || f.hasUsername || f.hasOtp);
  if (!frame) return 'no_fields';

  const otp =
    frame.hasOtp && payload.totp
      ? (await vault.totp(itemId, { forCopy: true })).code
      : undefined;
  const ok = await fillFrame(tabId, frame.frameId, {
    origin: originOf(frame.url),
    username: payload.username || undefined,
    password: payload.password || undefined,
    otp,
  });
  if (!ok) return 'no_fields';
  await vault.report(itemId, vaultId, 'password');
  return 'filled';
}

export async function fillGenerated(value: string, tabId: number): Promise<FillResult> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !isSafeForFilling(tab.url)) return 'blocked';
  const ok = await fillFrame(tabId, 0, {
    origin: originOf(tab.url),
    password: value,
    allPasswords: true,
  });
  return ok ? 'filled' : 'no_fields';
}

export { hostOf };
