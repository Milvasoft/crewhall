import { newId } from './db';
import {
  type DeliverySettings,
  type DeliveryTestResult,
  type EndpointName,
  type StoredSecret,
} from '@crewhall/shared';
import { actorOf, MockApiError, requireUser, type Resolvers } from './core';
import { type MockState } from './seed';

/**
 * Yönetim › Bildirim gönderimi mock: same rules as the backend (services/delivery/settings.ts):
 * secrets are write-only, a mode missing a required field is a 422 with the field's path, the
 * Firebase service account must be JSON with project_id, client_email and private_key.
 */
interface State {
  settings: DeliverySettings;
  /** Push devices of the signed-in person (the test needs one). */
  hasDevice: boolean;
  /** Notifike refuses the stored key. */
  notifikeRejects: boolean;
}

const none: StoredSecret = { set: false, hint: null, updatedAt: null };

function initial(): State {
  return {
    settings: {
      email: {
        mode: 'env',
        smtp: {
          host: null,
          port: null,
          security: 'starttls',
          username: null,
          password: none,
          from: null,
        },
        configured: true,
        lastTest: null,
      },
      push: {
        mode: 'env',
        direct: { fcmProjectId: null, fcmServiceAccount: none, expoAccessToken: none },
        configured: true,
        lastTest: null,
      },
      notifike: { baseUrl: null, apiKey: none, authFailedAt: null },
      server: { email: true, fcm: false },
      updatedAt: null,
    },
    hasDevice: false,
    notifikeRejects: false,
  };
}

let state = initial();

/** Tests: start clean and shape the environment. */
export function resetDeliveryMock(patch: Partial<Omit<State, 'settings'>> = {}): State {
  state = { ...initial(), ...patch };
  return state;
}

function requireSettingsAdmin(s: MockState) {
  const role = actorOf(s, requireUser(s)).orgRole;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
}

function invalid(path: string[], code: string, message: string): never {
  throw new MockApiError('validation_failed', message, {
    in: 'body',
    issues: [{ path, code, message }],
  });
}

const stored = (value: string, hint = false): StoredSecret => ({
  set: true,
  hint: hint ? value.slice(-4) : null,
  updatedAt: new Date().toISOString(),
});

function projectIdOf(raw: string): string {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    invalid(['push', 'fcmServiceAccount'], 'invalid_service_account', 'not valid JSON');
  }
  const o = (json ?? {}) as Record<string, unknown>;
  const missing = ['project_id', 'client_email', 'private_key'].filter(
    (k) => typeof o[k] !== 'string' || !o[k],
  );
  if (missing.length) {
    invalid(
      ['push', 'fcmServiceAccount'],
      'invalid_service_account',
      `lacks: ${missing.join(', ')}`,
    );
  }
  return o.project_id as string;
}

