import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray, lt } from 'drizzle-orm';
import {
  microsoftApps,
  organizations,
  orgMembers,
  spaces,
  teamsDrafts,
  teamsLinkCodes,
  teamsLinks,
  type DbOrTx,
} from '@crewhall/db';
import { resources } from '@crewhall/i18n';
import { MICROSOFT_WEB_PATHS, paths, type OrgSettings, type TeamsDraft } from '@crewhall/shared';
import { strToU8, zipSync } from 'fflate';
import type { Context } from 'hono';
import { createLocalJWKSet, decodeJwt, jwtVerify, type JSONWebKeySet } from 'jose';
import sharp from 'sharp';
import { z } from 'zod';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { AppEnv, OrgRow, RequestInfo } from '../../http/types';
import type { DriveActor } from '../drive/access';
import { searchNodes } from '../drive/personal';
import { identityAudit } from '../identity/audit';
import { randomBase62, sha256 } from '../identity/crypto';
import { toActor } from '../membership';
import { integrationClient, integrationOn, loadApp } from './app';
import { LOGIN_URL, msFetch } from './graph';

/**
 * Teams app (sonraki-isler.md): a message extension carried by the org's Azure Bot (search
 * Crewhall and share a link; "Crewhall'a kaydet" on a message) and a configurable tab that
 * shows a page or a board. The bot only answers invokes synchronously, so no bot secret is
 * needed: Crewhall checks the Bot Framework (or Entra) token and nothing more.
 */

export const BOT_FRAMEWORK_OPENID =
  'https://login.botframework.com/v1/.well-known/openidconfiguration';
const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
const LINK_CODE_MS = 10 * 60 * 1000;
const DRAFT_MS = 15 * 60 * 1000;

// ---- Bot Framework token -------------------------------------------------------------------

const jwksCache = new Map<string, { at: number; keys: ReturnType<typeof createLocalJWKSet> }>();

async function jwksFrom(url: string) {
  const hit = jwksCache.get(url);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.keys;
  const res = await msFetch(url);
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const keys = createLocalJWKSet((await res.json()) as JSONWebKeySet);
  jwksCache.set(url, { at: Date.now(), keys });
  return keys;
}

export function forgetBotKeys() {
  jwksCache.clear();
}

/**
 * Tokens of the Bot Framework channel (issuer api.botframework.com) and of single-tenant bots
 * (issued by the tenant's Entra); the audience is the bot's app id either way.
 */
async function verifyBotToken(header: string | undefined) {
  const token = /^Bearer\s+(\S+)$/i.exec(header ?? '')?.[1];
  if (!token) return null;
  let claims: { iss?: string; aud?: unknown; tid?: string };
  try {
    claims = decodeJwt(token);
  } catch {
    return null;
  }
  const aud = typeof claims.aud === 'string' ? claims.aud : null;
  if (!aud || !claims.iss) return null;
  let jwksUrl: string;
  const tenant =
    /^https:\/\/(?:sts\.windows\.net\/([\w-]+)\/|login\.microsoftonline\.com\/([\w-]+)\/v2\.0)$/.exec(
      claims.iss,
    );
  if (claims.iss === BOT_FRAMEWORK_ISSUER) {
    const config = (await (await msFetch(BOT_FRAMEWORK_OPENID)).json()) as { jwks_uri?: string };
    if (!config.jwks_uri) return null;
    jwksUrl = config.jwks_uri;
  } else if (tenant) {
    jwksUrl = `${LOGIN_URL}/${tenant[1] ?? tenant[2]}/discovery/v2.0/keys`;
  } else {
    return null;
  }
  try {
    await jwtVerify(token, await jwksFrom(jwksUrl), {
      issuer: claims.iss,
      audience: aud,
      clockTolerance: 300,
    });
  } catch {
    return null;
  }
  return { botAppId: aud };
}

// ---- links between Teams people and Crewhall people ----------------------------------------

export async function createLinkCode(db: DbOrTx, orgId: string, userId: string) {
  const code = randomBase62(24);
  const expiresAt = new Date(Date.now() + LINK_CODE_MS);
  await db.delete(teamsLinkCodes).where(lt(teamsLinkCodes.expiresAt, new Date()));
  await db.insert(teamsLinkCodes).values({ codeHash: sha256(code), orgId, userId, expiresAt });
  return { code, expiresAt: expiresAt.toISOString() };
}

