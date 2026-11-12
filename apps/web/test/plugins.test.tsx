import { Toaster } from '@crewhall/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { CONV } from '@/mocks/chatSeed';
import { db, newId } from '@/mocks/db';
import { pluginsState } from '@/mocks/plugins';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** Plugins (docs/contracts/eklentiler.md): admin screen, tabs in the rail and chat, commands. */

const install = (pluginId: string) =>
  api.call('installPlugin', {
    body: {
      pluginId,
      version: pluginId.endsWith('hello') ? '1.0.0' : '0.3.0',
      permissions: ['hub:read', 'chat:send'],
    },
  });

describe('Yönetim › Eklentiler', () => {
  it('installs a plugin after the permissions are approved and shows the unofficial risk', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/plugins');
    const user = userEvent.setup();
    expect(await screen.findByText('Henüz kurulu eklenti yok.')).toBeInTheDocument();
    const wa = (await screen.findByText('WhatsApp')).closest('li')!;
    expect(within(wa).getByText('Gayriresmî')).toBeInTheDocument();
    await user.click(within(wa).getByRole('button', { name: 'Kur' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/WhatsApp şartlarına aykırı olabilir/)).toBeInTheDocument();
    expect(within(dialog).getByText(/wa\.example\.com/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'İzinleri onayla ve kur' }));
    await waitFor(() =>
      expect(pluginsState(db()).installations.map((i) => i.pluginId)).toEqual([
        'com.example.whatsapp',
      ]),
    );
    const row = (await screen.findAllByText('WhatsApp'))[0]!.closest('li')!;
    expect(within(row).getByRole('switch')).toBeChecked();

    await user.click(within(row).getByRole('switch'));
    await waitFor(() => expect(pluginsState(db()).installations[0]!.enabled).toBe(false));
    await user.click(within(row).getByRole('button', { name: 'Kaldır' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Kaldır' }),
    );
    await waitFor(() => expect(pluginsState(db()).installations).toEqual([]));
  });

  it('installs with a subset of the permissions and changes the grant later', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/plugins');
    const user = userEvent.setup();
    const hello = (await screen.findByText('Merhaba')).closest('li')!;
    await user.click(within(hello).getByRole('button', { name: 'Kur' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Drive yaz/ }));
    expect(within(dialog).getByText(/İşaretini kaldırdığın izinler verilmez/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Seçili izinlerle kur' }));
    await waitFor(() =>
      expect(pluginsState(db()).installations[0]?.permissions).toEqual(['hub:read', 'chat:send']),
    );
    const row = (await screen.findAllByText('Merhaba'))[0]!.closest('li')!;
    expect(await within(row).findByTitle('İstendi, verilmedi')).toHaveTextContent('Drive yaz');

    await user.click(within(row).getByRole('button', { name: 'İzinler' }));
    const edit = await screen.findByRole('dialog');
    expect(within(edit).getByRole('checkbox', { name: /Drive yaz/ })).not.toBeChecked();
    await user.click(within(edit).getByRole('checkbox', { name: /Chat mesaj gönder/ }));
    await user.click(within(edit).getByRole('checkbox', { name: /Drive yaz/ }));
    await user.click(within(edit).getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(pluginsState(db()).installations[0]?.permissions).toEqual(['hub:read', 'drive:write']),
    );
  });

  it('asks again for the permissions an update adds, and grants only the ticked ones', async () => {
    signedInAs(USER.bugra);
    pluginsState(db()).installations.push({
      id: newId(),
      pluginId: 'com.example.hello',
      version: '0.9.0',
      requested: ['hub:read', 'chat:send'],
      permissions: ['hub:read'],
      enabled: true,
      installedBy: USER.bugra,
      installedAt: '2026-10-01T10:00:00.000Z',
      selfOrigin: null,
    });
    renderApp('/admin/plugins');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '1.0.0 sürümüne güncelle' }));
    const dialog = await screen.findByRole('dialog');
    // Only the new permission is asked; chat:send stays as the admin left it (not granted).
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(1);
    await user.click(within(dialog).getByRole('checkbox', { name: /Drive yaz/ }));
    await user.click(within(dialog).getByRole('button', { name: 'İzinleri onayla ve güncelle' }));
    await waitFor(() =>
      expect(pluginsState(db()).installations[0]).toMatchObject({
        version: '1.0.0',
        permissions: ['hub:read'],
        requested: ['hub:read', 'chat:send', 'drive:write'],
      }),
    );
  });
});