export const deliveryResolvers: Partial<Resolvers<EndpointName>> = {
  getPushDiagnostics: ({ params }) => ({
    userId: params.userId!,
    now: new Date().toISOString(),
    visibility: 'online',
    quietHours: null,
    inQuietHours: false,
    sessions: [],
    devices: [],
    groups: [],
    conversation: null,
    recent: [
      {
        id: newId(),
        type: 'chat.direct',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        count: 1,
        wantsPush: false,
        pushSkip: 'attending' as const,
        pushedAt: null,
        readAt: null,
        outcome: null,
      },
    ],
  }),
  getDeliverySettings: ({ s }) => {
    requireSettingsAdmin(s);
    return state.settings;
  },

  updateDeliverySettings: ({ s, body }) => {
    requireSettingsAdmin(s);
    const prev = state.settings;
    const smtpIn = body.email?.smtp;
    const smtp = {
      ...prev.email.smtp,
      ...(smtpIn?.host !== undefined ? { host: smtpIn.host } : {}),
      ...(smtpIn?.port !== undefined ? { port: smtpIn.port } : {}),
      ...(smtpIn?.security !== undefined ? { security: smtpIn.security } : {}),
      ...(smtpIn?.username !== undefined ? { username: smtpIn.username } : {}),
      ...(smtpIn?.from !== undefined ? { from: smtpIn.from } : {}),
      password:
        smtpIn?.password === undefined
          ? prev.email.smtp.password
          : smtpIn.password
            ? stored(smtpIn.password)
            : none,
    };
    const pushIn = body.push;
    const direct = { ...prev.push.direct };
    if (pushIn?.fcmServiceAccount !== undefined) {
      direct.fcmProjectId = pushIn.fcmServiceAccount ? projectIdOf(pushIn.fcmServiceAccount) : null;
      direct.fcmServiceAccount = pushIn.fcmServiceAccount ? stored(pushIn.fcmServiceAccount) : none;
    }
    if (pushIn?.expoAccessToken !== undefined) {
      direct.expoAccessToken = pushIn.expoAccessToken ? stored(pushIn.expoAccessToken) : none;
    }
    const nIn = body.notifike;
    const notifike = {
      ...prev.notifike,
      ...(nIn?.baseUrl !== undefined ? { baseUrl: nIn.baseUrl } : {}),
      ...(nIn?.apiKey !== undefined
        ? { apiKey: nIn.apiKey ? stored(nIn.apiKey, true) : none, authFailedAt: null }
        : {}),
    };
    const emailMode = body.email?.mode ?? prev.email.mode;
    const pushMode = body.push?.mode ?? prev.push.mode;
    // A mode is refused while a field it needs is empty (path points at the field).
    if (emailMode === 'smtp') {
      if (!smtp.host) invalid(['email', 'smtp', 'host'], 'required', 'SMTP host is required');
      if (!smtp.port) invalid(['email', 'smtp', 'port'], 'required', 'SMTP port is required');
      if (!smtp.from) invalid(['email', 'smtp', 'from'], 'required', 'sender is required');
    }
    if (pushMode === 'direct' && !direct.fcmServiceAccount.set) {
      invalid(['push', 'fcmServiceAccount'], 'required', 'a Firebase service account is required');
    }
    if (emailMode === 'notifike' || pushMode === 'notifike') {
      if (!notifike.baseUrl) invalid(['notifike', 'baseUrl'], 'required', 'URL is required');
      if (!notifike.apiKey.set) invalid(['notifike', 'apiKey'], 'required', 'key is required');
    }
    state.settings = {
      email: {
        mode: emailMode,
        smtp,
        configured:
          emailMode === 'smtp' ||
          emailMode === 'notifike' ||
          (emailMode === 'env' && prev.server.email),
        lastTest: prev.email.lastTest,
      },
      push: { mode: pushMode, direct, configured: true, lastTest: prev.push.lastTest },
      notifike,
      server: prev.server,
      updatedAt: new Date().toISOString(),
    };
    return state.settings;
  },

  testDelivery: ({ s, body }) => {
    requireSettingsAdmin(s);
    const st = state.settings;
    const at = new Date().toISOString();
    let result: DeliveryTestResult;
    const viaNotifike =
      body.channel === 'email' ? st.email.mode === 'notifike' : st.push.mode === 'notifike';
    if (body.channel === 'email') {
      const base = { channel: 'email' as const, at, via: st.email.mode, recipients: 0 };
      result = !st.email.configured
        ? { ...base, ok: false, code: 'delivery_not_configured', message: null }
        : viaNotifike && state.notifikeRejects
          ? { ...base, ok: false, code: 'delivery_unauthorized', message: 'HTTP 401' }
          : { ...base, ok: true, recipients: 1, code: null, message: null };
      state.settings = { ...st, email: { ...st.email, lastTest: result } };
    } else {
      const base = { channel: 'push' as const, at, via: st.push.mode, recipients: 0 };
      result = !state.hasDevice
        ? { ...base, ok: false, code: 'delivery_no_device', message: null }
        : viaNotifike && state.notifikeRejects
          ? { ...base, ok: false, code: 'delivery_unauthorized', message: 'HTTP 401' }
          : { ...base, ok: true, recipients: 1, code: null, message: null };
      state.settings = { ...st, push: { ...st.push, lastTest: result } };
    }
    if (viaNotifike && state.notifikeRejects) {
      state.settings = {
        ...state.settings,
        notifike: { ...state.settings.notifike, authFailedAt: at },
      };
    }
    return result;
  },
};
