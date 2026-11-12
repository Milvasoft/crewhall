import {
  type CreateIdentityProviderInput,
  type IdentityProvider,
  type IdpKind,
  type IdpPreset,
  type IdpRoleMapping,
  type LdapConfig,
  type OidcIdpConfig,
  type SamlIdpConfig,
  type UpdateIdentityProvider,
} from '@crewhall/shared';
import { type IconName } from '@crewhall/ui';

/**
 * Identity provider form (Yönetim › Entegrasyonlar › Kimlik sağlayıcıları, 9.14): presets that
 * prefill the form, and the mapping between the form and the contract. Presets are only form
 * defaults; the server treats `preset` as a label.
 */

export interface OidcForm {
  issuer: string;
  clientId: string;
  scopes: string;
  groupsClaim: string;
  prompt: '' | 'login' | 'select_account' | 'consent';
  endSessionOnLogout: boolean;
}

export interface SamlForm {
  entryPoint: string;
  idpIssuer: string;
  idpCert: string;
  emailAttribute: string;
  nameAttribute: string;
  groupsAttribute: string;
  logoutUrl: string;
  endSessionOnLogout: boolean;
}

export interface LdapForm {
  url: string;
  startTls: boolean;
  caCert: string;
  tlsVerify: boolean;
  bindDn: string;
  baseDn: string;
  userFilter: string;
  emailAttribute: string;
  nameAttribute: string;
  uidAttribute: string;
  useMemberOf: boolean;
  groupBaseDn: string;
  groupFilter: string;
  groupNameAttribute: string;
  activeDirectory: boolean;
  timeoutMs: number;
}

export interface ProviderForm {
  kind: IdpKind;
  preset: IdpPreset;
  name: string;
  enabled: boolean;
  domains: string[];
  enforceSso: boolean;
  jitProvisioning: boolean;
  defaultRole: 'member' | 'guest';
  linkExistingByEmail: boolean;
  trustIdpMfa: boolean;
  syncRoles: boolean;
  syncEnabled: boolean;
  roleMappings: IdpRoleMapping[];
  oidc: OidcForm;
  saml: SamlForm;
  ldap: LdapForm;
  /** OIDC client secret or LDAP bind password; empty = keep the stored one. */
  secret: string;
}

export const AD_USER_FILTER =
  '(&(objectClass=user)(|(sAMAccountName={username})(userPrincipalName={username})(mail={username})))';
export const OPENLDAP_USER_FILTER =
  '(&(objectClass=inetOrgPerson)(|(uid={username})(mail={username})))';
export const GROUP_OF_NAMES_FILTER = '(&(objectClass=groupOfNames)(member={dn}))';

const OIDC_DEFAULTS: OidcForm = {
  issuer: '',
  clientId: '',
  scopes: 'openid email profile',
  groupsClaim: 'groups',
  prompt: '',
  endSessionOnLogout: false,
};

const SAML_DEFAULTS: SamlForm = {
  entryPoint: '',
  idpIssuer: '',
  idpCert: '',
  emailAttribute: 'email',
  nameAttribute: 'name',
  groupsAttribute: 'groups',
  logoutUrl: '',
  endSessionOnLogout: false,
};

const LDAP_DEFAULTS: LdapForm = {
  url: '',
  startTls: false,
  caCert: '',
  tlsVerify: true,
  bindDn: '',
  baseDn: '',
  userFilter: '',
  emailAttribute: 'mail',
  nameAttribute: 'displayName',
  uidAttribute: 'objectGUID',
  useMemberOf: true,
  groupBaseDn: '',
  groupFilter: GROUP_OF_NAMES_FILTER,
  groupNameAttribute: 'cn',
  activeDirectory: false,
  timeoutMs: 8000,
};

export interface PresetInfo {
  kind: IdpKind;
  /** Default display name ("Keycloak ile giriş yap"). */
  name: string;
  icon: IconName;
  /** Placeholder of the issuer / server URL field. */
  urlHint: string;
  oidc?: Partial<OidcForm>;
  saml?: Partial<SamlForm>;
  ldap?: Partial<LdapForm>;
}

/** Order of the "Ekle" menu. */
export const PRESET_ORDER: IdpPreset[] = [
  'keycloak',
  'entra',
  'google',
  'okta',
  'oidc',
  'saml',
  'active_directory',
  'openldap',
];

