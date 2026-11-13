import { contextBridge, ipcRenderer } from 'electron';
import {
  API_METHODS,
  MEETING,
  RC,
  SEND_EVENT,
  SETTINGS_EVENT,
  SYSTEM_LOCK,
  FILES,
  NOTIFY_SOUND,
  VAULT_DEVICE,
  type DesktopApi,
  type DesktopWebBridge,
  type NotificationSound,
  type SendState,
  type SettingsView,
} from '../common/ipc';
import { TITLEBAR_CHANNEL } from '../common/titlebar';
import { OPEN_WINDOW_CHANNEL, desktopFeatures } from '../common/client';

/**
 * One sandboxed preload for every window. The app's own pages (file://) get the `desktop` API;
 * the organization's web pages get `crewhallDesktop`: that they run in the desktop app, and the
 * remote control relay of the meeting room. Main checks every call's sender again.
 */
if (location.protocol === 'file:') {
  const api: Record<string, unknown> = {};
  for (const method of API_METHODS) {
    api[method] = (...args: unknown[]) => ipcRenderer.invoke(`desktop:${method}`, ...args);
  }
  api.onSettings = (listener: (settings: SettingsView) => void) => {
    const handler = (_e: unknown, settings: SettingsView) => listener(settings);
    ipcRenderer.on(SETTINGS_EVENT, handler);
    return () => ipcRenderer.removeListener(SETTINGS_EVENT, handler);
  };
  api.onSend = (listener: (state: SendState) => void) => {
    const handler = (_e: unknown, state: SendState) => listener(state);
    ipcRenderer.on(SEND_EVENT, handler);
    return () => ipcRenderer.removeListener(SEND_EVENT, handler);
  };
  contextBridge.exposeInMainWorld('desktop', api as unknown as DesktopApi);
} else {
  const bridge: DesktopWebBridge = {
    isDesktop: true,
    platform: process.platform,
    version: __APP_VERSION__,
    // The web asks for features, never versions (common/client).
    features: desktopFeatures(process.platform, __MAC_KEYCHAIN_GROUP__),
    openMeeting: (url) => ipcRenderer.invoke(MEETING.open, url),
    openWindow: (url) => ipcRenderer.invoke(OPEN_WINDOW_CHANNEL, url),
    onMeetingClosed: (listener) => {
      const handler = (_e: unknown, url: string) => listener(url);
      ipcRenderer.on(MEETING.closed, handler);
      return () => ipcRenderer.removeListener(MEETING.closed, handler);
    },
    windowKind: () => ipcRenderer.invoke(MEETING.kind),
    onOpenFile: (listener) => {
      const handler = (_e: unknown, file: { url: string; name: string }) => listener(file);
      ipcRenderer.on(FILES.open, handler);
      ipcRenderer.send(FILES.listen, true);
      return () => {
        ipcRenderer.removeListener(FILES.open, handler);
        ipcRenderer.send(FILES.listen, false);
      };
    },
    onSystemLock: (listener) => {
      const handler = () => listener();
      ipcRenderer.on(SYSTEM_LOCK, handler);
      return () => ipcRenderer.removeListener(SYSTEM_LOCK, handler);
    },
    onNotificationSound: (listener) => {
      const handler = (_e: unknown, sound: NotificationSound) => listener(sound);
      ipcRenderer.on(NOTIFY_SOUND.play, handler);
      ipcRenderer.send(NOTIFY_SOUND.listen, true);
      return () => {
        ipcRenderer.removeListener(NOTIFY_SOUND.play, handler);
        ipcRenderer.send(NOTIFY_SOUND.listen, false);
      };
    },
    vaultDevice: {
      status: (userId, stamp) => ipcRenderer.invoke(VAULT_DEVICE.status, userId, stamp),
      challenge: (userId, purpose) => ipcRenderer.invoke(VAULT_DEVICE.challenge, userId, purpose),
      enrol: (userId, input) => ipcRenderer.invoke(VAULT_DEVICE.enrol, userId, input),
      unlock: (userId, assertion) => ipcRenderer.invoke(VAULT_DEVICE.unlock, userId, assertion),
      passwordUnlocked: (userId, stamp) =>
        ipcRenderer.invoke(VAULT_DEVICE.passwordUnlocked, userId, stamp),
      forget: (userId) => ipcRenderer.invoke(VAULT_DEVICE.forget, userId),
    },
    titleBar: {
      overlay: true,
      set: (state) => ipcRenderer.send(TITLEBAR_CHANNEL, state),
    },
    remoteControl: {
      shareChanged: (active) => ipcRenderer.invoke(RC.share, active),
      setAllowed: (allowed) => ipcRenderer.send(RC.allowed, allowed),
      setRequests: (people) => ipcRenderer.send(RC.requests, people),
      setController: (person) => ipcRenderer.send(RC.controller, person),
      input: (identity, json) => ipcRenderer.send(RC.input, identity, json),
      end: () => ipcRenderer.send(RC.end),
      onAnswer: (listener) => {
        const handler = (_e: unknown, identity: string, yes: boolean) => listener(identity, yes);
        ipcRenderer.on(RC.answer, handler);
        return () => ipcRenderer.removeListener(RC.answer, handler);
      },
      onRevoke: (listener) => {
        const handler = (_e: unknown, reason: string) => listener(reason);
        ipcRenderer.on(RC.revoke, handler);
        return () => ipcRenderer.removeListener(RC.revoke, handler);
      },
    },
  };
  contextBridge.exposeInMainWorld('crewhallDesktop', bridge);
}