async function linkedActor(db: DbOrTx, org: OrgRow, tenantId: string, aadObjectId: string) {
  const [row] = await db
    .select({ member: orgMembers })
    .from(teamsLinks)
    .innerJoin(
      orgMembers,
      and(eq(orgMembers.userId, teamsLinks.userId), eq(orgMembers.organizationId, org.id)),
    )
    .where(
      and(
        eq(teamsLinks.orgId, org.id),
        eq(teamsLinks.tenantId, tenantId),
        eq(teamsLinks.aadObjectId, aadObjectId),
      ),
    );
  if (!row || row.member.status !== 'active') return null;
  const a: DriveActor = { org, actor: toActor(row.member), userId: row.member.userId };
  return a;
}

async function redeemCode(
  db: DbOrTx,
  org: OrgRow,
  tenantId: string,
  aadObjectId: string,
  code: string,
  req: RequestInfo,
) {
  const [row] = await db
    .delete(teamsLinkCodes)
    .where(and(eq(teamsLinkCodes.codeHash, sha256(code.trim())), eq(teamsLinkCodes.orgId, org.id)))
    .returning();
  if (!row || row.expiresAt.getTime() <= Date.now()) return false;
  await db
    .insert(teamsLinks)
    .values({ orgId: org.id, tenantId, aadObjectId, userId: row.userId })
    .onConflictDoUpdate({
      target: [teamsLinks.orgId, teamsLinks.tenantId, teamsLinks.aadObjectId],
      set: { userId: row.userId, createdAt: new Date() },
    });
  await identityAudit(
    db,
    {
      orgId: org.id,
      actorId: row.userId,
      action: 'microsoft.teams.link',
      targetType: 'user',
      targetId: row.userId,
      meta: { tenantId, aadObjectId },
    },
    req,
  );
  return true;
}

// ---- drafts of "Crewhall'a kaydet" ----------------------------------------------------------

/** Teams message HTML to text: tags out, breaks and paragraphs kept, entities decoded. */
export function htmlToText(html: string) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function getDraft(db: DbOrTx, orgId: string, draftId: string): Promise<TeamsDraft> {
  const [row] = await db
    .select()
    .from(teamsDrafts)
    .where(
      and(
        eq(teamsDrafts.id, draftId),
        eq(teamsDrafts.orgId, orgId),
        gt(teamsDrafts.expiresAt, new Date()),
      ),
    );
  if (!row) throw new AppError('not_found');
  return {
    id: row.id,
    title: row.title,
    text: row.text,
    from: row.from,
    sentAt: row.sentAt?.toISOString() ?? null,
    link: row.link,
  };
}

// ---- the bot's invoke handler ---------------------------------------------------------------

const Activity = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  from: z.looseObject({ aadObjectId: z.string().optional() }).optional(),
  channelData: z.looseObject({ tenant: z.looseObject({ id: z.string() }).optional() }).optional(),
  conversation: z.looseObject({ tenantId: z.string().optional() }).optional(),
  value: z.unknown().optional(),
});

const QueryValue = z.looseObject({
  commandId: z.string(),
  parameters: z.array(z.looseObject({ name: z.string(), value: z.unknown() })).optional(),
  queryOptions: z
    .looseObject({ skip: z.number().optional(), count: z.number().optional() })
    .optional(),
  state: z.string().optional(),
});

const FetchTaskValue = z.looseObject({
  commandId: z.string(),
  messagePayload: z
    .looseObject({
      subject: z.string().nullish(),
      body: z
        .looseObject({ content: z.string().nullish(), contentType: z.string().nullish() })
        .nullish(),
      from: z
        .looseObject({ user: z.looseObject({ displayName: z.string().nullish() }).nullish() })
        .nullish(),
      createdDateTime: z.string().nullish(),
      linkToMessage: z.string().nullish(),
    })
    .optional(),
});

const hub = (env: Env) => env.HUB_URL.replace(/\/+$/, '');

async function orgByBot(db: DbOrTx, botAppId: string) {
  const [row] = await db
    .select({ org: organizations })
    .from(microsoftApps)
    .innerJoin(organizations, eq(organizations.id, microsoftApps.orgId))
    .where(eq(microsoftApps.teamsBotAppId, botAppId));
  return (row?.org as OrgRow | undefined) ?? null;
}

