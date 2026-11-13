import { resources, type AppLocale } from '@crewhall/i18n';
import { guessAlertSeverity, type AlertCard, type AlertSeverity } from '@crewhall/shared';

/**
 * Any JSON a tool posts to an incoming webhook, when it is not one of the known bodies (Crewhall
 * text/card, Google Chat text/cardsV2): a message is read from common field names instead of
 * answering 400 (kararlar.md 2026-11-13). An array becomes one message per element.
 */

export type HookMessage = { text: string; card: AlertCard | null };

/** Elements of an array body turned into messages; the rest is dropped. */
export const MAX_GENERIC_MESSAGES = 10;

const TITLE_KEYS = ['title', 'subject', 'name', 'event', 'type'];
const TEXT_KEYS = ['text', 'message', 'content', 'body', 'description', 'summary'];
const LINK_KEYS = [
  'url',
  'link',
  'html_url',
  'htmlurl',
  'releaseurl',
  'href',
  'permalink',
  'web_url',
  'weburl',
];
/** Links that point at something published (a post, a release): "Paylaşımı aç". */
const POST_LINK_KEYS = new Set(['releaseurl', 'permalink']);
const SEVERITY_KEYS = ['severity', 'level', 'status', 'state'];
const IMAGE_KEYS = [
  'picture',
  'avatar',
  'avatar_url',
  'avatarurl',
  'icon',
  'icon_url',
  'iconurl',
  'image',
  'logo',
];
const MAX_FIELDS = 8;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isHttp = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v);
const scalar = (v: unknown) =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
/** Ids say nothing to people reading the chat. */
const idLike = (key: string) => /^(id|uuid|guid)$|(_id|Id|_uuid)$/.test(key);
const stripTags = (s: string) =>
  s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

/** The value of the first of `keys` the object has (keys compared case-insensitively). */
function pick(o: Obj, keys: string[], test: (v: unknown) => boolean): [string, unknown] | null {
  const byLower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const want of keys) {
    const key = byLower.get(want);
    if (key !== undefined && test(o[key])) return [key, o[key]];
  }
  return null;
}

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/** A status word → severity; anything else is read like a text alert. */
function severityOf(status: string | null, fallback: string): AlertSeverity {
  if (status) {
    const s = status.toLowerCase();
    if (/(fail|error|critical|fatal|down|alert|panic|emerg)/.test(s)) return 'critical';
    if (/(warn|degrad)/.test(s)) return 'warning';
    if (/(success|succeed|\bok\b|pass|publish|done|complete|resolved|healthy|\bup\b)/.test(s)) {
      return 'success';
    }
    if (/(info|debug|notice|pending|queued|running|draft)/.test(s)) return 'info';
  }
  return guessAlertSeverity(fallback);
}

