import { WsServerEvent } from '@crewhall/shared';
import { describe, expect, it } from 'vitest';
import {
  asksForNewWindow,
  fileNameOf,
  realtimeEffects,
  ringAction,
  sameAppPage,
  windowOpenDecision,
} from '../src/common/window-policy';

const origin = 'https://go.crewhall.app';

/** Every event type the server can send (the discriminated union's literals). */
const EVENT_TYPES = WsServerEvent.options.map((o) => o.shape.type.value as string);

describe('further windows', () => {
  it('come only from a middle click, never from window.open or target=_blank', () => {
    expect(asksForNewWindow('background-tab')).toBe(true);
    for (const d of ['foreground-tab', 'new-window', 'default', 'other', 'save-to-disk']) {
      expect(asksForNewWindow(d), d).toBe(false);
    }
  });

  it('are reused for the same page, whatever the hash', () => {
    const at = (p: string) => `${origin}${p}`;
    expect(sameAppPage(at('/chat/c/1'), '/chat/c/1', origin)).toBe(true);
    expect(sameAppPage(at('/chat/c/1#m4'), '/chat/c/1', origin)).toBe(true);
    expect(sameAppPage(at('/chat/c/1'), '/chat/c/2', origin)).toBe(false);
    expect(sameAppPage(at('/chat/c/1?m=4'), '/chat/c/1', origin)).toBe(false);
    expect(sameAppPage('https://other.example/chat/c/1', '/chat/c/1', origin)).toBe(false);
    expect(sameAppPage('', '/chat/c/1', origin)).toBe(false);
  });
});

describe('realtime events never open a window', () => {
  it('covers every server event type', () => {
    expect(EVENT_TYPES).toEqual(
      expect.arrayContaining(['notification', 'call.ringing', 'call.updated']),
    );
    for (const type of EVENT_TYPES) {
      const effects = realtimeEffects(type);
      expect(effects, type).not.toContain('window');
      for (const e of effects) {
        expect(['badge', 'notify', 'sync', 'ring', 'ring-over', 'catch-up']).toContain(e);
      }
    }
    // Unknown future events do nothing.
    expect(realtimeEffects('meet.something_new')).toEqual([]);
  });

  it('only raises the main window for a call when it is already on screen', () => {
    expect(ringAction({ mainVisible: true, mainMinimized: false, meetingOpen: false })).toBe(
      'raise',
    );
    // In the tray, minimised or in a meeting: a notification, no window.
    expect(ringAction({ mainVisible: false, mainMinimized: false, meetingOpen: false })).toBe(
      'notify',
    );
    expect(ringAction({ mainVisible: true, mainMinimized: true, meetingOpen: false })).toBe(
      'notify',
    );
    expect(ringAction({ mainVisible: true, mainMinimized: false, meetingOpen: true })).toBe(
      'notify',
    );
  });
});

describe('windowOpenDecision', () => {
  it('never opens an empty or about:blank pop-up (the web finds its meeting tab that way)', () => {
    expect(windowOpenDecision('', origin)).toEqual({ kind: 'deny' });
    expect(windowOpenDecision('about:blank', origin)).toEqual({ kind: 'deny' });
    expect(windowOpenDecision('javascript:alert(1)', origin)).toEqual({ kind: 'deny' });
    expect(windowOpenDecision('crewhall://chat/1', origin)).toEqual({ kind: 'deny' });
  });

  it('sends a meeting to its meeting window and other pages to the main window', () => {
    expect(windowOpenDecision(`${origin}/toplantilar/oda/abc?pencere=1`, origin)).toEqual({
      kind: 'meeting',
      url: `${origin}/toplantilar/oda/abc?pencere=1`,
    });
    expect(windowOpenDecision(`${origin}/m/xyz`, origin).kind).toBe('meeting');
    // English paths (paths.english) and the old Turkish ones alike.
    expect(windowOpenDecision(`${origin}/meetings/room/abc?window=1`, origin)).toEqual({
      kind: 'meeting',
      url: `${origin}/meetings/room/abc?window=1`,
    });
    expect(windowOpenDecision(`${origin}/meetings`, origin).kind).toBe('navigate');
    expect(windowOpenDecision(`${origin}/meetings/summary/s1`, origin).kind).toBe('navigate');
    expect(windowOpenDecision(`${origin}/drive/n1?x=1#y`, origin)).toEqual({
      kind: 'navigate',
      path: '/drive/n1?x=1#y',
    });
  });

  it('downloads files of the server and sends other sites to the browser', () => {
    expect(windowOpenDecision(`${origin}/api/v1/nodes/n1/download`, origin).kind).toBe('download');
    expect(windowOpenDecision('https://s3.example/bucket/file?sig=1', origin)).toEqual({
      kind: 'external',
      url: 'https://s3.example/bucket/file?sig=1',
    });
    expect(windowOpenDecision('mailto:a@b.c', origin).kind).toBe('external');
    expect(windowOpenDecision('https://go.crewhall.app.evil.io/x', origin).kind).toBe('external');
  });
});

describe('our files open in the app (sonraki-isler: resim tarayıcıda açılıyor)', () => {
  const presigned =
    'https://s3.go.crewhall.app/crewhall/org/abc.png?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=key%2F20261029%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261029T100000Z' +
    '&X-Amz-Expires=300&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123' +
    '&response-content-disposition=inline';

  it('shows a presigned storage link of the org in the viewer window, not the browser', () => {
    expect(windowOpenDecision(presigned, origin)).toEqual({ kind: 'viewer', url: presigned });
  });

  it('shows inline API files in the viewer and still downloads the others', () => {
    const inline = `${origin}/api/v1/chat/messages/m1/attachments/n1?disposition=inline`;
    expect(windowOpenDecision(inline, origin)).toEqual({ kind: 'viewer', url: inline });
    const save = `${origin}/api/v1/chat/messages/m1/attachments/n1?disposition=attachment`;
    expect(windowOpenDecision(save, origin).kind).toBe('download');
    expect(windowOpenDecision(`${origin}/api/v1/files/x`, origin).kind).toBe('download');
  });

  it('sends real outside sites to the browser, signed or not', () => {
    expect(windowOpenDecision('https://example.com/a.png', origin).kind).toBe('external');
    // Only a full signature (credential and signature) counts, not a look-alike query.
    expect(windowOpenDecision('https://evil.example/a.png?X-Amz-Signature=x', origin).kind).toBe(
      'external',
    );
  });
});

describe('fileNameOf (the page viewer shows the name)', () => {
  it('takes the download name the signed link asks for', () => {
    expect(
      fileNameOf(
        'https://s3.go.crewhall.app/b/k?response-content-disposition=inline%3B%20filename%3D%22rapor%20son.pdf%22&X-Amz-Signature=x',
      ),
    ).toBe('rapor son.pdf');
  });

  it('falls back to the last path part, and to nothing for nonsense', () => {
    expect(fileNameOf('https://go.crewhall.app/api/v1/files/foto.png?disposition=inline')).toBe(
      'foto.png',
    );
    expect(fileNameOf('not a url')).toBe('');
  });
});