describe('Yönetim › Eklentiler · ID, bağlantı ve kendi sunucusu', () => {
  it('finds an unlisted self-hosted plugin by its link and installs it on the org server', async () => {
    signedInAs(USER.bugra);
    renderApp('/admin/plugins');
    const user = userEvent.setup();
    expect(await screen.findByText('Merhaba')).toBeInTheDocument();
    // Unlisted: not in the catalog.
    expect(screen.queryByText('WhatsApp köprüsü')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'ID ya da bağlantıyla kur' }));
    const find = await screen.findByRole('dialog');
    // Pasted, as an admin would.
    await user.click(within(find).getByLabelText('Eklenti kimliği ya da bağlantısı'));
    await user.paste('https://market.crewhall.dev/p/com.example.wabridge');
    await user.click(within(find).getByRole('button', { name: 'Bul' }));

    const dialog = await screen.findByRole('dialog', { name: /WhatsApp köprüsü kurulsun mu/ });
    expect(within(dialog).getByText(/kurumun kendi sunucusunda çalışır/)).toBeInTheDocument();
    const approve = within(dialog).getByRole('button', { name: 'İzinleri onayla ve kur' });
    expect(approve).toBeDisabled();
    // It asks for the microphone and the location; the admin grants only the microphone.
    await user.click(within(dialog).getByRole('checkbox', { name: /Konum/ }));
    await user.click(within(dialog).getByLabelText('Kurumun sunucu adresi'));
    await user.paste('https://wa.kurum.com');
    await user.click(approve);
    await waitFor(() =>
      expect(pluginsState(db()).installations).toEqual([
        expect.objectContaining({
          pluginId: 'com.example.wabridge',
          selfOrigin: 'https://wa.kurum.com',
          browser: ['microphone'],
        }),
      ]),
    );
    expect(await screen.findByText('Sunucu: https://wa.kurum.com')).toBeInTheDocument();
    expect(screen.getAllByText('Kendi sunucunda').length).toBeGreaterThan(0);
  });

  it('says so when the id or link is not one', async () => {
    signedInAs(USER.bugra);
    render(<Toaster />);
    renderApp('/admin/plugins');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'ID ya da bağlantıyla kur' }));
    const find = await screen.findByRole('dialog');
    await user.click(within(find).getByLabelText('Eklenti kimliği ya da bağlantısı'));
    await user.paste('https://evil.example/p/x');
    await user.click(within(find).getByRole('button', { name: 'Bul' }));
    expect(
      await screen.findByText(
        /Bu bir eklenti kimliği ya da bu pazar yerinin kurulum bağlantısı değil/,
      ),
    ).toBeInTheDocument();
  });
});

describe('plugin surfaces', () => {
  it('puts a rail tab in a sandboxed frame on the plugin origin', async () => {
    signedInAs(USER.bugra);
    const inst = await install('com.example.hello');
    renderApp('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'Merhaba' }));
    const frame = await screen.findByTitle('Merhaba eklentisi');
    expect(frame.getAttribute('src')).toBe('https://hello.example.com/tab');
    expect(frame.getAttribute('sandbox')).toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-top-navigation');
    // Links it opens are ordinary tabs; no browser feature it was not granted.
    expect(frame.getAttribute('sandbox')).toContain('allow-popups-to-escape-sandbox');
    expect(frame.getAttribute('allow')).toBe('');
    expect(inst.status).toBe('active');
  });

  it("shows the plugin's own picture in the rail, and the line icon if it does not load", async () => {
    signedInAs(USER.bugra);
    await install('com.example.hello');
    renderApp('/');
    const link = await screen.findByRole('link', { name: 'Merhaba' });
    const picture = link.querySelector('img');
    expect(picture?.getAttribute('src')).toMatch(/^data:image\/svg/);
    fireEvent.error(picture!);
    expect(link.querySelector('img')).toBeNull();
    expect(link.querySelector('svg')).not.toBeNull();
  });

  it('lists chat tabs in the chat sidebar and runs a /command', async () => {
    signedInAs(USER.bugra);
    await install('com.example.whatsapp');
    await install('com.example.hello');
    renderApp(`/chat/c/${CONV.selinCan}`);
    const user = userEvent.setup();
    const group = await screen.findByRole('group', { name: 'Eklentiler' });
    expect(within(group).getByRole('link', { name: 'WhatsApp', hidden: true })).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/chat\/plugins\/.+\/chats$/),
    );
    const box = await screen.findByRole('textbox', { name: /sohbetine mesaj yaz/ });
    await user.type(box, '/hello dünya{Enter}');
    await waitFor(() =>
      expect(pluginsState(db()).commands).toEqual([
        expect.objectContaining({ command: 'hello', args: 'dünya', conversationId: CONV.selinCan }),
      ]),
    );
    // The command does not go out as a message: the draft is cleared, nothing is queued.
    await waitFor(() => expect(box.textContent ?? (box as HTMLTextAreaElement).value).toBe(''));
  });
});

