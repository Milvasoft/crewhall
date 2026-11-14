import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchConversation } from '@/lib/chat/cache';
import { chatKeys, conversationsQuery, messagesQuery } from '@/lib/chat/queries';
import { bindRuntimeForTests, handleEvent } from '@/lib/chat/runtime';
import {
  armMessageSound,
  armNotificationSound,
  inQuietHours,
  playTone,
  setAudioFactoryForTests,
  setMessageSoundOn,
  soundForNotification,
  toneFor,
} from '@/lib/chat/sound';
import { type Conversation } from '@/lib/chat/types';
import {
  LOOK_GRACE_MS,
  noteLookedAway,
  setPresence,
  setVisibleConversation,
} from '@/lib/chat/stores';
import { type Message } from '@/lib/chat/types';
import { createQueryClient } from '@/lib/queryClient';
import { CONV } from '@/mocks/chatSeed';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

interface FakeBuffer {
  length: number;
  channels: Float32Array[];
}

/** Just enough of Web Audio to see which rendered sounds were played. */
class FakeAudio {
  static made = 0;
  state: AudioContextState = 'suspended';
  sampleRate = 8000;
  destination = {};
  /** The buffers that started playing, in order. */
  played: FakeBuffer[] = [];
  constructor() {
    FakeAudio.made++;
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  createBuffer(channels: number, length: number): FakeBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, channels: data, getChannelData: (i: number) => data[i]! } as FakeBuffer;
  }
  createBufferSource() {
    const source = {
      buffer: null as FakeBuffer | null,
      onended: null as (() => void) | null,
      connect: (n: unknown) => n,
      disconnect: () => undefined,
      start: () => this.played.push(source.buffer!),
    };
    return source;
  }
}

/** A real sound: stereo, not silent. */
function audible(b: FakeBuffer | undefined): boolean {
  return !!b && b.channels.length === 2 && b.channels[0]!.some((v) => Math.abs(v) > 0.01);
}

let audio: FakeAudio | null = null;
let disarm: () => void = () => undefined;

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
}

/** Another window in front (false) or this one (true). */
function setFocus(on: boolean) {
  Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => on });
}

/** The desktop app's preload bridge. */
function setDesktop(on: boolean) {
  if (on) Object.assign(window, { crewhallDesktop: { isDesktop: true } });
  else delete (window as { crewhallDesktop?: unknown }).crewhallDesktop;
}

async function setup() {
  signedInAs(USER.bugra);
  const qc = createQueryClient();
  await qc.fetchQuery(conversationsQuery);
  const w = await qc.fetchQuery(messagesQuery(CONV.milvaion));
  const other = w.items.find((m) => m.author && m.author.id !== USER.bugra && m.kind === 'user')!;
  bindRuntimeForTests(qc, USER.bugra);
  patchConversation(qc, CONV.milvaion, (c) => ({
    ...c,
    my: { ...c.my, notify: 'all', mutedUntil: null },
  }));
  const msg = (patch: Partial<Message> = {}): Message => ({
    ...other,
    id: `${other.id.slice(0, -4)}${Math.floor(Math.random() * 9000 + 1000)}`,
    seq: other.seq + 1000,
    mentions: [],
    deletedAt: null,
    createdAt: new Date().toISOString(),
    ...patch,
  });
  return { qc, msg };
}

/** First interaction unlocks audio, as in a real browser. */
function interact() {
  window.dispatchEvent(new Event('pointerdown'));
}

beforeEach(() => {
  FakeAudio.made = 0;
  setAudioFactoryForTests(() => {
    audio = new FakeAudio();
    return audio as unknown as AudioContext;
  });
  disarm = armMessageSound();
  setVisibility('visible');
});

afterEach(() => {
  disarm();
  audio = null;
  setAudioFactoryForTests(null);
  setVisibility('visible');
  setFocus(true);
  setDesktop(false);
});