function fromObject(o: Obj, locale: AppLocale): HookMessage | null {
  const t = resources[locale].email.chat.integrations;
  const used = new Set<string>();
  const take = (hit: [string, unknown] | null) => {
    if (hit) used.add(hit[0]);
    return hit;
  };

  const titleHit = take(pick(o, TITLE_KEYS, nonEmpty));
  const textHit = take(pick(o, TEXT_KEYS, nonEmpty));
  const statusHit = take(pick(o, SEVERITY_KEYS, nonEmpty));
  const imageHit = take(pick(o, IMAGE_KEYS, isHttp));

  // A nested object that names something (an integration, a repository, a monitor): its name
  // stands in for the title and its picture for the icon.
  let nestedName: string | null = null;
  let nestedImage: string | null = null;
  for (const [key, value] of Object.entries(o)) {
    if (!isObj(value)) continue;
    const name = pick(value, ['name', 'title', 'displayname', 'display_name'], nonEmpty);
    if (name && !nestedName) nestedName = String(name[1]).trim();
    const image = pick(value, IMAGE_KEYS, isHttp);
    if (image && !nestedImage) nestedImage = String(image[1]);
    if (name || image) used.add(key);
  }

  const buttons: AlertCard['buttons'] = [];
  const addLink = (key: string, url: string) => {
    if (buttons.length >= 3 || buttons.some((b) => b.url === url)) return;
    buttons.push({ text: POST_LINK_KEYS.has(key.toLowerCase()) ? t.openPost : t.open, url });
  };
  for (const [key, value] of Object.entries(o)) {
    if (LINK_KEYS.includes(key.toLowerCase()) && isHttp(value)) {
      addLink(key, value);
      used.add(key);
    }
  }

  const fields: AlertCard['fields'] = [];
  const addField = (label: string, value: unknown) => {
    if (fields.length >= MAX_FIELDS || !scalar(value)) return;
    const v = String(value).trim();
    if (!v || v.length > 200 || /^https?:\/\//i.test(v)) return;
    fields.push({ label: label.slice(0, 100), value: v.slice(0, 1000) });
  };
  for (const [key, value] of Object.entries(o)) {
    if (used.has(key) || idLike(key)) continue;
    if (scalar(value)) addField(key, value);
  }
  // One level down: "integration.providerIdentifier: instagram".
  for (const [key, value] of Object.entries(o)) {
    if (!isObj(value)) continue;
    for (const [inner, v] of Object.entries(value)) {
      if (idLike(inner) || IMAGE_KEYS.includes(inner.toLowerCase())) continue;
      if (['name', 'title', 'displayname', 'display_name'].includes(inner.toLowerCase())) continue;
      if (LINK_KEYS.includes(inner.toLowerCase()) && isHttp(v)) addLink(inner, v);
      else addField(`${key}.${inner}`, v);
    }
  }
  if (statusHit) fields.unshift({ label: statusHit[0], value: String(statusHit[1]).trim() });

  const title = titleHit ? stripTags(String(titleHit[1])) : nestedName;
  const text = textHit ? stripTags(String(textHit[1])) : null;
  if (!title && !text && buttons.length === 0 && fields.length === 0) return null;
  // Only a sentence: a plain message reads better than a card around it.
  if (!title && text && buttons.length === 0 && fields.length === 0) {
    return { text: text.slice(0, 4000), card: null };
  }
  const icon = imageHit ? String(imageHit[1]) : nestedImage;
  const cardTitle = (title ?? text?.split('\n')[0] ?? 'Webhook').slice(0, 300);
  return {
    text: '',
    card: {
      severity: severityOf(
        statusHit ? String(statusHit[1]) : null,
        [cardTitle, text].filter(Boolean).join(' '),
      ),
      title: cardTitle || 'Webhook',
      subtitle: null,
      source: null,
      iconUrl: icon && isHttp(icon) ? icon : null,
      text: title && text ? text.slice(0, 4000) : null,
      fields: fields.slice(0, MAX_FIELDS),
      buttons,
    },
  };
}

/** Nothing readable: the body itself, shortened, as a code block. */
function asCode(json: unknown): HookMessage {
  const raw = JSON.stringify(json, null, 2) ?? String(json);
  const body = raw.length > 1500 ? `${raw.slice(0, 1500)}\n…` : raw;
  return { text: `\`\`\`json\n${body}\n\`\`\``, card: null };
}

function one(value: unknown, locale: AppLocale): HookMessage | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() ? { text: value.trim(), card: null } : null;
  if (scalar(value)) return { text: String(value), card: null };
  if (Array.isArray(value)) return value.length ? asCode(value) : null;
  if (isObj(value)) {
    if (Object.keys(value).length === 0) return null;
    return fromObject(value, locale) ?? asCode(value);
  }
  return null;
}

/** Messages for a body no known format matched; empty when there is nothing to say. */
export function genericMessages(json: unknown, locale: AppLocale): HookMessage[] {
  if (Array.isArray(json)) {
    return json
      .slice(0, MAX_GENERIC_MESSAGES)
      .map((item) => one(item, locale))
      .filter((m): m is HookMessage => m !== null);
  }
  const m = one(json, locale);
  return m ? [m] : [];
}