export const PRESETS: Record<IdpPreset, PresetInfo> = {
  keycloak: {
    kind: 'oidc',
    name: 'Keycloak',
    icon: 'key',
    urlHint: 'https://<host>/realms/<realm>',
    oidc: { groupsClaim: 'groups' },
  },
  entra: {
    kind: 'oidc',
    name: 'Microsoft Entra ID',
    icon: 'key',
    urlHint: 'https://login.microsoftonline.com/<tenant>/v2.0',
    oidc: { groupsClaim: 'groups', prompt: 'select_account' },
  },
  google: {
    kind: 'oidc',
    name: 'Google Workspace',
    icon: 'key',
    urlHint: 'https://accounts.google.com',
    oidc: { issuer: 'https://accounts.google.com', prompt: 'select_account' },
  },
  okta: {
    kind: 'oidc',
    name: 'Okta',
    icon: 'key',
    urlHint: 'https://<org>.okta.com/oauth2/default',
    oidc: { scopes: 'openid email profile groups', groupsClaim: 'groups' },
  },
  oidc: { kind: 'oidc', name: 'OpenID Connect', icon: 'key', urlHint: 'https://idp.example.com' },
  saml: {
    kind: 'saml',
    name: 'SAML 2.0',
    icon: 'shield',
    urlHint: 'https://idp.example.com/saml/sso',
  },
  active_directory: {
    kind: 'ldap',
    name: 'Active Directory',
    icon: 'server',
    urlHint: 'ldaps://dc01.corp.example.com:636',
    ldap: {
      uidAttribute: 'objectGUID',
      activeDirectory: true,
      userFilter: AD_USER_FILTER,
      useMemberOf: true,
      nameAttribute: 'displayName',
      emailAttribute: 'mail',
    },
  },
  openldap: {
    kind: 'ldap',
    name: 'OpenLDAP',
    icon: 'server',
    urlHint: 'ldaps://ldap.example.com:636',
    ldap: {
      uidAttribute: 'entryUUID',
      activeDirectory: false,
      userFilter: OPENLDAP_USER_FILTER,
      useMemberOf: false,
      groupFilter: GROUP_OF_NAMES_FILTER,
      nameAttribute: 'cn',
      emailAttribute: 'mail',
    },
  },
};

export const KIND_ICON: Record<IdpKind, IconName> = { oidc: 'key', saml: 'shield', ldap: 'server' };

/** A fresh form for "Ekle › <preset>". */
export function formForPreset(preset: IdpPreset): ProviderForm {
  const p = PRESETS[preset];
  return {
    kind: p.kind,
    preset,
    name: p.name,
    enabled: true,
    domains: [],
    enforceSso: false,
    jitProvisioning: true,
    defaultRole: 'member',
    linkExistingByEmail: true,
    trustIdpMfa: false,
    syncRoles: true,
    syncEnabled: true,
    roleMappings: [],
    oidc: { ...OIDC_DEFAULTS, ...p.oidc },
    saml: { ...SAML_DEFAULTS, ...p.saml },
    ldap: { ...LDAP_DEFAULTS, ...p.ldap },
    secret: '',
  };
}

/** The form of a saved provider; the stored config fills the part of its kind. */
export function providerToForm(p: IdentityProvider): ProviderForm {
  const base = formForPreset(p.preset);
  const form: ProviderForm = {
    ...base,
    kind: p.kind,
    name: p.name,
    enabled: p.enabled,
    domains: [...p.domains],
    enforceSso: p.enforceSso,
    jitProvisioning: p.jitProvisioning,
    defaultRole: p.defaultRole,
    linkExistingByEmail: p.linkExistingByEmail,
    trustIdpMfa: p.trustIdpMfa,
    syncRoles: p.syncRoles,
    syncEnabled: p.syncEnabled,
    roleMappings: p.roleMappings.map((m) => ({ ...m })),
    secret: '',
  };
  if (p.kind === 'oidc') {
    const c = p.config as OidcIdpConfig;
    form.oidc = { ...c, prompt: c.prompt ?? '' };
  } else if (p.kind === 'saml') {
    const c = p.config as SamlIdpConfig;
    form.saml = { ...c, logoutUrl: c.logoutUrl ?? '' };
  } else {
    const c = p.config as LdapConfig;
    form.ldap = { ...c, caCert: c.caCert ?? '' };
  }
  return form;
}

const trimmed = <T extends object>(o: T): T =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]),
  ) as T;

function oidcConfig(f: OidcForm): OidcIdpConfig {
  const c = trimmed(f);
  return { ...c, prompt: c.prompt || null };
}