async function searchResult(deps: Deps, a: DriveActor, query: string, locale: 'tr' | 'en') {
  const t = resources[locale].email.microsoft.teams;
  const term = query.trim();
  const found =
    term.length >= 2 ? await searchNodes(deps.db, a, { q: term, limit: 15 }) : { items: [] };
  const slugs = new Map(
    found.items.length
      ? (
          await deps.db
            .select({ id: spaces.id, slug: spaces.slug })
            .from(spaces)
            .where(inArray(spaces.id, [...new Set(found.items.map((h) => h.space.id))]))
        ).map((s) => [s.id, s.slug])
      : [],
  );
  const attachments = found.items.map((hit) => {
    const n = hit.node;
    const slug = slugs.get(hit.space.id) ?? hit.space.id;
    const path =
      n.type === 'page'
        ? paths.page(n.id)
        : n.type === 'board'
          ? paths.board(n.id)
          : n.type === 'drawing'
            ? paths.drawing(n.id)
            : n.type === 'folder'
              ? paths.driveFolder(slug, n.id)
              : n.parentId
                ? paths.driveFolder(slug, n.parentId)
                : paths.driveSpace(slug);
    const url = `${hub(deps.env)}${path}`;
    const subtitle = `${t.types[n.type]} · ${hit.space.name}`;
    const card = {
      title: n.name,
      subtitle,
      tap: { type: 'openUrl', value: url },
      buttons: [{ type: 'openUrl', title: t.open, value: url }],
    };
    return {
      contentType: 'application/vnd.microsoft.card.thumbnail',
      content: card,
      preview: {
        contentType: 'application/vnd.microsoft.card.thumbnail',
        content: { title: n.name, subtitle },
      },
    };
  });
  return {
    composeExtension: {
      type: 'result',
      attachmentLayout: 'list',
      attachments,
      ...(attachments.length ? {} : { text: t.noResults }),
    },
  };
}

/** POST from the Bot Framework (MICROSOFT_RAW_PATHS.teamsMessages). */
export async function handleTeamsActivity(deps: Deps, c: Context<AppEnv>, req: RequestInfo) {
  const verified = await verifyBotToken(c.req.header('authorization')).catch(() => null);
  if (!verified) return c.json({ error: 'unauthorized' }, 401);
  const org = await orgByBot(deps.db, verified.botAppId);
  if (!org || !integrationOn(org.settings as OrgSettings, 'teams')) {
    return c.json({ error: 'integration_disabled' }, 403);
  }
  const parsed = Activity.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
  const activity = parsed.data;
  // Messages, installs and other notifications need no answer.
  if (activity.type !== 'invoke') return c.body(null, 200);
  const locale = (org.settings as OrgSettings).defaultLocale;
  const t = resources[locale].email.microsoft.teams;
  const tenantId = activity.channelData?.tenant?.id ?? activity.conversation?.tenantId ?? '';
  const aadObjectId = activity.from?.aadObjectId ?? '';

  if (activity.name === 'composeExtension/query') {
    const value = QueryValue.safeParse(activity.value);
    if (!value.success) return c.json({}, 200);
    let a = tenantId && aadObjectId ? await linkedActor(deps.db, org, tenantId, aadObjectId) : null;
    if (!a && value.data.state && tenantId && aadObjectId) {
      if (await redeemCode(deps.db, org, tenantId, aadObjectId, value.data.state, req)) {
        a = await linkedActor(deps.db, org, tenantId, aadObjectId);
      }
    }
    if (!a) {
      return c.json({
        composeExtension: {
          type: 'auth',
          suggestedActions: {
            actions: [
              {
                type: 'openUrl',
                value: `${hub(deps.env)}${MICROSOFT_WEB_PATHS.teamsLink}`,
                title: t.connect,
              },
            ],
          },
        },
      });
    }
    const query = value.data.parameters?.find((p) => p.name === 'query')?.value;
    return c.json(await searchResult(deps, a, typeof query === 'string' ? query : '', locale));
  }

  if (activity.name === 'composeExtension/fetchTask') {
    const value = FetchTaskValue.safeParse(activity.value);
    const message = value.success ? value.data.messagePayload : undefined;
    const text = htmlToText(message?.body?.content ?? '');
    const title = message?.subject?.trim() || text.split('\n')[0]?.slice(0, 120) || t.save;
    const sentAt = message?.createdDateTime ? new Date(message.createdDateTime) : null;
    const id = randomUUID();
    await deps.db.delete(teamsDrafts).where(lt(teamsDrafts.expiresAt, new Date()));
    await deps.db.insert(teamsDrafts).values({
      id,
      orgId: org.id,
      title: title.slice(0, 300),
      text: text.slice(0, 100_000),
      from: message?.from?.user?.displayName ?? null,
      sentAt: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt : null,
      link: message?.linkToMessage?.startsWith('https://') ? message.linkToMessage : null,
      expiresAt: new Date(Date.now() + DRAFT_MS),
    });
    const client = await integrationClient(deps.db, org.id, 'teams');
    const url = `${hub(deps.env)}${MICROSOFT_WEB_PATHS.teamsSave}?draft=${id}&client=${encodeURIComponent(client?.clientId ?? '')}`;
    return c.json({
      task: {
        type: 'continue',
        value: { title: t.save, height: 540, width: 560, url, fallbackUrl: url },
      },
    });
  }

  // submitAction (the dialog closed) and anything else: nothing to insert into the chat.
  return c.json({}, 200);
}

