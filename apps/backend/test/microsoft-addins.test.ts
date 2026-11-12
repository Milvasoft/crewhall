import { createHash, randomBytes } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setMicrosoftFetch } from '../src/services/microsoft/graph';
import { BOT_FRAMEWORK_OPENID, forgetBotKeys } from '../src/services/microsoft/teams';
import { Client, createTestApp, setupWithOwner, type TestApp } from './helpers';

const API = 'http://localhost:3000';
const HUB = 'http://localhost:5173';
const CALLBACK = `${HUB}/office/callback`;
const BOT_APP_ID = '3c5e0f2a-1111-4c4c-8d8d-0123456789ab';
const TENANT = 'b0a1c2d3-2222-4e4e-9f9f-0123456789ab';
const AAD_USER = '5d6e7f80-3333-4a4a-8b8b-0123456789ab';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** What the bot answers to message extension invokes (the parts the tests read). */
interface InvokeResponse {
  composeExtension: {
    type: string;
    suggestedActions: { actions: { value: string }[] };
    attachments: { content: { title: string } }[];
  };
  task: { value: { url: string } };
}

/** Outlook add-in and Teams app: OIDC sign-in, integration bearer, saving, links, the bot. */
describe('Outlook add-in and Teams app', () => {
  let app: TestApp;
  let owner: Client;
  let addin: Client;
  let spaceId: string;
  let outlookClientId: string;

  beforeAll(async () => {
    app = await createTestApp();
    ({ owner } = await setupWithOwner(app));
    spaceId = (await owner.api.call('listSpaces')).items.find((s) => s.name === 'Altyapı')!.id;
    addin = new Client(app);
  }, 300_000);
  afterAll(async () => {
    setMicrosoftFetch(null);
    await app?.close();
  });

  /** The add-in's sign-in dialog: authorize with the browser session, then the code exchange. */
  async function signInAddin(clientId: string) {
    const { verifier, challenge } = pkce();
    const url = new URL(`${API}/api/oidc/authorize`);
    for (const [k, v] of Object.entries({
      client_id: clientId,
      redirect_uri: CALLBACK,
      response_type: 'code',
      scope: 'openid profile email offline_access',
      state: 's1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })) {
      url.searchParams.set(k, v);
    }
    const res = await owner.fetch(url.href, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get('location')!);
    expect(`${back.origin}${back.pathname}`).toBe(CALLBACK);
    const token = await app.app.request(`${API}/api/oidc/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code')!,
        redirect_uri: CALLBACK,
        client_id: clientId,
        code_verifier: verifier,
      }).toString(),
    });
    expect(token.status).toBe(200);
    return ((await token.json()) as { access_token: string }).access_token;
  }

  it('signs the add-in in with Crewhall OIDC and limits what its token may call', async () => {
    const overview = await owner.api.call('updateMicrosoftIntegration', {
      params: { integration: 'outlook' },
      body: { enabled: true },
    });
    outlookClientId = overview.outlook.clientId!;
    expect(outlookClientId).toMatch(/^crewhall-outlook-/);
    // The built-in client is not listed with the admin's own OIDC clients.
    const provider = await owner.api.call('getOidcProvider');
    expect(provider.clients.some((c) => c.clientId === outlookClientId)).toBe(false);

    addin.bearer = await signInAddin(outlookClientId);
    expect((await addin.api.call('me')).user.email).toBe('bugra@milvasoft.com');
    expect((await addin.api.call('listSpaces')).items.length).toBeGreaterThan(1);
    await expect(addin.api.call('listMembers', { query: {} as never })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('saves a mail as a page, a card and a chat message', async () => {
    const mail = {
      source: 'outlook' as const,
      title: 'Teklif: Pusula lisansı',
      from: { name: 'Ece Şahin', email: 'ece@nova.example' },
      sentAt: '2026-10-28T09:30:00.000Z',
      text: '# Merhaba\n\nTeklifimiz ektedir.\nİyi çalışmalar.',
      link: 'https://outlook.office.com/mail/id/AAMk',
    };
    const page = await addin.api.call('saveToCrewhall', {
      body: { ...mail, target: { kind: 'page', spaceId } },
    });
    expect(page.kind).toBe('page');
    const exported = await owner.api.call('exportPage', {
      params: { nodeId: page.id },
      query: {} as never,
    });
    const md = JSON.stringify(exported);
    expect(md).toContain('Kimden');
    expect(md).toContain('ece@nova.example');
    // Plain text never becomes a heading.
    expect(md).toContain('\\\\# Merhaba');

    const board = await owner.api.call('createBoard', {
      params: { spaceId },
      body: { name: 'Satış' } as never,
    });
    const card = await addin.api.call('saveToCrewhall', {
      body: { ...mail, target: { kind: 'card', boardId: board.id } },
    });
    expect(card.path).toMatch(new RegExp(`^/b/${board.id}/\\d+$`));

    const conversation = await owner.api.call('createConversation', {
      body: { type: 'space', spaceId, name: 'Altyapı sohbeti' },
    });
    const chat = await addin.api.call('saveToCrewhall', {
      body: { ...mail, target: { kind: 'chat', conversationId: conversation.id } },
    });
    expect(chat.path).toBe(`/chat/c/${conversation.id}`);
  });

  it('turns an attachment into a password-protected Drive link', async () => {
    const shared = await addin.api.call('shareAttachment', {
      body: {
        name: 'teklif.pdf',
        mime: 'application/pdf',
        contentBase64: Buffer.from('%PDF-1.4 teklif').toString('base64'),
        password: 'gizli-1234',
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      },
    });
    expect(shared.url.startsWith(`${HUB}/s/`)).toBe(true);
    expect(shared.passwordProtected).toBe(true);
    const token = shared.url.split('/s/')[1]!;
    const anon = new Client(app);
    const view = await anon.raw<{ status: string }>('GET', `/api/v1/public/shares/${token}`);
    expect(view.body.status).toBe('password_required');
  });

  it('gives out an upload link that only accepts files', async () => {
    const request = await addin.api.call('createUploadRequest', {
      body: { folderName: 'Ece Şahin yüklemeleri', password: 'yukle-1234' },
    });
    expect(request.url!.startsWith(`${HUB}/u/`)).toBe(true);
    const token = request.url!.split('/u/')[1]!;
    const anon = new Client(app);
    const info = await anon.api.call('getPublicUploadRequest', { params: { token } });
    expect(info).toMatchObject({ folderName: 'Ece Şahin yüklemeleri', passwordRequired: true });
    const file = {
      name: '../sozlesme.docx',
      mime: null,
      contentBase64: Buffer.from('sözleşme').toString('base64'),
    };
    await expect(
      anon.api.call('uploadToRequest', { params: { token }, body: file }),
    ).rejects.toMatchObject({ code: 'share_password_required' });
    const done = await anon.api.call('uploadToRequest', {
      params: { token },
      body: { ...file, password: 'yukle-1234', uploaderName: 'Ece' },
    });
    expect(done.name).toBe('.._sozlesme.docx'.replace(/^\.+/, ''));
    const listed = await owner.api.call('listNodes', {
      params: { spaceId: request.spaceId },
      query: { parentId: request.folderId } as never,
    });
    expect(listed.items.map((n) => n.name)).toContain(done.name);
    expect((await addin.api.call('listUploadRequests')).items[0]!.uploads).toBe(1);

    await addin.api.call('revokeUploadRequest', { params: { requestId: request.id } });
    await expect(
      anon.api.call('getPublicUploadRequest', { params: { token } }),
    ).rejects.toMatchObject({
      code: 'upload_request_closed',
    });
  });

  it('serves the manifest to admins and stops the add-in when switched off', async () => {
    const manifest = await owner.fetch(`${API}/api/integrations/outlook/manifest.xml`);
    expect(manifest.status).toBe(200);
    const xml = await manifest.text();
    expect(xml).toContain('xsi:type="MailApp"');
    expect(xml).toContain(`${HUB}/office/outlook?mode=compose&amp;client=${outlookClientId}`);
    expect(xml).toContain('MessageReadCommandSurface');

    await owner.api.call('updateMicrosoftIntegration', {
      params: { integration: 'outlook' },
      body: { enabled: false },
    });
    await expect(addin.api.call('me')).rejects.toMatchObject({ code: 'integration_disabled' });
  });

  describe('Teams bot', () => {
    let sign: (claims?: Record<string, unknown>) => Promise<string>;

    beforeAll(async () => {
      const { privateKey, publicKey } = await generateKeyPair('RS256');
      const jwk = { ...(await exportJWK(publicKey)), kid: 'bf-1', alg: 'RS256', use: 'sig' };
      const keysUrl = 'https://login.botframework.com/v1/.well-known/keys';
      forgetBotKeys();
      setMicrosoftFetch(async (input) => {
        const url = String(input);
        if (url === BOT_FRAMEWORK_OPENID) return Response.json({ jwks_uri: keysUrl });
        if (url === keysUrl) return Response.json({ keys: [jwk] });
        return new Response('not found', { status: 404 });
      });
      sign = (claims = {}) =>
        new SignJWT({ serviceurl: 'https://smba.trafficmanager.net/emea/', ...claims })
          .setProtectedHeader({ alg: 'RS256', kid: 'bf-1' })
          .setIssuer('https://api.botframework.com')
          .setAudience(BOT_APP_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
    });

    const invoke = async (name: string, value: unknown, token?: string) => {
      const res = await app.app.request(`${API}/api/integrations/teams/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token ?? (await sign())}`,
        },
        body: JSON.stringify({
          type: 'invoke',
          name,
          value,
          from: { id: '29:abc', aadObjectId: AAD_USER },
          recipient: { id: `28:${BOT_APP_ID}` },
          channelData: { tenant: { id: TENANT } },
        }),
      });
      return { status: res.status, body: (await res.json()) as InvokeResponse };
    };

    it('needs the bot id to switch on and builds the app package', async () => {
      await expect(
        owner.api.call('updateMicrosoftIntegration', {
          params: { integration: 'teams' },
          body: { enabled: true },
        }),
      ).rejects.toMatchObject({ code: 'validation_failed' });
      const overview = await owner.api.call('updateMicrosoftIntegration', {
        params: { integration: 'teams' },
        body: { enabled: true, botAppId: BOT_APP_ID },
      });
      expect(overview.teams).toMatchObject({
        botAppId: BOT_APP_ID,
        messagingEndpoint: `${API}/api/integrations/teams/messages`,
      });
      const zip = await owner.fetch(`${API}/api/integrations/teams/app.zip`);
      expect(zip.status).toBe(200);
      const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
      expect(Object.keys(files).sort()).toEqual(['color.png', 'manifest.json', 'outline.png']);
      const manifest = JSON.parse(strFromU8(files['manifest.json']!));
      expect(manifest.composeExtensions[0].botId).toBe(BOT_APP_ID);
      expect(manifest.composeExtensions[0].commands.map((c: { id: string }) => c.id)).toEqual([
        'searchCrewhall',
        'saveToCrewhall',
      ]);
      expect(manifest.configurableTabs[0].configurationUrl).toContain(
        `${HUB}/teams/tab/config?client=`,
      );
    });

    it('refuses tokens that are not from the Bot Framework', async () => {
      const res = await app.app.request(`${API}/api/integrations/teams/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('asks to connect, links with the popup code and then searches', async () => {
      await owner.api.call('createPage', {
        params: { spaceId },
        body: { parentId: null, name: 'Pusula yol haritası' } as never,
      });
      const query = (state?: string) =>
        invoke('composeExtension/query', {
          commandId: 'searchCrewhall',
          parameters: [{ name: 'query', value: 'Pusula' }],
          ...(state ? { state } : {}),
        });
      const first = await query();
      expect(first.body.composeExtension.type).toBe('auth');
      expect(first.body.composeExtension.suggestedActions.actions[0]?.value).toBe(
        `${HUB}/teams/link`,
      );

      const { code } = await owner.api.call('createTeamsLinkCode');
      const linked = await query(code);
      expect(linked.body.composeExtension.type).toBe('result');
      const titles = linked.body.composeExtension.attachments.map(
        (a: { content: { title: string } }) => a.content.title,
      );
      expect(titles).toContain('Pusula yol haritası');
      // The code is single-use; the link stays.
      expect((await query(code)).body.composeExtension.type).toBe('result');
      expect((await owner.api.call('getMicrosoftIntegrations')).teams.linkedPeople).toBe(1);
    });

    it('keeps a message for the "Crewhall\'a kaydet" dialog', async () => {
      const res = await invoke('composeExtension/fetchTask', {
        commandId: 'saveToCrewhall',
        commandContext: 'message',
        messagePayload: {
          subject: null,
          body: { contentType: 'html', content: '<p>Sunucu &amp; ağ planı</p><p>Yarın 10:00</p>' },
          from: { user: { displayName: 'Kerem Yılmaz' } },
          createdDateTime: '2026-10-28T08:00:00.000Z',
          linkToMessage: 'https://teams.microsoft.com/l/message/19:abc/123',
        },
      });
      const url = new URL(res.body.task.value.url);
      expect(url.pathname).toBe('/teams/save');
      const draft = await owner.api.call('getTeamsDraft', {
        params: { draftId: url.searchParams.get('draft')! },
      });
      expect(draft).toMatchObject({
        title: 'Sunucu & ağ planı',
        text: 'Sunucu & ağ planı\nYarın 10:00',
        from: 'Kerem Yılmaz',
      });
    });
  });
});