function samlConfig(f: SamlForm): SamlIdpConfig {
  const c = trimmed(f);
  return { ...c, logoutUrl: c.logoutUrl || null };
}

function ldapConfig(f: LdapForm): LdapConfig {
  const c = trimmed(f);
  return { ...c, caCert: c.caCert || null };
}

export function configOf(f: ProviderForm): OidcIdpConfig | SamlIdpConfig | LdapConfig {
  return f.kind === 'oidc'
    ? oidcConfig(f.oidc)
    : f.kind === 'saml'
      ? samlConfig(f.saml)
      : ldapConfig(f.ldap);
}

/** Mappings with an empty group or no target are dropped (the editor shows them as invalid). */
export function cleanMappings(rows: IdpRoleMapping[]): IdpRoleMapping[] {
  return rows
    .map((m) => ({
      group: m.group.trim(),
      orgRole: m.orgRole ?? null,
      spaceId: m.spaceId ?? null,
      spaceRole: m.spaceId ? (m.spaceRole ?? 'viewer') : null,
    }))
    .filter((m) => m.group && (m.orgRole || m.spaceId));
}

export function formToCreate(f: ProviderForm): CreateIdentityProviderInput {
  const common = {
    name: f.name.trim(),
    preset: f.preset,
    enabled: f.enabled,
    domains: f.domains,
    enforceSso: f.kind === 'ldap' ? false : f.enforceSso,
    jitProvisioning: f.jitProvisioning,
    defaultRole: f.defaultRole,
    linkExistingByEmail: f.linkExistingByEmail,
    trustIdpMfa: f.trustIdpMfa,
    syncRoles: f.syncRoles,
    roleMappings: cleanMappings(f.roleMappings),
  };
  if (f.kind === 'oidc') {
    return {
      ...common,
      kind: 'oidc',
      config: oidcConfig(f.oidc),
      ...(f.secret ? { clientSecret: f.secret } : {}),
    };
  }
  if (f.kind === 'saml') return { ...common, kind: 'saml', config: samlConfig(f.saml) };
  return {
    ...common,
    kind: 'ldap',
    config: ldapConfig(f.ldap),
    syncEnabled: f.syncEnabled,
    ...(f.secret ? { bindPassword: f.secret } : {}),
  };
}

/** Full update of a saved provider; secrets only when a new one was typed. */
export function formToUpdate(f: ProviderForm): UpdateIdentityProvider {
  const create: Record<string, unknown> = { ...formToCreate(f) };
  delete create.kind;
  delete create.preset;
  return create as UpdateIdentityProvider;
}

/** Required fields still empty (field keys of the form, per kind). */
export function missingFields(f: ProviderForm, hasStoredSecret: boolean): string[] {
  const out: string[] = [];
  if (!f.name.trim()) out.push('name');
  if (f.kind === 'oidc') {
    if (!f.oidc.issuer.trim()) out.push('issuer');
    if (!f.oidc.clientId.trim()) out.push('clientId');
    if (!f.secret && !hasStoredSecret) out.push('clientSecret');
  } else if (f.kind === 'saml') {
    if (!f.saml.entryPoint.trim()) out.push('entryPoint');
    if (!f.saml.idpIssuer.trim()) out.push('idpIssuer');
    if (f.saml.idpCert.trim().length < 20) out.push('idpCert');
  } else {
    if (!f.ldap.url.trim()) out.push('url');
    if (!f.ldap.baseDn.trim()) out.push('baseDn');
    if (f.ldap.userFilter.trim().length < 3) out.push('userFilter');
  }
  return out;
}

const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

/** "@example.com" / "Example.com" → "example.com"; null when it is not a domain. */
export function normalizeDomain(value: string): string | null {
  const d = value.trim().toLowerCase().replace(/^@/, '');
  return DOMAIN.test(d) ? d : null;
}

/** Card status (9.14): error wins, then off, then connected / not tested. */
export type ProviderHealth = 'error' | 'off' | 'connected' | 'untested';

export function providerHealth(p: Pick<IdentityProvider, 'enabled' | 'status'>): ProviderHealth {
  if (!p.enabled) return 'off';
  if (p.status.lastTestOk === false || p.status.lastSyncOk === false) return 'error';
  if (p.status.lastTestOk || p.status.lastLoginAt || p.status.linkedUsers > 0) return 'connected';
  return 'untested';
}