// ---- the app package ------------------------------------------------------------------------

const MARK_PATHS = [
  'M26.17 28.13A14.219 14.219 0 0 1 21.514 29.948A2.718 2.718 0 0 1 20.457 24.615A8.783 8.783 0 0 0 23.333 23.492A2.718 2.718 0 0 1 26.17 28.13ZM12.919 28.969A14.219 14.219 0 0 1 8.791 26.149A2.718 2.718 0 0 1 12.598 22.269A8.783 8.783 0 0 0 15.148 24.01A2.718 2.718 0 0 1 12.919 28.969ZM4.751 18.499A14.219 14.219 0 0 1 4.751 13.501A2.718 2.718 0 0 1 10.104 14.456A8.783 8.783 0 0 0 10.104 17.544A2.718 2.718 0 0 1 4.751 18.499ZM8.791 5.851A14.219 14.219 0 0 1 12.919 3.031A2.718 2.718 0 0 1 15.148 7.99A8.783 8.783 0 0 0 12.598 9.731A2.718 2.718 0 0 1 8.791 5.851ZM21.514 2.052A14.219 14.219 0 0 1 26.17 3.87A2.718 2.718 0 0 1 23.333 8.508A8.783 8.783 0 0 0 20.457 7.385A2.718 2.718 0 0 1 21.514 2.052Z',
  'M14.149 16a4.6 4.6 0 1 0 9.201 0a4.6 4.6 0 1 0 -9.201 0Z',
];

/** The Crewhall mark: on the brand's yellow (color icon) or white on transparent (outline). */
async function icons() {
  const color = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#FBC419"/><g transform="translate(4 4) scale(0.75)"><path fill="#141516" d="${MARK_PATHS[0]}"/><path fill="#141516" d="${MARK_PATHS[1]}"/></g></svg>`;
  const outline = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path fill="#FFFFFF" d="${MARK_PATHS[0]}"/><path fill="#FFFFFF" d="${MARK_PATHS[1]}"/></svg>`;
  return {
    color: await sharp(Buffer.from(color)).resize(192, 192).png().toBuffer(),
    outline: await sharp(Buffer.from(outline)).resize(32, 32).png().toBuffer(),
  };
}

export async function teamsManifest(
  deps: Pick<Deps, 'db' | 'env'>,
  org: Pick<OrgRow, 'id' | 'name' | 'settings'>,
) {
  const app = await loadApp(deps.db, org.id);
  const client = await integrationClient(deps.db, org.id, 'teams');
  if (!app?.teamsBotAppId || !app.teamsAppId || !client)
    throw new AppError('integration_disabled', { integration: 'teams' });
  const t = resources[org.settings.defaultLocale].email.microsoft.teams;
  const base = hub(deps.env);
  const api = deps.env.API_URL.replace(/\/+$/, '');
  const cid = encodeURIComponent(client.clientId);
  return {
    $schema:
      'https://developer.microsoft.com/en-us/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
    manifestVersion: '1.17',
    version: '1.0.0',
    id: app.teamsAppId,
    developer: {
      name: org.name.slice(0, 32),
      websiteUrl: base,
      privacyUrl: base,
      termsOfUseUrl: base,
    },
    name: { short: 'Crewhall', full: 'Crewhall' },
    description: { short: t.shortDescription.slice(0, 80), full: t.fullDescription },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: '#FBC419',
    configurableTabs: [
      {
        configurationUrl: `${base}${MICROSOFT_WEB_PATHS.teamsTabConfig}?client=${cid}`,
        canUpdateConfiguration: true,
        scopes: ['team', 'groupChat'],
        context: ['channelTab', 'privateChatTab', 'meetingChatTab'],
      },
    ],
    composeExtensions: [
      {
        botId: app.teamsBotAppId,
        commands: [
          {
            id: 'searchCrewhall',
            type: 'query',
            title: t.search,
            description: t.searchHint,
            initialRun: false,
            parameters: [
              { name: 'query', title: t.search, description: t.searchHint, inputType: 'text' },
            ],
          },
          {
            id: 'saveToCrewhall',
            type: 'action',
            title: t.save,
            description: t.saveDescription,
            context: ['message'],
            fetchTask: true,
          },
        ],
      },
    ],
    permissions: ['identity'],
    validDomains: [...new Set([new URL(base).host, new URL(api).host])],
  };
}

export async function teamsPackage(
  deps: Pick<Deps, 'db' | 'env'>,
  org: Pick<OrgRow, 'id' | 'name' | 'settings'>,
) {
  const manifest = await teamsManifest(deps, org);
  const { color, outline } = await icons();
  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'color.png': color,
    'outline.png': outline,
  });
}
