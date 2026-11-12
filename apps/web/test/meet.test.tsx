import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { api } from '@/lib/api';
import { isMediaPathError, readIce } from '@/components/meet/room/mediaHealth';
import { newId } from '@/lib/ids';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { resetMeetMock } from '@/mocks/meet';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

describe('meetings (design 07)', () => {
  it('lists persistent rooms and today on the meetings home', async () => {
    // The mock schedules the demo 45 minutes from now; late in the evening that is tomorrow and
    // drops out of "today". Only Date is pinned (to midday), timers stay real for the rendering.
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    vi.useFakeTimers({ toFake: ['Date'], now: noon });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    resetMeetMock();
    signedInAs(USER.bugra);
    renderApp('/meetings');
    expect(
      await screen.findByRole('heading', { name: 'Toplantılar', level: 1 }),
    ).toBeInTheDocument();
    expect((await screen.findAllByText('Milvasoft Daily')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Opsiyon · ürün demosu').length).toBeGreaterThan(0);
    expect(screen.getByText('Misafirli')).toBeInTheDocument();
  });

  it('schedules a meeting with a member and a guest', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    renderApp('/meetings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Planla' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni toplantı' });
    await user.type(within(dialog).getByLabelText('Başlık'), 'Portal geçiş planı');
    const people = within(dialog).getByPlaceholderText('Kişi ya da e-posta…');
    await user.type(people, 'misafir@ornek.com{enter}');
    expect(within(dialog).getByText('misafir@ornek.com')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Planla ve davet et' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const { items } = await api.call('listMeetings', { query: { view: 'upcoming', limit: 50 } });
    const created = items.find((m) => m.title === 'Portal geçiş planı')!;
    expect(created.settings.guestsAllowed).toBe(true);
    expect(created.invitees).toEqual([
      expect.objectContaining({ email: 'misafir@ornek.com', guest: true }),
    ]);
  });

  it('picks the date and time with the kit pickers (no native date input)', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    renderApp('/meetings');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Planla' }));
    const dialog = await screen.findByRole('dialog', { name: 'Yeni toplantı' });
    expect(dialog.querySelector('input[type="date"], input[type="time"]')).toBeNull();
    await user.type(within(dialog).getByLabelText('Başlık'), 'Takvim denemesi');
    await user.click(within(dialog).getByLabelText('Tarih'));
    await user.click(screen.getByRole('button', { name: 'Sonraki ay' }));
    await user.click(screen.getByRole('button', { name: /^15 / }));
    await user.click(within(dialog).getByLabelText('Saat'));
    await user.click(screen.getByRole('option', { name: '16' }));
    await user.click(screen.getByRole('option', { name: '30' }));
    // The picker opens on the default start (the next half hour), which late on a month's last
    // day is already in the next month.
    const next = new Date(Date.now() + 30 * 60_000);
    next.setMinutes(next.getMinutes() < 30 ? 30 : 60, 0, 0);
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(within(dialog).getByLabelText('Tarih')).toHaveTextContent(
      `15.${pad(next.getMonth() + 1)}.${next.getFullYear()}`,
    );
    expect(within(dialog).getByLabelText('Saat')).toHaveTextContent('16:30');
    await user.click(within(dialog).getByRole('button', { name: 'Planla ve davet et' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const { items } = await api.call('listMeetings', { query: { view: 'upcoming', limit: 50 } });
    const created = items.find((m) => m.title === 'Takvim denemesi')!;
    expect(created.startsAt).toBe(
      new Date(next.getFullYear(), next.getMonth(), 15, 16, 30).toISOString(),
    );
  });

  it('joins a room with a LiveKit token for the right room and identity', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const m = await api.call('createMeeting', { body: { mode: 'instant', title: 'Hızlı' } });
    const joined = await api.call('joinMeeting', { params: { meetingId: m.id }, body: {} });
    if (joined.status !== 'joined') throw new Error('should join');
    const [, payload] = joined.connection.token.split('.');
    const claims = JSON.parse(atob(payload!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub: string;
      video: { room: string; roomJoin: boolean };
    };
    expect(claims.sub).toBe(`u:${USER.bugra}`);
    expect(claims.video).toMatchObject({ room: `m-${m.id}`, roomJoin: true });
    expect(joined.connection.role).toBe('moderator');
  });

  it('shows the guest page with the org brand and asks for a name', async () => {
    resetMeetMock();
    renderApp('/m/opsiyon-demo-7k2xq');
    expect(
      await screen.findByRole('heading', { name: 'Opsiyon · ürün demosu' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Toplantıya davet edildin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Katılma isteği gönder' })).toBeDisabled();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Adın'), 'Deniz Kaya');
    expect(screen.getByRole('button', { name: 'Katılma isteği gönder' })).toBeEnabled();
  });
});

describe('meetings from chat (design 13.12)', () => {
  it('starts a meeting from the chat header and hides it while meetings are off', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const { router, unmount } = renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Toplantı başlat' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/room\//));
    unmount();

    const s = db();
    s.org!.settings = { ...s.org!.settings, modules: { ...s.org!.settings.modules, meet: false } };
    renderApp(`/chat/c/${CONV.milvaion}`);
    expect(await screen.findByRole('textbox', { name: /sohbetine mesaj yaz/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Toplantı başlat' })).toBeNull();
  });
});

describe('meetings over plain http on the LAN', () => {
  // No secure context: no crypto.randomUUID and no navigator.mediaDevices (jsdom has none either).
  const uuid = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  beforeEach(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
  });
  afterEach(() => {
    if (uuid) Object.defineProperty(crypto, 'randomUUID', uuid);
  });

  it('makes v4 ids without crypto.randomUUID', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('starts the meeting and explains that camera and microphone need https', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const { router } = renderApp(`/chat/c/${CONV.milvaion}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Toplantı başlat' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/room\//));
    expect(
      await screen.findByText('Kamera ve mikrofon için güvenli bağlantı gerekiyor'),
    ).toBeInTheDocument();
    // Listening still works: no mic or camera toggles, the join button is on.
    expect(screen.queryByRole('button', { name: /Mikrofonu (aç|kapat)/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Katıl' })).toBeEnabled();
  });
});

describe('media path errors (H9)', () => {
  it('tells a blocked media path from device and permission problems', () => {
    const err = (name: string, message: string) => Object.assign(new Error(message), { name });
    expect(isMediaPathError(err('NegotiationError', 'negotiation timed out'))).toBe(true);
    expect(isMediaPathError(err('Error', 'publishing rejected as engine not connected'))).toBe(
      true,
    );
    expect(isMediaPathError(err('Error', 'could not establish pc connection'))).toBe(true);
    expect(isMediaPathError(err('NotAllowedError', 'Permission denied'))).toBe(false);
    expect(isMediaPathError(err('NotFoundError', 'Requested device not found'))).toBe(false);
    expect(isMediaPathError(err('Error', 'device in use by another app'))).toBe(false);
    expect(isMediaPathError('timeout')).toBe(false);
  });

  it('reads the receive path from the one peer connection when there is no subscriber', () => {
    const pc = (state: RTCIceConnectionState) => ({ getICEConnectionState: () => state });
    // livekit-client's default single peer connection: publisher carries both directions.
    expect(readIce({ publisher: pc('connected') })).toEqual({
      publisher: 'connected',
      subscriber: 'connected',
    });
    expect(readIce({ publisher: pc('connected'), subscriber: pc('checking') })).toEqual({
      publisher: 'connected',
      subscriber: 'checking',
    });
    expect(readIce(undefined)).toEqual({ publisher: 'none', subscriber: 'none' });
  });
});

describe('calls from chat (H7)', () => {
  it('calls from a direct chat header (voice or video)', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const { router } = renderApp(`/chat/c/${CONV.elif}`);
    const user = userEvent.setup();
    // Direct and group chats call; "Toplantı başlat" stays for space chats.
    expect(screen.queryByRole('button', { name: 'Toplantı başlat' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Görüntülü ara' }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/room\//));
    const callId = (router.state.location.search as { call?: string }).call!;
    const call = await api.call('getCall', { params: { callId } });
    expect(call).toMatchObject({ status: 'ringing', video: true, conversationId: CONV.elif });
    expect(call.members.map((m) => m.user.id)).toEqual([USER.elif]);
  });

  it('has separate voice and video buttons; the voice one starts a voice call at once', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const { router } = renderApp(`/chat/c/${CONV.elif}`);
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: 'Görüntülü ara' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Sesli ara' }));
    // No menu in between: straight into the room, ringing.
    expect(screen.queryByRole('menu')).toBeNull();
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/meetings\/room\//));
    const callId = (router.state.location.search as { call?: string }).call!;
    expect(await api.call('getCall', { params: { callId } })).toMatchObject({
      status: 'ringing',
      video: false,
    });
  });

  it('shows "Sürüyor · Katıl" instead of the buttons while a call goes on', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const call = await api.call('startCall', { body: { conversationId: CONV.elif, video: true } });
    await api.call('answerCall', { params: { callId: call.id } });
    const { router } = renderApp(`/chat/c/${CONV.elif}`);
    const user = userEvent.setup();
    expect(await screen.findByText(/^Sürüyor · \d\d:\d\d$/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sesli ara' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Görüntülü ara' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Katıl' }));
    // Joins that call, no new one.
    await waitFor(() =>
      expect((router.state.location.search as { call?: string }).call).toBe(call.id),
    );
  });

  it('rings people into a meeting going on: "seni toplantıya çağırıyor" and Katıl', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const home = await api.call('getMeetHome', { query: {} });
    const room = home.rooms[0]!;
    await api.call('ringToMeeting', {
      params: { meetingId: room.id },
      body: { userIds: [USER.elif] },
    });
    db().sessions.find((x) => x.id === 'test-session')!.userId = USER.elif;
    renderApp('/');
    const ring = await screen.findByRole('alertdialog', { name: /seni toplantıya çağırıyor/ });
    expect(within(ring).getByText(new RegExp(room.title))).toBeInTheDocument();
    expect(within(ring).getByRole('button', { name: 'Katıl' })).toBeEnabled();
  });

  it('rings full screen for the person called and declining stops it', async () => {
    resetMeetMock();
    signedInAs(USER.bugra);
    const call = await api.call('startCall', { body: { conversationId: CONV.elif, video: true } });
    // The person called signs in (signedInAs adds a session; switch the existing one).
    db().sessions.find((x) => x.id === 'test-session')!.userId = USER.elif;
    renderApp('/');
    const ring = await screen.findByRole('alertdialog', { name: /görüntülü arıyor/ });
    expect(within(ring).getByRole('button', { name: 'Kabul et' })).toBeEnabled();
    expect(within(ring).getByRole('button', { name: 'Meşgulüm' })).toBeEnabled();
    const user = userEvent.setup();
    await user.click(within(ring).getByRole('button', { name: 'Reddet' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    const after = await api.call('getCall', { params: { callId: call.id } });
    expect(after.status).toBe('declined');
    expect(after.members[0]!.state).toBe('declined');
  });
});