describe('message sound (H6)', () => {
  it('stays silent until the first interaction, then chimes for another chat', async () => {
    const { msg } = await setup();
    setVisibleConversation(CONV.elif);
    handleEvent({ type: 'message.created', conversationId: CONV.milvaion, message: msg() });
    expect(FakeAudio.made).toBe(0);
    interact();
    expect(audio?.state).toBe('running');
    handleEvent({ type: 'message.created', conversationId: CONV.milvaion, message: msg() });
    expect(audio?.played).toHaveLength(1);
    expect(audible(audio?.played[0])).toBe(true);
  });

  it('is silent in the open chat on a visible tab, not when the tab is hidden', async () => {
    const { qc, msg } = await setup();
    setVisibleConversation(CONV.milvaion);
    expect(toneFor(qc, msg(), USER.bugra)).toBeNull();
    setVisibility('hidden');
    expect(toneFor(qc, msg(), USER.bugra)).toBe('message');
  });

  it('chimes for the open chat when its window is behind another one', async () => {
    const { qc, msg } = await setup();
    setVisibleConversation(CONV.milvaion);
    setFocus(false);
    expect(toneFor(qc, msg(), USER.bugra)).toBe('message');
  });

  it('plays in the desktop app without a click (a window opened in the tray)', async () => {
    disarm();
    setDesktop(true);
    disarm = armMessageSound();
    expect(FakeAudio.made).toBe(1);
    // Electron lets it run; the fake starts suspended, as a context the OS paused would.
    expect(playTone('message', { force: true })).toBe(true);
    await expect.poll(() => audio?.played.length).toBe(1);
    expect(audible(audio?.played[0])).toBe(true);
  });

  it('starts at the first chime once the page was interacted with', async () => {
    Object.defineProperty(navigator, 'userActivation', {
      configurable: true,
      value: { hasBeenActive: true },
    });
    try {
      expect(FakeAudio.made).toBe(0);
      expect(playTone('message', { force: true })).toBe(true);
      await expect.poll(() => audio?.played.length).toBe(1);
    } finally {
      delete (navigator as { userActivation?: unknown }).userActivation;
    }
  });

  it('chimes in a critical-only alert chat for a webhook text that reads critical', async () => {
    const { qc, msg } = await setup();
    patchConversation(qc, CONV.milvaion, (c) => ({ ...c, my: { ...c.my, notify: 'critical' } }));
    const bot = (text: string) => msg({ kind: 'webhook', author: null, text, card: null });
    expect(toneFor(qc, bot("❌ Job Execution Failed: Job 'X' failed."), USER.bugra)).toBe(
      'message',
    );
    expect(toneFor(qc, bot('⚠️ Job misfired'), USER.bugra)).toBeNull();
  });

  it('uses the brighter tone for mentions and direct messages', async () => {
    const { qc, msg } = await setup();
    const mention = msg({
      mentions: [{ kind: 'user', userId: USER.bugra }] as Message['mentions'],
    });
    expect(toneFor(qc, mention, USER.bugra)).toBe('mention');
    expect(toneFor(qc, msg({ conversationId: CONV.elif }), USER.bugra)).toBe('mention');
    interact();
    playTone('mention', { force: true });
    playTone('message', { force: true });
    playTone('mention', { force: true });
    const [mentionSound, messageSound, again] = audio!.played;
    expect(audible(mentionSound)).toBe(true);
    expect(mentionSound).not.toBe(messageSound);
    // Rendered once, then reused.
    expect(again).toBe(mentionSound);
  });

  it('never sounds for my own message, a muted chat or do-not-disturb', async () => {
    const { qc, msg } = await setup();
    const me = { id: USER.bugra, name: 'Ahmet Buğra Kösen', imageUrl: null };
    expect(toneFor(qc, msg({ author: me as Message['author'] }), USER.bugra)).toBeNull();

    const later = new Date(Date.now() + 3600_000).toISOString();
    patchConversation(qc, CONV.milvaion, (c) => ({ ...c, my: { ...c.my, mutedUntil: later } }));
    expect(toneFor(qc, msg(), USER.bugra)).toBeNull();
    patchConversation(qc, CONV.milvaion, (c) => ({
      ...c,
      my: { ...c.my, mutedUntil: null, notify: 'mentions' },
    }));
    expect(toneFor(qc, msg(), USER.bugra)).toBeNull();
    const mention = msg({
      mentions: [{ kind: 'user', userId: USER.bugra }] as Message['mentions'],
    });
    expect(toneFor(qc, mention, USER.bugra)).toBe('mention');

    patchConversation(qc, CONV.milvaion, (c) => ({ ...c, my: { ...c.my, notify: 'all' } }));
    setPresence([{ userId: USER.bugra, state: 'dnd', message: null, lastSeenAt: null } as never]);
    expect(toneFor(qc, msg(), USER.bugra)).toBeNull();
  });

  it('respects quiet hours, including a window over midnight', async () => {
    expect(inQuietHours({ from: '22:00', to: '08:00' }, '23:30')).toBe(true);
    expect(inQuietHours({ from: '22:00', to: '08:00' }, '07:59')).toBe(true);
    expect(inQuietHours({ from: '22:00', to: '08:00' }, '08:00')).toBe(false);
    expect(inQuietHours({ from: '12:00', to: '13:00' }, '12:30')).toBe(true);
    expect(inQuietHours(null, '12:30')).toBe(false);

    const { qc, msg } = await setup();
    qc.setQueryData(chatKeys.settings, { readReceipts: true, timezone: 'UTC', recentEmojis: [] });
    qc.setQueryData(chatKeys.notificationPrefs, {
      categories: [],
      digest: 'off',
      quietHours: { from: '00:00', to: '23:59' },
    });
    expect(toneFor(qc, msg(), USER.bugra, new Date('2026-10-21T10:00:00Z'))).toBeNull();
  });

  it('chimes for the first message of a chat that is not in the list yet', async () => {
    const { qc, msg } = await setup();
    // A group chat someone just started: it reaches me with its first message.
    qc.setQueryData<Conversation[]>(chatKeys.conversations, (list) =>
      list?.filter((c) => c.id !== CONV.selinCan),
    );
    qc.removeQueries({ queryKey: chatKeys.conversation(CONV.selinCan) });
    setVisibleConversation(CONV.elif);
    interact();
    handleEvent({
      type: 'message.created',
      conversationId: CONV.selinCan,
      message: msg({ conversationId: CONV.selinCan }),
    });
    await expect.poll(() => audio?.played.length).toBe(1);
  });

  it("plays the desktop app's notification chime, never for a muted chat", async () => {
    const { qc } = await setup();
    let listener:
      ((s: { tone: 'mention' | 'message'; conversationId: string | null }) => void) | null = null;
    let listening = false;
    Object.assign(window, {
      crewhallDesktop: {
        isDesktop: true,
        onNotificationSound: (l: typeof listener) => {
          listener = l;
          listening = true;
          return () => {
            listening = false;
          };
        },
      },
    });
    const off = armNotificationSound(qc, USER.bugra);
    expect(listening).toBe(true);
    interact();
    listener!({ tone: 'mention', conversationId: CONV.milvaion });
    await expect.poll(() => audio?.played.length).toBe(1);

    const later = new Date(Date.now() + 3600_000).toISOString();
    patchConversation(qc, CONV.milvaion, (c) => ({ ...c, my: { ...c.my, mutedUntil: later } }));
    expect(
      soundForNotification(qc, { tone: 'message', conversationId: CONV.milvaion }, USER.bugra),
    ).toBe(false);
    setMessageSoundOn(false);
    expect(soundForNotification(qc, { tone: 'message', conversationId: null }, USER.bugra)).toBe(
      false,
    );
    setMessageSoundOn(true);
    off();
    expect(listening).toBe(false);
  });

  it('can be turned off in this browser, and a burst chimes once', async () => {
    const { qc, msg } = await setup();
    setMessageSoundOn(false);
    expect(toneFor(qc, msg(), USER.bugra)).toBeNull();
    setMessageSoundOn(true);
    interact();
    expect(playTone('message')).toBe(true);
    expect(playTone('message')).toBe(false);
    expect(playTone('message', { force: true })).toBe(true);
  });
});

