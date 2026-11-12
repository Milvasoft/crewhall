import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { auditLogs, blobs, nodes, nodeVersions, shares, spaces } from '@crewhall/db';
import { UPLOAD_PART_SIZE } from '@crewhall/shared';
import { purgeTrash } from '../src/jobs/handlers';
import {
  Client,
  createTestApp,
  join,
  PASSWORD,
  setupWithOwner,
  uploadFile,
  type TestApp,
} from './helpers';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const MINI_PDF = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 300]/Contents 4 0 R>>endobj',
    '4 0 obj<</Length 30>>stream',
    '0 0 1 rg 20 20 160 260 re f',
    'endstream endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n'),
);

async function png(width = 640, height = 480) {
  return sharp({ create: { width, height, channels: 3, background: '#FBC419' } })
    .png()
    .toBuffer();
}

describe('Drive', () => {
  let app: TestApp;
  let owner: Client;
  let spaceId: string;
  let otherSpaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.isDefault)!.id;
    otherSpaceId = (await owner.api.call('createSpace', { body: { name: 'Arşiv', color: 's2' } }))
      .id;
  });
  afterAll(() => app.close());

  it('creates folders, refuses duplicate names and lists folders first with a cursor', async () => {
    const a = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Sunumlar' },
    });
    expect(a).toMatchObject({
      type: 'folder',
      parentId: null,
      myRole: 'owner',
      hasChildren: false,
    });
    await expect(
      owner.api.call('createFolder', { params: { spaceId }, body: { name: 'Sunumlar' } }),
    ).rejects.toMatchObject({ status: 409, code: 'node_name_taken', details: { nodeId: a.id } });
    await owner.api.call('createFolder', { params: { spaceId }, body: { name: 'Çizimler' } });
    await uploadFile(owner, { spaceId, name: 'a-dosya.txt', content: Buffer.from('a') });

    const first = await owner.api.call('listNodes', { params: { spaceId }, query: { limit: 2 } });
    expect(first.items.map((n) => n.name)).toEqual(['Çizimler', 'Sunumlar']);
    const second = await owner.api.call('listNodes', {
      params: { spaceId },
      query: { limit: 2, cursor: first.nextCursor! },
    });
    expect(second.items.map((n) => n.name)).toEqual(['a-dosya.txt']);
    expect(second.nextCursor).toBeNull();

    const renamed = await owner.api.call('updateNode', {
      params: { nodeId: a.id },
      body: { name: 'Sunum' },
    });
    expect(renamed.name).toBe('Sunum');
  });

  it("keeps the app's own folders out of lists, search and child counts and finds them by role", async () => {
    const sid = (await owner.api.call('createSpace', { body: { name: 'Sistem', color: 's3' } })).id;
    const images = await owner.api.call('createFolder', {
      params: { spaceId: sid },
      body: { name: 'Sayfa görselleri', system: 'page_images' },
    });
    // Asked again: the same folder, found by its role.
    const again = await owner.api.call('createFolder', {
      params: { spaceId: sid },
      body: { name: 'Sayfa görselleri', system: 'page_images' },
    });
    expect(again.id).toBe(images.id);
    // It holds no name: the person may still make a folder called that.
    const mine = await owner.api.call('createFolder', {
      params: { spaceId: sid },
      body: { name: 'Sayfa görselleri' },
    });
    expect(mine.id).not.toBe(images.id);

    const docs = await owner.api.call('createFolder', {
      params: { spaceId: sid },
      body: { name: 'Belgeler' },
    });
    const imports = await owner.api.call('createFolder', {
      params: { spaceId: sid },
      body: { parentId: docs.id, name: 'İçe aktarılan ekler', system: 'import_attachments' },
    });
    await uploadFile(owner, {
      spaceId: sid,
      parentId: imports.id,
      name: 'ek-notu.txt',
      content: Buffer.from('ek'),
    });

    const root = await owner.api.call('listNodes', { params: { spaceId: sid }, query: {} });
    expect(root.items.map((n) => n.id).sort()).toEqual([docs.id, mine.id].sort());
    // Its only child is the app's folder: nothing to open.
    expect(root.items.find((n) => n.id === docs.id)?.hasChildren).toBe(false);
    const inside = await owner.api.call('listNodes', {
      params: { spaceId: sid },
      query: { parentId: docs.id },
    });
    expect(inside.items).toEqual([]);

    const hits = await owner.api.call('searchNodes', {
      query: { q: 'İçe aktarılan', spaceId: sid, content: 'false' },
    });
    expect(hits.items.map((h) => h.node.id)).not.toContain(imports.id);
    // Still reachable by id: pages link to the files in it.
    expect((await owner.api.call('getNode', { params: { nodeId: imports.id } })).name).toBe(
      'İçe aktarılan ekler',
    );
  });

  it('processes uploads: content type, previews and the detail path', async () => {
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Görseller' },
    });
    const image = await png();
    const { node } = await uploadFile(owner, {
      spaceId,
      parentId: folder.id,
      name: 'logo.png',
      content: image,
      mime: 'application/octet-stream',
    });
    const detail = await owner.api.call('getNode', { params: { nodeId: node.id } });
    expect(detail).toMatchObject({ mime: 'image/png', preview: 'ready', sizeBytes: image.length });
    expect(detail.path.map((p) => p.name)).toEqual(['Görseller']);

    const preview = await owner.api.call('getPreview', {
      params: { nodeId: node.id },
      query: { kind: 'thumb_256' },
    });
    expect(preview.width).toBe(256);
    const thumb = Buffer.from(await (await fetch(preview.url)).arrayBuffer());
    expect((await sharp(thumb).metadata()).format).toBe('webp');

    const pdf = await uploadFile(owner, { spaceId, name: 'sunum.pdf', content: MINI_PDF });
    const pdfPreview = await owner.api.call('getPreview', {
      params: { nodeId: pdf.node.id },
      query: { kind: 'pdf_p1' },
    });
    expect(pdfPreview.height! > pdfPreview.width!).toBe(true);

    const text = await uploadFile(owner, { spaceId, name: 'not.txt', content: Buffer.from('x') });
    await expect(
      owner.api.call('getPreview', { params: { nodeId: text.node.id } }),
    ).rejects.toMatchObject({ status: 404, code: 'preview_unavailable' });
  });

  it('stores identical content once (dedup after upload)', async () => {
    const content = Buffer.from(`aynı içerik ${Date.now()}`);
    const one = await uploadFile(owner, { spaceId, name: 'kopya-1.txt', content });
    const two = await uploadFile(owner, { spaceId: otherSpaceId, name: 'kopya-2.txt', content });
    const rows = await app.deps.db
      .select()
      .from(blobs)
      .where(eq(blobs.sha256, sha(content)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.refCount).toBe(2);
    const versions = await app.deps.db
      .select({ blobId: nodeVersions.blobId })
      .from(nodeVersions)
      .where(sql`${nodeVersions.nodeId} in (${one.node.id}::uuid, ${two.node.id}::uuid)`);
    expect(new Set(versions.map((v) => v.blobId)).size).toBe(1);
    const dl = await owner.api.call('getDownloadUrl', { params: { nodeId: two.node.id } });
    expect(await (await fetch(dl.url)).text()).toBe(content.toString());
  });

  it('resumes a multipart upload and checks the stored size', async () => {
    const content = Buffer.alloc(UPLOAD_PART_SIZE + 1024, 7);
    const upload = await owner.api.call('createUpload', {
      body: { spaceId, parentId: null, name: 'büyük.bin', sizeBytes: content.length },
    });
    expect(upload.partCount).toBe(2);
    const { parts } = await owner.api.call('getUploadPartUrls', {
      params: { uploadId: upload.id },
      body: { partNumbers: [1] },
    });
    const put1 = await fetch(parts[0]!.url, {
      method: 'PUT',
      body: content.subarray(0, UPLOAD_PART_SIZE),
    });
    expect(put1.ok).toBe(true);

    // The connection drops; the client asks what the store already has.
    const resumed = await owner.api.call('getUpload', { params: { uploadId: upload.id } });
    expect(resumed.uploadedParts.map((p) => p.partNumber)).toEqual([1]);
    const rest = await owner.api.call('getUploadPartUrls', {
      params: { uploadId: upload.id },
      body: { partNumbers: [2] },
    });
    const put2 = await fetch(rest.parts[0]!.url, {
      method: 'PUT',
      body: content.subarray(UPLOAD_PART_SIZE),
    });
    const done = await owner.api.call('completeUpload', {
      params: { uploadId: upload.id },
      body: {
        parts: [
          { partNumber: 1, etag: resumed.uploadedParts[0]!.etag },
          { partNumber: 2, etag: put2.headers.get('etag')! },
        ],
      },
    });
    expect(done.node.sizeBytes).toBe(content.length);
    const dl = await owner.api.call('getDownloadUrl', { params: { nodeId: done.node.id } });
    expect(sha(Buffer.from(await (await fetch(dl.url)).arrayBuffer()))).toBe(sha(content));

    // Declared size does not match what was stored.
    const bad = await owner.api.call('createUpload', {
      body: { spaceId, parentId: null, name: 'yalan.bin', sizeBytes: 10 },
    });
    const urls = await owner.api.call('getUploadPartUrls', {
      params: { uploadId: bad.id },
      body: { partNumbers: [1] },
    });
    const res = await fetch(urls.parts[0]!.url, { method: 'PUT', body: Buffer.from('12345') });
    await expect(
      owner.api.call('completeUpload', {
        params: { uploadId: bad.id },
        body: { parts: [{ partNumber: 1, etag: res.headers.get('etag')! }] },
      }),
    ).rejects.toMatchObject({ code: 'upload_invalid', details: { reason: 'size_mismatch' } });
  });

  it('handles name clashes on upload: ask, version, rename, replace (3.14)', async () => {
    const first = await uploadFile(owner, {
      spaceId,
      name: 'rapor.txt',
      content: Buffer.from('v1'),
    });
    await expect(
      uploadFile(owner, { spaceId, name: 'rapor.txt', content: Buffer.from('v2') }),
    ).rejects.toMatchObject({ code: 'node_name_taken', details: { nodeId: first.node.id } });
    const v2 = await uploadFile(owner, {
      spaceId,
      name: 'rapor.txt',
      content: Buffer.from('v2'),
      onConflict: 'version',
    });
    expect(v2.node.id).toBe(first.node.id);
    expect(v2.version.version).toBe(2);
    const renamed = await uploadFile(owner, {
      spaceId,
      name: 'rapor.txt',
      content: Buffer.from('v3'),
      onConflict: 'rename',
    });
    expect(renamed.node.name).toBe('rapor (2).txt');
    await uploadFile(owner, {
      spaceId,
      name: 'rapor.txt',
      content: Buffer.from('v4'),
      onConflict: 'replace',
    });
    const versions = await owner.api.call('listVersions', { params: { nodeId: first.node.id } });
    expect(versions.items.map((v) => [v.version, v.current])).toEqual([[3, true]]);
  });

  it('signs inline URLs only for safe types (PDF yes, HTML and SVG never)', async () => {
    const pdf = await uploadFile(owner, { spaceId, name: 'okunur.pdf', content: MINI_PDF });
    const inline = await owner.api.call('getDownloadUrl', {
      params: { nodeId: pdf.node.id },
      query: { disposition: 'inline' },
    });
    expect(inline.disposition).toBe('inline');
    const res = await fetch(inline.url);
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(res.headers.get('content-type')).toBe('application/pdf');

    for (const [name, content] of [
      [
        'sayfa.html',
        Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>'),
      ],
      [
        'simge.svg',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      ],
    ] as const) {
      const f = await uploadFile(owner, {
        spaceId,
        name,
        content,
        mime: name.endsWith('svg') ? 'image/svg+xml' : 'text/html',
      });
      const forced = await owner.api.call('getDownloadUrl', {
        params: { nodeId: f.node.id },
        query: { disposition: 'inline' },
      });
      expect(forced.disposition, name).toBe('attachment');
      const r = await fetch(forced.url);
      expect(r.headers.get('content-disposition'), name).toMatch(/^attachment;/);
    }
    const plain = await owner.api.call('getDownloadUrl', { params: { nodeId: pdf.node.id } });
    expect(plain.disposition).toBe('attachment');
  });

  it('keeps versions and restores an old one on top', async () => {
    const f = await uploadFile(owner, { spaceId, name: 'sürüm.txt', content: Buffer.from('bir') });
    await uploadFile(owner, {
      spaceId,
      name: 'sürüm.txt',
      content: Buffer.from('iki'),
      nodeId: f.node.id,
    });
    const before = await owner.api.call('listVersions', { params: { nodeId: f.node.id } });
    const v1 = before.items.find((v) => v.version === 1)!;
    const restored = await owner.api.call('restoreVersion', {
      params: { nodeId: f.node.id, versionId: v1.id },
    });
    expect(restored).toMatchObject({ version: 3, current: true });
    const dl = await owner.api.call('getDownloadUrl', { params: { nodeId: f.node.id } });
    expect(await (await fetch(dl.url)).text()).toBe('bir');
    const old = await owner.api.call('getDownloadUrl', {
      params: { nodeId: f.node.id },
      query: { versionId: before.items.find((v) => v.version === 2)!.id },
    });
    expect(await (await fetch(old.url)).text()).toBe('iki');
  });

  it('enforces file size and quota limits', async () => {
    await owner.api.call('updateOrg', { body: { settings: { maxFileBytes: 100 } } });
    await expect(
      owner.api.call('createUpload', {
        body: { spaceId, parentId: null, name: 'x.bin', sizeBytes: 101 },
      }),
    ).rejects.toMatchObject({ status: 413, code: 'file_too_large' });
    await owner.api.call('updateOrg', { body: { settings: { maxFileBytes: 5 * 1024 ** 3 } } });

    const space = await owner.api.call('getSpace', { params: { spaceId: otherSpaceId } });
    await owner.api.call('updateSpace', {
      params: { spaceId: otherSpaceId },
      body: { quotaBytes: space.usedBytes + 50 },
    });
    await expect(
      owner.api.call('createUpload', {
        body: { spaceId: otherSpaceId, parentId: null, name: 'q.bin', sizeBytes: 51 },
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded', details: { scope: 'space' } });
    // An upload in progress reserves its size.
    const q1 = await owner.api.call('createUpload', {
      body: { spaceId: otherSpaceId, parentId: null, name: 'q1.bin', sizeBytes: 30 },
    });
    await expect(
      owner.api.call('createUpload', {
        body: { spaceId: otherSpaceId, parentId: null, name: 'q2.bin', sizeBytes: 30 },
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    // Aborting gives the reservation back.
    await owner.api.call('abortUpload', { params: { uploadId: q1.id } });
    await owner.api.call('abortUpload', {
      params: {
        uploadId: (
          await owner.api.call('createUpload', {
            body: { spaceId: otherSpaceId, parentId: null, name: 'q2.bin', sizeBytes: 30 },
          })
        ).id,
      },
    });
    await owner.api.call('updateSpace', {
      params: { spaceId: otherSpaceId },
      body: { quotaBytes: null },
    });

    const quota = await owner.api.call('getQuota');
    expect(quota).toMatchObject({ quotaBytes: null, warning: false, full: false });
    expect(quota.usedBytes).toBeGreaterThan(0);
  });

  it('reserves an upload once, however often it is resumed, and commits it once', async () => {
    const quota0 = await owner.api.call('getQuota');
    const used0 = (await owner.api.call('getSpace', { params: { spaceId: otherSpaceId } }))
      .usedBytes;
    const size = 1000;
    // Room for this upload plus exactly 10 more bytes.
    await owner.api.call('updateSpace', {
      params: { spaceId: otherSpaceId },
      body: { quotaBytes: used0 + size + 10 },
    });
    const upload = await owner.api.call('createUpload', {
      body: { spaceId: otherSpaceId, parentId: null, name: 'sürdür.bin', sizeBytes: size },
    });
    for (let i = 0; i < 3; i++)
      await owner.api.call('getUpload', { params: { uploadId: upload.id } });
    const { parts } = await owner.api.call('getUploadPartUrls', {
      params: { uploadId: upload.id },
      body: { partNumbers: [1] },
    });
    // While it runs, the quota shows committed bytes only…
    expect((await owner.api.call('getQuota')).usedBytes).toBe(quota0.usedBytes);
    // …and the reservation counts once: 10 more bytes fit, 11 do not.
    await expect(
      owner.api.call('createUpload', {
        body: { spaceId: otherSpaceId, parentId: null, name: 'fazla.bin', sizeBytes: 11 },
      }),
    ).rejects.toMatchObject({ code: 'quota_exceeded' });
    const small = await owner.api.call('createUpload', {
      body: { spaceId: otherSpaceId, parentId: null, name: 'sığar.bin', sizeBytes: 10 },
    });
    await owner.api.call('abortUpload', { params: { uploadId: small.id } });

    const put = await fetch(parts[0]!.url, { method: 'PUT', body: Buffer.alloc(size, 1) });
    await owner.api.call('getUpload', { params: { uploadId: upload.id } });
    const done = await owner.api.call('completeUpload', {
      params: { uploadId: upload.id },
      body: { parts: [{ partNumber: 1, etag: put.headers.get('etag')! }] },
    });
    expect((await owner.api.call('getQuota')).usedBytes).toBe(quota0.usedBytes + size);
    expect(
      (await owner.api.call('getSpace', { params: { spaceId: otherSpaceId } })).usedBytes,
    ).toBe(used0 + size);
    await owner.api.call('updateSpace', {
      params: { spaceId: otherSpaceId },
      body: { quotaBytes: null },
    });
    await owner.api.call('trashNodes', { body: { nodeIds: [done.node.id] } });
    await owner.api.call('purgeNodes', { body: { nodeIds: [done.node.id] } });
  });

  it('moves a subtree in one go, across spaces too, and refuses moving into itself', async () => {
    const root = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Proje' },
    });
    const child = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Alt', parentId: root.id },
    });
    const file = await uploadFile(owner, {
      spaceId,
      parentId: child.id,
      name: 'derin.txt',
      content: Buffer.from('12345'),
    });
    await expect(
      owner.api.call('moveNodes', {
        body: { nodeIds: [root.id], target: { spaceId, parentId: child.id } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_target' });

    const mert = await join(app, owner, 'mert@milvasoft.com', 'member');
    await owner.api.call('createShare', {
      params: { nodeId: root.id },
      body: { kind: 'user', userId: mert.me.user.id, role: 'viewer' },
    });
    await owner.api.call('createShare', { params: { nodeId: root.id }, body: { kind: 'link' } });

    const before = await app.deps.db.select().from(spaces).where(eq(spaces.id, otherSpaceId));
    const moved = await owner.api.call('moveNodes', {
      body: { nodeIds: [root.id], target: { spaceId: otherSpaceId, parentId: null } },
    });
    expect(moved.items[0]).toMatchObject({ spaceId: otherSpaceId, parentId: null });
    const [deep] = await app.deps.db.select().from(nodes).where(eq(nodes.id, file.node.id));
    expect(deep?.spaceId).toBe(otherSpaceId);
    expect(deep?.path.split('.')).toHaveLength(3);
    const after = await app.deps.db.select().from(spaces).where(eq(spaces.id, otherSpaceId));
    expect(after[0]!.usedBytes - before[0]!.usedBytes).toBe(5);
    // Person shares stay with the old space; the public link keeps working (3.13).
    const left = await app.deps.db
      .select({ kind: shares.kind })
      .from(shares)
      .where(eq(shares.nodeId, root.id));
    expect(left.map((s) => s.kind)).toEqual(['link']);
  });

  it('copies a folder instantly, sharing blobs', async () => {
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Kaynak' },
    });
    const content = Buffer.from(`kopyalanacak ${Date.now()}`);
    await uploadFile(owner, { spaceId, parentId: folder.id, name: 'a.txt', content });
    const copied = await owner.api.call('copyNodes', {
      body: { nodeIds: [folder.id], target: { spaceId: otherSpaceId, parentId: null } },
    });
    expect(copied.items[0]).toMatchObject({
      name: 'Kaynak',
      spaceId: otherSpaceId,
      hasChildren: true,
    });
    const [blob] = await app.deps.db
      .select()
      .from(blobs)
      .where(eq(blobs.sha256, sha(content)));
    expect(blob?.refCount).toBe(2);
    // Copying again next to the original gets a free name.
    const again = await owner.api.call('copyNodes', {
      body: { nodeIds: [folder.id], target: { spaceId, parentId: null } },
    });
    expect(again.items[0]?.name).toBe('Kaynak (2)');
  });

  it('trashes and restores subtrees, then purges and frees the space', async () => {
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Çöp test' },
    });
    const inner = await uploadFile(owner, {
      spaceId,
      parentId: folder.id,
      name: 'iç.txt',
      content: Buffer.from(`çöp ${Date.now()}`),
    });
    await owner.api.call('trashNodes', { body: { nodeIds: [folder.id] } });
    await expect(
      owner.api.call('getDownloadUrl', { params: { nodeId: inner.node.id } }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    const trash = await owner.api.call('listTrash', { params: { spaceId } });
    expect(trash.items.map((t) => t.name)).toContain('Çöp test');
    expect(trash.items.map((t) => t.name)).not.toContain('iç.txt');
    // The name is free again while the folder is in the trash.
    const twin = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Çöp test' },
    });

    const restored = await owner.api.call('restoreNodes', { body: { nodeIds: [folder.id] } });
    expect(restored.items[0]?.name).toBe('Çöp test (2)');
    expect(
      (await owner.api.call('getNode', { params: { nodeId: inner.node.id } })).deletedAt,
    ).toBeNull();

    await owner.api.call('trashNodes', { body: { nodeIds: [inner.node.id] } });
    await owner.api.call('trashNodes', { body: { nodeIds: [folder.id, twin.id] } });
    // Restoring the file alone puts it at the root: its folder is still in the trash.
    const alone = await owner.api.call('restoreNodes', { body: { nodeIds: [inner.node.id] } });
    expect(alone.items[0]?.parentId).toBeNull();

    const usedBefore = (await owner.api.call('getSpace', { params: { spaceId } })).usedBytes;
    await owner.api.call('trashNodes', { body: { nodeIds: [inner.node.id] } });
    await owner.api.call('purgeNodes', { body: { nodeIds: [inner.node.id] } });
    const usedAfter = (await owner.api.call('getSpace', { params: { spaceId } })).usedBytes;
    expect(usedBefore - usedAfter).toBe(inner.node.sizeBytes);
    await expect(
      owner.api.call('getNode', { params: { nodeId: inner.node.id } }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });

    // trash.purge removes what sat 30 days in the trash, and unreferenced blobs a day later.
    await app.deps.db
      .update(nodes)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(nodes.id, folder.id));
    await app.deps.db
      .update(nodes)
      .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(sql`${nodes.path} <@ (select path from ${nodes} where id = ${folder.id}::uuid)`);
    await app.deps.db
      .update(blobs)
      .set({ orphanedAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(blobs.refCount, 0));
    await purgeTrash({ ...app.deps, jobs: app.deps.jobs });
    expect(await app.deps.db.select().from(nodes).where(eq(nodes.id, folder.id))).toHaveLength(0);
    expect(await app.deps.db.select().from(blobs).where(eq(blobs.refCount, 0))).toHaveLength(0);
  });

  it('person shares widen access to a subtree only (doc 17 §5)', async () => {
    const secret = await owner.api.call('createSpace', { body: { name: 'Finans', color: 's5' } });
    const folder = await owner.api.call('createFolder', {
      params: { spaceId: secret.id },
      body: { name: 'Faturalar' },
    });
    const file = await uploadFile(owner, {
      spaceId: secret.id,
      parentId: folder.id,
      name: 'ekim.txt',
      content: Buffer.from('fatura'),
    });
    const other = await uploadFile(owner, {
      spaceId: secret.id,
      name: 'gizli.txt',
      content: Buffer.from('gizli'),
    });

    const zeynep = await join(app, owner, 'zeynep@milvasoft.com', 'member');
    const z = zeynep.person;
    await expect(z.api.call('getNode', { params: { nodeId: folder.id } })).rejects.toMatchObject({
      code: 'not_found',
    });

    const share = await owner.api.call('createShare', {
      params: { nodeId: folder.id },
      body: { kind: 'user', userId: zeynep.me.user.id, role: 'viewer' },
    });
    expect(share).toMatchObject({
      kind: 'user',
      role: 'viewer',
      grantee: { email: 'zeynep@milvasoft.com' },
    });
    const list = await z.api.call('listNodes', {
      params: { spaceId: secret.id },
      query: { parentId: folder.id },
    });
    expect(list.items.map((n) => [n.name, n.myRole])).toEqual([['ekim.txt', 'viewer']]);
    const dl = await z.api.call('getDownloadUrl', { params: { nodeId: file.node.id } });
    expect(await (await fetch(dl.url)).text()).toBe('fatura');
    await expect(
      z.api.call('getNode', { params: { nodeId: other.node.id } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(z.api.call('listNodes', { params: { spaceId: secret.id } })).rejects.toMatchObject(
      { code: 'not_found' },
    );
    await expect(
      z.api.call('updateNode', { params: { nodeId: file.node.id }, body: { name: 'x.txt' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await owner.api.call('updateShare', {
      params: { shareId: share.id },
      body: { role: 'editor' },
    });
    const sub = await z.api.call('createFolder', {
      params: { spaceId: secret.id },
      body: { name: 'Kasım', parentId: folder.id },
    });
    expect(sub.myRole).toBe('editor');
    // An editor cannot hand out more than editor, nor share with a link by default.
    const can = await join(app, owner, 'can@milvasoft.com', 'member');
    await z.api.call('createShare', {
      params: { nodeId: folder.id },
      body: { kind: 'user', userId: can.me.user.id, role: 'viewer' },
    });
    await expect(
      z.api.call('createShare', { params: { nodeId: folder.id }, body: { kind: 'link' } }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const shares = await owner.api.call('listShares', { params: { nodeId: file.node.id } });
    expect(shares.items.every((s) => s.inheritedFrom?.id === folder.id)).toBe(true);
    const search = await z.api.call('searchNodes', { query: { q: 'ekim' } });
    expect(search.items.map((h) => h.node.name)).toEqual(['ekim.txt']);
    const hidden = await z.api.call('searchNodes', { query: { q: 'gizli' } });
    expect(hidden.items).toHaveLength(0);

    await owner.api.call('deleteShare', { params: { shareId: share.id } });
    await expect(z.api.call('getNode', { params: { nodeId: folder.id } })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('public links: password, lock, download switch, expiry and folder scope (19.1-19.5)', async () => {
    const folder = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Müşteri' },
    });
    const file = await uploadFile(owner, {
      spaceId,
      parentId: folder.id,
      name: 'teklif.txt',
      content: Buffer.from('teklif'),
    });
    const outside = await uploadFile(owner, {
      spaceId,
      name: 'dışarıda.txt',
      content: Buffer.from('no'),
    });

    const link = await owner.api.call('createShare', {
      params: { nodeId: folder.id },
      body: { kind: 'link', password: 'gizli-1234' },
    });
    expect(link.url).toMatch(/\/s\//);
    const token = decodeURIComponent(link.url!.split('/s/')[1]!);
    const visitor = new Client(app);
    visitor.ip = '198.51.100.9';
    const locked = await visitor.api.call('getPublicShare', { params: { token } });
    expect(locked).toEqual({
      status: 'password_required',
      orgName: 'Milvasoft',
      sharedBy: { name: 'Ahmet Buğra Kösen' },
    });
    await expect(
      visitor.api.call('listPublicShareNodes', { params: { token } }),
    ).rejects.toMatchObject({
      code: 'share_password_required',
    });

    const errors = [];
    for (let i = 0; i < 5; i++) {
      errors.push(
        await visitor.api
          .call('unlockPublicShare', { params: { token }, body: { password: 'yanlış' } })
          .catch((e: { code: string; details: unknown }) => ({ code: e.code, details: e.details })),
      );
    }
    expect(errors[0]).toMatchObject({
      code: 'share_password_invalid',
      details: { remainingAttempts: 4 },
    });
    expect(errors[4]).toMatchObject({ code: 'share_locked' });
    // Another IP is not affected.
    const friend = new Client(app);
    friend.ip = '198.51.100.10';
    const { grant } = await friend.api.call('unlockPublicShare', {
      params: { token },
      body: { password: 'gizli-1234' },
    });
    const opened = await friend.api.call('getPublicShare', { params: { token }, query: { grant } });
    expect(opened).toMatchObject({
      status: 'ok',
      node: { name: 'Müşteri', type: 'folder' },
      allowDownload: true,
    });
    const kids = await friend.api.call('listPublicShareNodes', {
      params: { token },
      query: { grant },
    });
    expect(kids.items.map((n) => n.name)).toEqual(['teklif.txt']);
    const dl = await friend.api.call('getPublicDownloadUrl', {
      params: { token },
      query: { grant, nodeId: file.node.id },
    });
    expect(await (await fetch(dl.url)).text()).toBe('teklif');
    await expect(
      friend.api.call('getPublicDownloadUrl', {
        params: { token },
        query: { grant, nodeId: outside.node.id },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });

    await owner.api.call('updateShare', {
      params: { shareId: link.id },
      body: { allowDownload: false },
    });
    await expect(
      friend.api.call('getPublicDownloadUrl', {
        params: { token },
        query: { grant, nodeId: file.node.id },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await owner.api.call('updateShare', {
      params: { shareId: link.id },
      body: { expiresAt: new Date(Date.now() - 1000).toISOString() },
    });
    await expect(
      friend.api.call('getPublicShare', { params: { token }, query: { grant } }),
    ).rejects.toMatchObject({
      status: 410,
      code: 'share_expired',
      details: { sharedByName: 'Ahmet Buğra Kösen' },
    });
    const fresh = await owner.api.call('regenerateShareLink', { params: { shareId: link.id } });
    await expect(friend.api.call('getPublicShare', { params: { token } })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(fresh.url).not.toBe(link.url);

    await owner.api.call('deleteShare', { params: { shareId: link.id } });
    const freshToken = decodeURIComponent(fresh.url!.split('/s/')[1]!);
    await expect(
      friend.api.call('getPublicShare', { params: { token: freshToken } }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    const actions = (await app.deps.db.select({ a: auditLogs.action }).from(auditLogs)).map(
      (r) => r.a,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'share.link.create',
        'share.link.locked',
        'share.link.open',
        'share.delete',
      ]),
    );
  });

  it('favorites, recent and search', async () => {
    const a = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Favori A' },
    });
    const b = await owner.api.call('createFolder', {
      params: { spaceId },
      body: { name: 'Favori B' },
    });
    await owner.api.call('setFavorite', { params: { nodeId: a.id }, body: { favorite: true } });
    await owner.api.call('setFavorite', {
      params: { nodeId: b.id },
      body: { favorite: true, afterId: null },
    });
    expect((await owner.api.call('listFavorites')).items.map((n) => n.name)).toEqual([
      'Favori B',
      'Favori A',
    ]);
    expect((await owner.api.call('getNode', { params: { nodeId: a.id } })).favorite).toBe(true);
    await owner.api.call('setFavorite', { params: { nodeId: b.id }, body: { favorite: false } });
    expect((await owner.api.call('listFavorites')).items.map((n) => n.name)).toEqual(['Favori A']);

    await owner.api.call('markNodeOpened', { params: { nodeId: b.id } });
    await owner.api.call('markNodeOpened', { params: { nodeId: a.id } });
    const recent = await owner.api.call('listRecent', { query: { limit: 2 } });
    expect(recent.items.map((n) => n.name)).toEqual(['Favori A', 'Favori B']);

    const hits = await owner.api.call('searchNodes', { query: { q: 'favori' } });
    expect(hits.items.map((h) => h.node.name).sort()).toEqual(['Favori A', 'Favori B']);
    expect(hits.items[0]?.space.name).toBe('Milvasoft');
  });

  it('serves 302 redirects for browsers and keeps members without rights out', async () => {
    const file = await uploadFile(owner, {
      spaceId,
      name: 'yönlendir.txt',
      content: Buffer.from('302'),
    });
    const res = await owner.fetch(`http://localhost:3000/api/v1/nodes/${file.node.id}/download`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('X-Amz-Signature');

    const guest = await join(app, owner, 'misafir@example.com', 'guest');
    await expect(
      guest.person.api.call('getNode', { params: { nodeId: file.node.id } }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      (
        await guest.person.raw('POST', '/api/v1/uploads', {
          spaceId,
          parentId: null,
          name: 'x',
          sizeBytes: 1,
        })
      ).status,
    ).toBe(404);
    void PASSWORD;
    void and;
  });
});
