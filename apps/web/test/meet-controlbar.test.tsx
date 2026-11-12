import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@crewhall/ui';
import { ControlBar } from '@/components/meet/room/ControlBar';
import { I18nProvider } from '@/lib/i18n/I18nContext';

const guestRoom = vi.hoisted(() => ({ on: false }));
const local = {
  identity: 'u-bugra',
  attributes: {} as Record<string, string>,
  permissions: { canPublish: true, canPublishSources: [] as number[] },
  setMicrophoneEnabled: vi.fn(async () => undefined),
  setCameraEnabled: vi.fn(async () => undefined),
  setScreenShareEnabled: vi.fn(async () => undefined),
  setAttributes: vi.fn(async () => undefined),
};

vi.mock('@livekit/components-react', () => ({
  useLocalParticipant: () => ({
    localParticipant: local,
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    isScreenShareEnabled: false,
  }),
  useParticipants: () => [local],
  useRoomContext: () => ({
    localParticipant: local,
    remoteParticipants: new Map(),
    on: () => undefined,
    off: () => undefined,
  }),
  useMediaDeviceSelect: () => ({ devices: [], activeDeviceId: '', setActiveMediaDevice: vi.fn() }),
  useRoomInfo: () => ({ metadata: undefined }),
}));

vi.mock('../src/components/meet/room/context', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRoomState: () => ({ moderator: false, guest: guestRoom.on, react: vi.fn() }),
  useRoomMeta: () => null,
}));

/** A browser with camera, microphone and screen capture; `narrow` emulates a phone. */
function browser(narrow: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: narrow && q.includes('max-width'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(), getDisplayMedia: vi.fn() },
  });
}

function renderBar(onSettings = vi.fn()) {
  render(
    <I18nProvider locale="tr">
      <TooltipProvider>
        <ControlBar
          canRecord
          onRecord={vi.fn()}
          onSettings={onSettings}
          onLeave={vi.fn()}
          onEndForAll={vi.fn()}
        />
      </TooltipProvider>
    </I18nProvider>,
  );
  return onSettings;
}

afterEach(() => {
  guestRoom.on = false;
  local.permissions = { canPublish: true, canPublishSources: [] };
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('meeting control bar', () => {
  it('tells a guest on hover why they cannot share, and offers no recording', async () => {
    browser(false);
    guestRoom.on = true;
    // TrackSource: camera 1, microphone 2; no screen share.
    local.permissions = { canPublish: true, canPublishSources: [1, 2] };
    renderBar();
    const share = screen.getByRole('button', {
      name: 'Moderatör izin verince paylaşabilirsin',
    });
    expect(share).toHaveAttribute('aria-disabled', 'true');
    // Not the disabled attribute: that would swallow the hover the tooltip needs.
    expect(share).not.toBeDisabled();
    const user = userEvent.setup();
    await user.hover(share);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Moderatör izin verince paylaşabilirsin',
    );
    await user.click(share);
    expect(local.setScreenShareEnabled).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Kaydı/ })).toBeNull();
  });

  it('shows every control with device menus on a wide screen', () => {
    browser(false);
    renderBar();
    expect(screen.getByRole('button', { name: 'Ekran paylaş' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ayarlar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mikrofon' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Daha fazla' })).toBeNull();
  });

  it('shares without sound by default; the arrow next to the button turns sound on', async () => {
    browser(false);
    window.localStorage.removeItem('crewhall.meet.prefs');
    renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Ekran paylaş' }));
    expect(local.setScreenShareEnabled).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ audio: false }),
      expect.anything(),
    );
    await user.click(screen.getByRole('button', { name: 'Paylaşım seçenekleri' }));
    const sound = await screen.findByRole('menuitemcheckbox', { name: /Sesi de paylaş/ });
    expect(sound).toHaveAttribute('aria-checked', 'false');
    await user.click(sound);
    expect(sound).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Ekran paylaş' }));
    expect(local.setScreenShareEnabled).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ audio: true }),
      expect.anything(),
    );
    window.localStorage.removeItem('crewhall.meet.prefs');
  });

  it('fits a phone: no device menus, sharing, recording and settings under "Daha fazla"', async () => {
    browser(true);
    const onSettings = renderBar();
    expect(screen.queryByRole('button', { name: 'Ekran paylaş' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ayarlar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mikrofon' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ayrıl' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Daha fazla' }));
    expect(await screen.findByRole('menuitem', { name: 'Ekran paylaş' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Kaydı başlat' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Ayarlar' }));
    expect(onSettings).toHaveBeenCalled();
  });

  it('offers no screen sharing where the browser cannot capture the screen', async () => {
    browser(true);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn() },
    });
    renderBar();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Daha fazla' }));
    expect(await screen.findByRole('menuitem', { name: 'Ayarlar' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Ekran paylaş' })).toBeNull();
  });
});
