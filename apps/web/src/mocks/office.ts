import { type EndpointName, type OfficeSettings } from '@crewhall/shared';
import { actorOf, MockApiError, requireUser, type Resolvers } from './core';
import { type MockState } from './seed';

/**
 * Office module in mock mode: there is no document server, so settings save and the test says
 * so; Drive offers no "Düzenle" and opening a file answers office_unavailable.
 */
let settings: OfficeSettings = {
  enabled: false,
  serverType: 'onlyoffice',
  jwtSecret: { set: false, hint: null },
  serverUrl: null,
  internalUrl: null,
  lastTest: null,
  updatedAt: null,
};

function requireAdmin(s: MockState) {
  const role = actorOf(s, requireUser(s)).orgRole;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
}

export const officeResolvers: Partial<Resolvers<EndpointName>> = {
  getOfficeSettings: ({ s }) => {
    requireAdmin(s);
    return settings;
  },
  updateOfficeSettings: ({ s, body }) => {
    requireAdmin(s);
    settings = {
      ...settings,
      enabled: body.enabled ?? settings.enabled,
      serverType: body.serverType ?? settings.serverType,
      jwtSecret:
        body.jwtSecret === undefined
          ? settings.jwtSecret
          : body.jwtSecret === null
            ? { set: false, hint: null }
            : { set: true, hint: body.jwtSecret.slice(-4) },
      serverUrl: body.serverUrl !== undefined ? body.serverUrl : settings.serverUrl,
      internalUrl: body.internalUrl !== undefined ? body.internalUrl : settings.internalUrl,
      updatedAt: new Date().toISOString(),
    };
    return settings;
  },
  testOfficeSettings: ({ s }) => {
    requireAdmin(s);
    const lastTest = {
      ok: false,
      error: 'mock mode has no document server',
      edit: [],
      view: [],
      checkedAt: new Date().toISOString(),
    };
    settings = { ...settings, lastTest };
    return lastTest;
  },
  getOfficeCapabilities: ({ s }) => {
    requireUser(s);
    return { available: false, edit: [], view: [] };
  },
  openOfficeSession: () => {
    throw new MockApiError('office_unavailable');
  },
  createOfficeDocument: () => {
    throw new MockApiError('office_unavailable');
  },
};