describe('only the session the person is at makes noise (API 55)', () => {
  /** A message to another chat than the open one, `attended` as the server said. */
  async function arrive(attended: boolean | undefined) {
    const { msg } = await setup();
    setVisibleConversation(CONV.elif);
    interact();
    handleEvent({
      type: 'message.created',
      conversationId: CONV.milvaion,
      message: msg(),
      ...(attended === undefined ? {} : { attended }),
    });
    return audio?.played.length ?? 0;
  }

  it('is silent where nobody looks while the person is at another session', async () => {
    setFocus(false);
    expect(await arrive(true)).toBe(0);
  });

  it('is silent in a hidden tab too', async () => {
    setVisibility('hidden');
    expect(await arrive(true)).toBe(0);
  });

  it('still chimes in the session being looked at (another chat open there)', async () => {
    expect(await arrive(true)).toBe(1);
  });

  it('chimes everywhere when the person is at no session', async () => {
    setFocus(false);
    expect(await arrive(false)).toBe(1);
  });

  it('keeps the old rules when the server does not say (older servers)', async () => {
    setFocus(false);
    expect(await arrive(undefined)).toBe(1);
  });

  it('may be this very page for a moment after it was left', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
      setFocus(false);
      noteLookedAway();
      // The server has not heard the blur heartbeat yet: "attended" may mean this page.
      expect(await arrive(true)).toBe(1);
      vi.setSystemTime(Date.now() + LOOK_GRACE_MS);
      const { msg } = await setup();
      handleEvent({
        type: 'message.created',
        conversationId: CONV.milvaion,
        message: msg(),
        attended: true,
      });
      expect(audio?.played).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('message sound setting', () => {
  it('turns the sound off in this browser and plays a preview', async () => {
    signedInAs(USER.bugra);
    renderApp('/notifications');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Bildirim ayarları' }));
    const toggle = await screen.findByRole('switch', { name: 'Mesaj sesi' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    // The click on "Dinle" is the interaction that unlocks audio.
    await user.click(screen.getByRole('button', { name: 'Dinle' }));
    expect(audio?.played).toHaveLength(1);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(localStorage.getItem('crewhall.messageSound')).toBe('off');
    expect(screen.getByRole('button', { name: 'Dinle' })).toBeDisabled();
  });
});
