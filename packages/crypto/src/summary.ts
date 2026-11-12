import { expiryOf } from './health';
import type { ItemPayload, ItemType } from './item';
import { totpSourceOf } from './totp';

/**
 * What a list row needs from an item, and nothing more: no password, key, card number or
 * note body. Lists, search and pickers work on summaries; the full payload is decrypted only
 * for the item that is opened. Web and mobile use the same shape.
 */
export interface ItemSummary {
  type: ItemType;
  name: string;
  favorite: boolean;
  env: 'test' | 'prod' | null;
  tags: string[];
  /** Login / API key user name, identity e-mail. */
  username: string;
  /** First site: full URL and its host. */
  uri: string;
  host: string;
  /** Last four digits of a card number. */
  cardLast4: string;
  /** SSH key target (user@host:port). */
  sshHost: string;
  /** Identity full name. */
  fullName: string;
  /** API key / card expiry as YYYY-MM-DD, or null. */
  expiresAt: string | null;
  hasTotp: boolean;
  hasWarnings: boolean;
  /** Items imported from Bitwarden. */
  imported: boolean;
}

/** Host of a URL without the URL API (React Native's is incomplete). */
export function hostOf(url: string): string {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/?#]*@)?([^/?#:]+)(?::\d+)?/i.exec(url.trim());
  return m?.[1]?.toLowerCase() ?? url;
}

export function itemSummary(p: ItemPayload): ItemSummary {
  const expiry = expiryOf(p);
  const base: ItemSummary = {
    type: p.type,
    name: p.name,
    favorite: p.favorite,
    env: p.env,
    tags: p.tags,
    username: '',
    uri: '',
    host: '',
    cardLast4: '',
    sshHost: '',
    fullName: '',
    expiresAt: expiry ? expiry.toISOString().slice(0, 10) : null,
    hasTotp: Boolean(totpSourceOf(p)),
    hasWarnings: p.importWarnings.length > 0,
    imported: p.importedFrom === 'bitwarden',
  };
  switch (p.type) {
    case 'login':
      return {
        ...base,
        username: p.username,
        uri: p.uris[0] ?? '',
        host: p.uris[0] ? hostOf(p.uris[0]) : '',
      };
    case 'api_key':
      return { ...base, username: p.username, uri: p.url, host: p.url ? hostOf(p.url) : '' };
    case 'card':
      return { ...base, username: p.cardholder, cardLast4: p.number.replace(/\D/g, '').slice(-4) };
    case 'ssh_key':
      return { ...base, sshHost: p.host };
    case 'identity':
      return {
        ...base,
        username: p.email,
        fullName: [p.firstName, p.lastName].filter(Boolean).join(' '),
      };
    case 'note':
      return base;
  }
}
