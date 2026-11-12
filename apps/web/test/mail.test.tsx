import { type MailMessage } from '@crewhall/shared';
import { toast, Toaster } from '@crewhall/ui';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { groupConversations } from '@/components/mail/MessageList';
import { bodyDocument, draftFor, parseRecipient, prefixed } from '@/lib/mail/compose';
import { db } from '@/mocks/db';
import { mailMockState, MOCK_MAIL_PASSWORD } from '@/mocks/mail';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

const ME = 'bugra@milvasoft.com';

function msg(over: Partial<MailMessage>): MailMessage {
  return {
    folder: 'INBOX',
    uid: 1,
    messageId: '<a@x>',
    threadId: '<a@x>',
    subject: 'Konu',
    from: { name: 'Ayşe', address: 'ayse@x.com' },
    to: [{ name: null, address: ME }],
    date: null,
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    size: 1,
    cc: [],
    bcc: [],
    replyTo: [],
    inReplyTo: null,
    references: [],
    html: null,
    text: 'metin',
    attachments: [],
    blockedImages: 0,
    ...over,
  };
}

describe('mail helpers', () => {
  it('builds reply, reply-all and forward drafts', () => {
    const m = msg({
      subject: 'Re: RE: Teklif',
      cc: [
        { name: 'Can', address: 'can@x.com' },
        { name: null, address: ME },
      ],
    });
    const prefixes = { reply: 'Re:', forward: 'Fwd:' };
    expect(draftFor('reply', m, ME, prefixes)).toEqual({
      to: [{ name: 'Ayşe', address: 'ayse@x.com' }],
      cc: [],
      subject: 'Re: Teklif',
    });
    expect(draftFor('replyAll', m, ME, prefixes).cc).toEqual([
      { name: 'Can', address: 'can@x.com' },
    ]);
    expect(draftFor('forward', m, ME, prefixes)).toEqual({
      to: [],
      cc: [],
      subject: 'Fwd: Teklif',
    });
    // A reply to one's own sent message goes to its recipients.
    const mine = msg({
      from: { name: null, address: ME },
      to: [{ name: 'Deniz', address: 'deniz@x.com' }],
    });
    expect(draftFor('reply', mine, ME, prefixes).to).toEqual([
      { name: 'Deniz', address: 'deniz@x.com' },
    ]);
    expect(prefixed('YNT: İLT: Bütçe', 'Re:')).toBe('Re: Bütçe');
  });

  it('parses recipients', () => {
    expect(parseRecipient('Ada Yılmaz <ada@x.com>')).toEqual({
      name: 'Ada Yılmaz',
      address: 'ada@x.com',
    });
    expect(parseRecipient('ada@x.com,')).toEqual({ name: null, address: 'ada@x.com' });
    expect(parseRecipient('ada')).toBeNull();
    expect(parseRecipient('<javascript:alert(1)>')).toBeNull();
  });

  it('locks the message document down with a CSP and escapes plain text', () => {
    const doc = bodyDocument(
      { html: null, text: '<b>x</b> https://a.example/p' },
      { remoteImages: false, dark: false },
    );
    expect(doc).toContain("default-src 'none'; img-src data:;");
    expect(doc).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(doc).toContain('<a href="https://a.example/p">');
    expect(
      bodyDocument({ html: '<p>x</p>', text: null }, { remoteImages: true, dark: false }),
    ).toContain('img-src data: https: http:');
  });

  it('groups a page of messages into conversations', () => {
    const rows = groupConversations([
      msg({ uid: 3, threadId: '<t>', seen: false }),
      msg({ uid: 2, threadId: '<u>' }),
      msg({ uid: 1, threadId: '<t>', flagged: true }),
    ]);
    expect(rows.map((r) => [r.latest.uid, r.count, r.unread, r.flagged])).toEqual([
      [3, 2, true, true],
      [2, 1, false, false],
    ]);
  });
});

