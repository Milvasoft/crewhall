import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { mcpMockState } from '@/mocks/mcp';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { server } from './support/server';
import { signedInAs } from './support/session';

const mcpState = () => mcpMockState(db());

const consentQuery = new URLSearchParams({
  response_type: 'code',
  client_id: 'mcp_c_claudecode',
  redirect_uri: 'http://localhost:53682/callback',
  code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  code_challenge_method: 'S256',
  scope: 'hub:read quick:write',
  state: 'abc',
});

describe('MCP and API (design 18)', () => {
  it('lists connected clients and tokens, and shows a new token value once', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/mcp');
    const user = userEvent.setup();
    expect(await screen.findByText('Claude Code · Dizüstü')).toBeInTheDocument();
    expect(screen.getByText('CI · sürüm notları')).toBeInTheDocument();
    expect(
      screen.getAllByText('claude mcp add --transport http crewhall http://localhost:4301/mcp')
        .length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: /Token oluştur/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Ad'), 'Dokploy deploy notu');
    await user.click(within(dialog).getByRole('button', { name: 'Oluştur' }));
    expect(await within(dialog).findByText(/Token yalnız şimdi gösteriliyor/)).toBeInTheDocument();
    expect(within(dialog).getAllByText(/^mhp_[A-Za-z0-9]{40}$/)).toHaveLength(1);
    expect(mcpState().tokens.some((t) => t.name === 'Dokploy deploy notu')).toBe(true);
  });

  it('REST API screen links the generated OpenAPI document and frames the reference', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/mcp/api');
    expect(await screen.findByRole('heading', { name: 'REST API' })).toBeInTheDocument();
    const download = screen.getByRole('link', { name: /OpenAPI \(JSON\)/ });
    expect(download.getAttribute('href')).toMatch(/\/api\/openapi\.json\?lang=tr$/);
    expect(screen.getByText(/api\.call\('listSpaces'\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/Authorization: Bearer \$CREWHALL_TOKEN/).length).toBeGreaterThan(0);
    const frame = screen.getByTitle('API başvurusu');
    expect(frame.getAttribute('src')).toMatch(/^\/rest-api\.html\?theme=(light|dark)&lang=tr$/);
    expect(screen.getByRole('link', { name: 'REST API' })).toHaveAttribute(
      'href',
      '/account/mcp/api',
    );
  });

  it('disconnects a client from the list', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/mcp');
    const user = userEvent.setup();
    await screen.findByText('Claude Code · Dizüstü');
    await user.click(screen.getAllByRole('button', { name: 'Bağlantıyı kes' })[0]!);
    const confirm = await screen.findByRole('dialog');
    await user.click(within(confirm).getByRole('button', { name: 'Bağlantıyı kes' }));
    await waitFor(() => expect(mcpState().grants.filter((g) => g.revokedAt).length).toBe(1));
  });

  it('consent asks for a passkey or password, then hands the code to the client', async () => {
    let callback: string | null = null;
    server.use(
      http.get('http://localhost:53682/callback', ({ request }) => {
        callback = request.url;
        return HttpResponse.text('ok');
      }),
    );
    signedInAs(USER.bugra);
    const before = mcpState().grants.length;
    renderApp(`/oauth/consent?${consentQuery}`);
    const user = userEvent.setup();
    expect(
      await screen.findByText('Claude Code, Crewhall hesabına erişmek istiyor'),
    ).toBeInTheDocument();
    expect(screen.getByText('http://localhost:53682/callback')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Okuma ve arama' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Hızlı erişim yaz' })).toBeChecked();
    expect(screen.getByText(/Kasa bu bağlantıya kapalıdır/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'İzin ver' }));
    const reauth = await screen.findByRole('dialog', { name: 'Kimliğini doğrula' });
    // The owner has a passkey, so it comes first; the password is the fallback.
    await user.click(within(reauth).getByRole('button', { name: 'Şifreyle doğrula' }));
    await user.type(within(reauth).getByLabelText('Şifre'), 'crewhall-demo-2026');
    await user.click(within(reauth).getByRole('button', { name: 'Şifreyle doğrula' }));
    expect(
      await screen.findByText(/Bağlandı\. Claude Code uygulamasına dönebilirsin/),
    ).toBeInTheDocument();
    expect(mcpState().grants.length).toBe(before + 1);
    expect(new URL(callback!).searchParams.get('state')).toBe('abc');
    expect(new URL(callback!).searchParams.get('code')).toMatch(/^mhc_/);
  });

  it('shows an invalid request instead of a consent form', async () => {
    signedInAs(USER.bugra);
    renderApp('/oauth/consent?client_id=x');
    expect(await screen.findByText('Bağlantı isteği geçersiz')).toBeInTheDocument();
  });

  it('approves a queued request after re-verification', async () => {
    signedInAs(USER.bugra);
    const id = mcpState().approvals[0]!.id;
    renderApp(`/account/approvals/${id}`);
    const user = userEvent.setup();
    expect(
      await screen.findByText(/şu işlemi yapmak istiyor: 3 öğeyi Çöp'e taşı/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Eski toplantı notlarını temizle/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Onayla ve uygula' }));
    const reauth = await screen.findByRole('dialog', { name: 'Kimliğini doğrula' });
    // The owner has a passkey, so it comes first; the password is the fallback.
    await user.click(within(reauth).getByRole('button', { name: 'Şifreyle doğrula' }));
    await user.type(within(reauth).getByLabelText('Şifre'), 'crewhall-demo-2026');
    await user.click(within(reauth).getByRole('button', { name: 'Şifreyle doğrula' }));
    await waitFor(() => expect(mcpState().approvals[0]!.status).toBe('applied'));
  });

  it('activity shows the waiting call with a review link', async () => {
    signedInAs(USER.bugra);
    renderApp('/account/mcp/activity?filter=all');
    expect(await screen.findByText('trash_nodes')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gözden geçir' })).toBeInTheDocument();
    expect(screen.getByText('insufficient_scope')).toBeInTheDocument();
  });

  it('admins turn personal tokens off in the policy', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/mcp', 'en');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('switch', { name: /Personal access tokens/ });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    await waitFor(() => expect(mcpState().policy.patsEnabled).toBe(false));
    expect(screen.getByText('Human approval required')).toBeInTheDocument();
  });
  it('marks chat messages sent through MCP with the client name', async () => {
    signedInAs(USER.bugra);
    const msgs = chatState(db())
      .messages.filter(
        (m) => m.conversationId === CONV.milvaion && m.kind === 'user' && !m.deletedAt,
      )
      .sort((a, b) => b.seq - a.seq);
    msgs[0]!.via = { kind: 'mcp', client: 'Claude Code' };
    renderApp(`/chat/c/${CONV.milvaion}`);
    expect(await screen.findByText('Claude Code ile')).toBeInTheDocument();
  });
});
