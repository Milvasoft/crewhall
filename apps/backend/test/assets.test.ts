import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaAssets } from '@crewhall/db';
import { Client, createTestApp, join, setupWithOwner, type TestApp } from './helpers';

let app: TestApp;
let owner: Client;
let member: Client;

const png = async (width: number, height: number, color = '#FBC419') =>
  (
    await sharp({ create: { width, height, channels: 4, background: color } })
      .png()
      .toBuffer()
  ).toString('base64');

/** GET /api/assets/:id like a browser without a session. */
const fetchAsset = (url: string) => new Client(app).fetch(url);

beforeAll(async () => {
  app = await createTestApp();
  ({ owner } = await setupWithOwner(app));
  member = (await join(app, owner, 'uye@milvasoft.com', 'member')).person;
});

afterAll(async () => {
  await app.close();
});

describe('profile photo (H5)', () => {
  it('crops, resizes to a 512 px JPEG and serves it without a session', async () => {
    const { imageUrl } = await member.api.call('uploadAvatar', {
      body: { data: await png(1200, 800), crop: { x: 300, y: 100, size: 600 } },
    });
    expect(imageUrl).toMatch(/\/api\/assets\/[0-9a-f-]{36}$/);
    expect((await member.api.call('me')).user.imageUrl).toBe(imageUrl);
    const res = await fetchAsset(imageUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 512, 512]);
  });

  it('replacing the photo removes the old file; deleting clears it', async () => {
    const first = (await member.api.call('me')).user.imageUrl!;
    const { imageUrl } = await member.api.call('uploadAvatar', {
      body: { data: `data:image/png;base64,${await png(300, 300, '#F38424')}` },
    });
    expect(imageUrl).not.toBe(first);
    expect((await fetchAsset(first)).status).toBe(404);
    await member.api.call('deleteAvatar');
    expect((await member.api.call('me')).user.imageUrl).toBeNull();
    expect((await fetchAsset(imageUrl)).status).toBe(404);
    expect(
      await app.deps.db.select().from(mediaAssets).where(eq(mediaAssets.kind, 'avatar')),
    ).toEqual([]);
  });

  it('refuses SVG, non-images and crops outside the picture', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
    ).toString('base64');
    await expect(member.api.call('uploadAvatar', { body: { data: svg } })).rejects.toMatchObject({
      code: 'image_invalid',
    });
    await expect(
      member.api.call('uploadAvatar', { body: { data: Buffer.from('hello').toString('base64') } }),
    ).rejects.toMatchObject({ code: 'image_invalid' });
    await expect(
      member.api.call('uploadAvatar', {
        body: { data: await png(200, 200), crop: { x: 150, y: 0, size: 100 } },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('brand images (H5)', () => {
  it('fits a logo into 1024×256, shows it on the public bootstrap, and removes it', async () => {
    const branding = await owner.api.call('uploadBrandAsset', {
      body: { slot: 'logoLight', data: await png(2000, 400) },
    });
    expect(branding.logoLightUrl).toMatch(/\/api\/assets\//);
    const boot = await new Client(app).api.call('bootstrap');
    expect(boot.branding.logoLightUrl).toBe(branding.logoLightUrl);
    const res = await fetchAsset(branding.logoLightUrl!);
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['png', 1024, 205]);

    const fav = await owner.api.call('uploadBrandAsset', {
      body: { slot: 'favicon', data: await png(300, 200) },
    });
    const icon = await sharp(
      Buffer.from(await (await fetchAsset(fav.faviconUrl!)).arrayBuffer()),
    ).metadata();
    expect([icon.width, icon.height]).toEqual([64, 64]);

    const cleared = await owner.api.call('deleteBrandAsset', { params: { slot: 'logoLight' } });
    expect(cleared.logoLightUrl).toBeNull();
    expect(cleared.faviconUrl).toBe(fav.faviconUrl);
    expect((await fetchAsset(branding.logoLightUrl!)).status).toBe(404);
  });

  it('needs the branding permission', async () => {
    await expect(
      member.api.call('uploadBrandAsset', { body: { slot: 'mark', data: await png(100, 100) } }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
