import { describe, expect, it } from 'vitest';
import {
  CONTROLS_WIDTH,
  NO_DRAG,
  STRIP_HEIGHT,
  overlayHeight,
  parseTitleBarState,
  titleBarCss,
  titleBarWindowOptions,
} from '../src/common/titlebar';

const owned = { owned: true, height: 56, bg: '#f7f7f6', fg: '#141516' };

describe('title bar state from the page', () => {
  it('takes hex and rgb colours and a sane height', () => {
    expect(parseTitleBarState(owned)).toEqual(owned);
    expect(
      parseTitleBarState({ ...owned, bg: 'rgb(14, 15, 15)', fg: 'rgba(242,242,241,1)' }),
    ).not.toBeNull();
  });

  it('refuses anything else', () => {
    expect(parseTitleBarState({ ...owned, bg: 'url(x)' })).toBeNull();
    expect(parseTitleBarState({ ...owned, fg: 'red; background: url(x)' })).toBeNull();
    expect(parseTitleBarState({ ...owned, height: 400 })).toBeNull();
    expect(parseTitleBarState({ ...owned, height: 4 })).toBeNull();
    expect(parseTitleBarState('nope')).toBeNull();
  });

  it('sizes the window buttons to the bar, or to the strip without one', () => {
    expect(overlayHeight(owned)).toBe(56);
    expect(overlayHeight({ ...owned, owned: false })).toBe(STRIP_HEIGHT);
    expect(overlayHeight(null)).toBe(STRIP_HEIGHT);
  });
});

describe('window options', () => {
  it('overlays the system buttons on Windows and Linux, in the page colours', () => {
    expect(titleBarWindowOptions('win32', { bg: '#000000', fg: '#ffffff' })).toEqual({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#000000', symbolColor: '#ffffff', height: STRIP_HEIGHT },
    });
    expect(titleBarWindowOptions('linux', { bg: '#000000', fg: '#ffffff' }).titleBarStyle).toBe(
      'hidden',
    );
  });

  it('keeps the traffic lights on macOS, inside the 64 px rail', () => {
    const mac = titleBarWindowOptions('darwin', { bg: '#000000', fg: '#ffffff' });
    expect(mac).toMatchObject({ titleBarStyle: 'hiddenInset' });
    // Three 12 px lights 20 px apart.
    expect((mac.trafficLightPosition?.x ?? 99) + 52).toBeLessThanOrEqual(64);
  });
});

describe('page CSS', () => {
  const win = titleBarCss('win32');
  const mac = titleBarCss('darwin');

  it('drags by the bar but keeps its controls clickable', () => {
    expect(win).toContain('[data-titlebar] {\n  -webkit-app-region: drag;');
    expect(win).toContain(`[data-titlebar] :is(${NO_DRAG}) { -webkit-app-region: no-drag; }`);
    for (const el of ['button', 'a', 'input', '[role="tab"]', '[data-no-drag]'])
      expect(NO_DRAG.split(', ')).toContain(el);
  });

  it('leaves room for the window buttons: the width right of the title bar area', () => {
    expect(CONTROLS_WIDTH).toBe(
      'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw))',
    );
    expect(win).toContain(`padding-right: calc(${CONTROLS_WIDTH} + 8px)`);
    // macOS has its buttons on the left: the rail moves down instead.
    expect(mac).not.toContain('padding-right');
    expect(mac).toContain('[data-titlebar-rail] { padding-top: 40px');
    expect(win).not.toContain('data-titlebar-rail');
  });

  it('keeps a strip above pages without a bar and fits full-height layouts under it', () => {
    expect(win).toContain('html:not([data-titlebar-owned]) body { padding-top: 32px');
    expect(win).toContain('.min-h-screen { min-height: calc(100vh - 32px)');
    expect(win).toContain('html[data-titlebar-owned] #crewhall-titlebar-strip { display: none; }');
    // The web sets --kb inline (keyboard height), so the shell's room for the strip is the web's
    // own --desktop-strip; touching --kb here did nothing and hid the overflow on the chat page.
    expect(win).not.toContain('--kb');
  });
});