describe('plugin notifications', () => {
  const linkWaBridge = () => {
    const state = pluginsState(db());
    const id = newId();
    state.installations.push({
      id,
      pluginId: 'com.example.wabridge',
      version: '1.0.0',
      requested: ['hub:read', 'chat:send', 'notifications:write'],
      permissions: ['hub:read', 'chat:send', 'notifications:write'],
      enabled: true,
      installedBy: USER.bugra,
      installedAt: '2026-10-30T10:00:00.000Z',
      selfOrigin: 'https://wa.kurum.com',
    });
    state.linked.push(`${id}:${USER.bugra}`);
    return id;
  };

  it('sets each channel and "show on mobile" per plugin in the notification settings', async () => {
    signedInAs(USER.bugra);
    const id = linkWaBridge();
    renderApp('/notifications');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Bildirim ayarları' }));
    const section = await screen.findByRole('region', { name: 'Eklentiler' });
    const channels = within(section).getByRole('group', {
      name: 'WhatsApp köprüsü bildirim kanalları',
    });
    // WhatsApp on the desktop only: never a phone push.
    await user.click(within(channels).getByRole('checkbox', { name: 'Telefon' }));
    await waitFor(() =>
      expect(pluginsState(db()).prefs[`${id}:${USER.bugra}`]?.channels).toEqual({
        bell: true,
        desktop: true,
        push: false,
      }),
    );
    await user.click(
      within(section).getByRole('switch', { name: 'WhatsApp köprüsü mobilde görünsün' }),
    );
    await waitFor(() =>
      expect(pluginsState(db()).prefs[`${id}:${USER.bugra}`]?.showOnMobile).toBe(false),
    );
    // Without the bell there is no desktop toast either.
    await user.click(within(channels).getByRole('checkbox', { name: 'Bildirim merkezi' }));
    await waitFor(() =>
      expect(within(channels).getByRole('checkbox', { name: 'Masaüstü' })).toBeDisabled(),
    );
  });

  it('pins a chat tab to the left rail from the plugin settings', async () => {
    signedInAs(USER.bugra);
    const id = linkWaBridge();
    renderApp('/chat');
    const user = userEvent.setup();
    const group = await screen.findByRole('group', { name: 'Eklentiler' });
    // Off by default: only in the chat sidebar.
    expect(document.querySelector(`[data-rail-item][href="/plugins/${id}/chats"]`)).toBeNull();
    await user.click(within(group).getByRole('button', { name: 'Bu eklentinin ayarları' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bu eklentinin ayarları' });
    await user.click(within(dialog).getByRole('switch', { name: 'Sol menüye ekle: WhatsApp' }));
    await waitFor(() =>
      expect(pluginsState(db()).prefs[`${id}:${USER.bugra}`]?.pinnedTabs).toEqual(['chats']),
    );
    await waitFor(() =>
      expect(
        document.querySelector(`[data-rail-item][href="/plugins/${id}/chats"]`),
      ).not.toBeNull(),
    );
    // Still in the chat sidebar too.
    expect(within(group).getByRole('link', { name: 'WhatsApp', hidden: true })).toHaveAttribute(
      'href',
      `/chat/plugins/${id}/chats`,
    );
  });

  it('opens the same settings from the plugin tab', async () => {
    signedInAs(USER.bugra);
    linkWaBridge();
    renderApp('/chat');
    const user = userEvent.setup();
    const group = await screen.findByRole('group', { name: 'Eklentiler' });
    await user.click(within(group).getByRole('button', { name: 'Bu eklentinin ayarları' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bu eklentinin ayarları' });
    expect(
      within(dialog).getByRole('switch', { name: 'WhatsApp köprüsü mobilde görünsün' }),
    ).toBeChecked();
  });

  it("opens a notification's deep link inside the plugin tab", async () => {
    signedInAs(USER.bugra);
    const id = linkWaBridge();
    pluginsState(db()).installations.find((i) => i.id === id)!.browser = [
      'microphone',
      'geolocation',
    ];
    renderApp(`/chat/plugins/${id}/chats?chat=42#m7`);
    const frame = await screen.findByTitle('WhatsApp köprüsü eklentisi');
    expect(frame.getAttribute('src')).toBe('https://wa.kurum.com/?chat=42#m7');
    // Granted features only, each for the installation's own origin.
    expect(frame.getAttribute('allow')).toBe(
      'microphone https://wa.kurum.com; geolocation https://wa.kurum.com',
    );
  });
});
