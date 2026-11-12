import { resolveLocale, resources } from '@crewhall/i18n';
import { newId, users } from '@crewhall/db';
import { eq } from 'drizzle-orm';
import {
  can,
  officeExtensionOf,
  type CreateOfficeDocument,
  type DriveNode,
  type OfficeMode,
  type OfficeSession,
} from '@crewhall/shared';
import type { Deps } from '../../deps';
import { AppError } from '../../http/errors';
import { publishNodeChanges } from '../../realtime/events';
import {
  loadNode,
  nodeResource,
  requireNodeAction,
  toDriveNodes,
  type DriveActor,
} from '../drive/access';
import { commitFile, requireStorage } from '../drive/files';
import { container } from '../drive/nodes';
import { assertQuota } from '../drive/quota';
import { actionFor, actionUrl } from './discovery';
import { requireOffice } from './settings';
import { officeTemplate } from './templates';
import { issueWopiToken } from './token';
import { WOPI_PREFIX } from './wopi';
import { officeHostUrl, onlyofficeSession } from './onlyoffice';

/** Editor URL and access token for one file and person (WOPI host page data). */
export async function openOfficeSession(
  deps: Deps,
  a: DriveActor,
  nodeId: string,
  wanted: OfficeMode,
  locale: string | null,
): Promise<OfficeSession> {
  const cfg = await requireOffice(deps, a.org);
  const access = await loadNode(deps.db, a, nodeId);
  const ext = officeExtensionOf(access.node.name);
  if (access.node.type !== 'file' || !ext) throw new AppError('office_unsupported');
  const writable =
    !access.space.archivedAt && can(a.actor, 'space.edit_content', nodeResource(a, access.role));
  // The language the person chose in Crewhall; the browser's Accept-Language only as a fallback.
  const [me] = await deps.db
    .select({ locale: users.locale })
    .from(users)
    .where(eq(users.id, a.userId));
  const lang = me?.locale ?? resolveLocale(locale);
  const base = { nodeId: access.node.id, fileName: access.node.name };

  if (cfg.kind === 'onlyoffice') {
    const mode: OfficeMode = wanted === 'edit' && writable ? 'edit' : 'view';
    const s = await onlyofficeSession(deps, a, {
      node: access.node,
      ext,
      mode,
      lang,
      row: cfg.row,
      jwtSecret: cfg.jwtSecret,
    });
    return { kind: 'onlyoffice', ...base, mode, ...s };
  }

  let mode: OfficeMode = wanted === 'edit' && writable ? 'edit' : 'view';
  let action = actionFor(cfg.discovery, ext, mode);
  if (!action && mode === 'edit') {
    mode = 'view';
    action = actionFor(cfg.discovery, ext, 'view');
  }
  if (!action) throw new AppError('office_unsupported', { ext });
  const { token, expiresAt } = issueWopiToken(deps.env.AUTH_SECRET, {
    n: access.node.id,
    u: a.userId,
    o: a.org.id,
    w: mode === 'edit',
    p: 'wopi',
  });
  const url = actionUrl(
    action.urlsrc,
    `${officeHostUrl(deps)}${WOPI_PREFIX}/${access.node.id}`,
    lang,
  );
  return {
    kind: 'wopi',
    ...base,
    mode,
    actionUrl: url,
    accessToken: token,
    accessTokenTtl: expiresAt,
    editorOrigin: new URL(url).origin,
  };
}

/** A new empty document in a folder (or the space root), named after the request or "Adsız …". */
export async function createOfficeDocument(
  deps: Deps,
  a: DriveActor,
  input: CreateOfficeDocument,
  locale: string | null,
): Promise<DriveNode> {
  // New files only where they can be opened right away.
  await requireOffice(deps, a.org);
  const dest = await container(deps.db, a, input.spaceId, input.parentId);
  requireNodeAction(a, dest.role, 'space.edit_content');
  if (dest.space.archivedAt) throw new AppError('forbidden', { reason: 'archived' });
  const template = officeTemplate(input.kind, input.format);
  await assertQuota(deps.db, a.org, dest.space, template.bytes.length);
  const base =
    input.name?.trim() || resources[resolveLocale(locale)].web.office.untitled[input.kind];
  const name = `${base.replace(/\.(docx|xlsx|pptx|odt|ods|odp)$/i, '')}.${template.ext}`;

  const storage = requireStorage(deps);
  const storageKey = `orgs/${a.org.id}/blobs/${newId()}`;
  await storage.put(storageKey, Buffer.from(template.bytes), template.mime);
  const committed = await deps.db
    .transaction((tx) =>
      commitFile(tx, a, {
        spaceId: dest.space.id,
        parentId: dest.parent?.id ?? null,
        nodeId: null,
        name,
        storageKey,
        sizeBytes: template.bytes.length,
        mime: template.mime,
        source: 'web',
        replace: false,
      }),
    )
    .catch(async (err: unknown) => {
      await storage.delete(storageKey).catch(() => undefined);
      throw err;
    });
  await deps.jobs.send('blob.process', { blobId: committed.blobId });
  const access = await loadNode(deps.db, a, committed.nodeId);
  await publishNodeChanges(deps, [access.node], 'created');
  const [node] = await toDriveNodes(
    deps.db,
    a.userId,
    [access.node],
    new Map([[access.node.id, access.role!]]),
  );
  return node!;
}