describe('mail screens', () => {
  // Sonner keeps toasts in a module store; a toast of the previous test must not count.
  afterEach(() => toast.dismiss());

  it('lists the inbox, opens a conversation in a sandboxed frame and marks it read', async () => {
    signedInAs(USER.bugra);
    renderApp('/mail');
    const user = userEvent.setup();
    const list = await screen.findByRole('region', { name: 'İletiler' });
    expect(await within(list).findByText('Teklif ve sözleşme taslağı')).toBeInTheDocument();
    const folders = screen.getByRole('navigation', { name: 'Klasörler' });
    expect(within(folders).getByRole('link', { name: /Gelen kutusu/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(within(list).getByText('Teklif ve sözleşme taslağı'));
    const frame = await screen.findByTitle('Teklif ve sözleşme taslağı iletisinin içeriği');
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    );
    expect(frame.getAttribute('srcdoc')).toContain('img-src data:;');
    expect(
      screen.getByText('Gizliliğin için bu iletideki 1 uzak resim gösterilmiyor.'),
    ).toBeInTheDocument();
    expect(screen.getByText('teklif.pdf')).toBeInTheDocument();
    const download = screen.getByRole('link', { name: 'teklif.pdf dosyasını indir' });
    expect(download.getAttribute('href')).toContain(
      '/api/mail/attachment?folder=INBOX&uid=2&part=2',
    );
    await waitFor(() =>
      expect(
        mailMockState(db()).folders[USER.bugra]![0]!.messages.find((m) => m.uid === 2)?.seen,
      ).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: 'Resimleri göster' }));
    await waitFor(() => expect(screen.queryByText(/uzak resim gösterilmiyor/)).toBeNull());
  });

  it('writes a new message with a suggested recipient and keeps a Sent copy', async () => {
    render(<Toaster />);
    signedInAs(USER.bugra);
    renderApp('/mail');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Yeni ileti' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni ileti' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Kime' }), 'elif');
    await user.click(await within(dialog).findByRole('option', { name: /elif@milvasoft.com/ }));
    expect(within(dialog).getByText('Elif Yıldız')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Konu'), 'Sprint planı');
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));
    expect(await screen.findByText('İleti gönderildi.')).toBeInTheDocument();
    const sent = mailMockState(db()).folders[USER.bugra]!.find((f) => f.specialUse === 'sent')!;
    expect(sent.messages.at(-1)).toMatchObject({
      subject: 'Sprint planı',
      to: [{ address: 'elif@milvasoft.com', name: 'Elif Yıldız' }],
    });
  });

  it('refuses an invalid address and a message without recipients', async () => {
    render(<Toaster />);
    signedInAs(USER.bugra);
    renderApp('/mail?new=1');
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Yeni ileti' });
    await user.type(within(dialog).getByRole('combobox', { name: 'Kime' }), 'yanlis-adres{Enter}');
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'yanlis-adres geçerli bir e-posta adresi değil.',
    );
    await user.clear(within(dialog).getByRole('combobox', { name: 'Kime' }));
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));
    expect(await screen.findByText('En az bir alıcı ekle.')).toBeInTheDocument();
  });

  it('replies from the conversation and flags the original as answered', async () => {
    render(<Toaster />);
    signedInAs(USER.bugra);
    renderApp('/mail?folder=INBOX&uid=2');
    const user = userEvent.setup();
    await screen.findByTitle('Teklif ve sözleşme taslağı iletisinin içeriği');
    const replies = screen.getAllByRole('button', { name: 'Yanıtla' });
    await user.click(replies.at(-1)!);
    const dialog = await screen.findByRole('dialog', { name: 'Yanıtla' });
    expect(within(dialog).getByText('Ayşe Demir')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Konu')).toHaveValue('YNT: Teklif ve sözleşme taslağı');
    await user.click(within(dialog).getByRole('button', { name: 'Gönder' }));
    expect(await screen.findByText('İleti gönderildi.')).toBeInTheDocument();
    const inbox = mailMockState(db()).folders[USER.bugra]![0]!;
    expect(inbox.messages.find((m) => m.uid === 2)?.answered).toBe(true);
  });

  it('connects a mailbox with an app password', async () => {
    signedInAs(USER.elif);
    renderApp('/mail');
    const user = userEvent.setup();
    expect(
      await screen.findByRole('heading', { name: 'E-posta hesabını bağla' }),
    ).toBeInTheDocument();
    await user.type(screen.getByLabelText('E-posta adresi'), 'elif@milvasoft.com');
    await user.type(screen.getByLabelText('Uygulama şifresi'), 'yanlis');
    await user.click(screen.getByRole('button', { name: 'Bağlan' }));
    expect(
      await screen.findByText('Posta sunucusu giriş bilgilerini kabul etmedi.'),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Uygulama şifresi'));
    await user.type(screen.getByLabelText('Uygulama şifresi'), MOCK_MAIL_PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Bağlan' }));
    const list = await screen.findByRole('region', { name: 'İletiler' });
    expect(await within(list).findByText('Haftalık sunucu raporu')).toBeInTheDocument();
  });

  it('shows the setup notice until the admin configures the server', async () => {
    mailMockState(db()).settings.configured = false;
    signedInAs(USER.bugra);
    renderApp('/mail');
    expect(await screen.findByText('Posta henüz ayarlanmadı')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Posta sunucusunu ayarla' })).toHaveAttribute(
      'href',
      '/admin/mail',
    );
  });

  it('lets the admin set the server up and test it', async () => {
    render(<Toaster />);
    signedInAs(USER.bugra);
    renderApp('/admin/mail');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Posta sunucusu' })).toBeInTheDocument();
    const admin = screen.getByRole('complementary', { name: 'Yönetim' });
    expect(within(admin).getByRole('link', { name: 'Posta sunucusu' })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Microsoft 365' }));
    expect(screen.getAllByLabelText('Sunucu adresi')[0]).toHaveValue('outlook.office365.com');
    expect(screen.getByText('OAuth2 için istemci kimliği ve sırrı gerekli.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kaydet' })).toBeDisabled();
    await user.type(screen.getByLabelText('İstemci kimliği (client ID)'), 'app-123');
    await user.type(screen.getByLabelText('İstemci sırrı (client secret)'), 'sir');
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    expect(await screen.findByText('Posta sunucusu ayarları kaydedildi.')).toBeInTheDocument();
    const saved = mailMockState(db()).settings;
    expect(saved).toMatchObject({
      authMode: 'oauth_microsoft',
      oauthClientId: 'app-123',
      smtpPort: 587,
    });

    await user.click(screen.getByRole('button', { name: 'Dene' }));
    expect(await screen.findByText(/IMAP · Başarılı/)).toBeInTheDocument();
  });

  it('hides the module from the rail when it is turned off', async () => {
    db().org!.settings.modules = { mail: false };
    signedInAs(USER.bugra);
    renderApp('/mail');
    expect(await screen.findByText('Bu modül kurumunda kapalı')).toBeInTheDocument();
    const rail = screen.getByRole('navigation', { name: 'Modüller' });
    expect(within(rail).queryByRole('link', { name: 'Posta' })).toBeNull();
  });
});
