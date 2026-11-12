import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceMenu } from '@/components/meet/room/ControlBar';
import { I18nProvider } from '@/lib/i18n/I18nContext';

vi.mock('@livekit/components-react', () => ({
  useRoomContext: () => ({}),
  useMediaDeviceSelect: () => ({ activeDeviceId: '', setActiveMediaDevice: vi.fn() }),
}));

const device = (deviceId: string, label = ''): MediaDeviceInfo =>
  ({ deviceId, label, kind: 'videoinput', groupId: '', toJSON: () => ({}) }) as MediaDeviceInfo;

/** A browser whose device list the test controls; `devicechange` is fired by hand. */
function fakeDevices(initial: MediaDeviceInfo[]) {
  let list = initial;
  const listeners = new Set<() => void>();
  const stop = vi.fn();
  const md = {
    enumerateDevices: vi.fn(() => Promise.resolve(list)),
    getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [{ stop }] })),
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: md });
  return {
    md,
    stop,
    set: (next: MediaDeviceInfo[]) => {
      list = next;
    },
    change: () => listeners.forEach((fn) => fn()),
  };
}

function renderMenu() {
  render(
    <I18nProvider locale="tr">
      <DeviceMenu kind="videoinput" label="Kamera" />
    </I18nProvider>,
  );
  return userEvent.setup();
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('the device menu in the room', () => {
  it('numbers devices without permission and asks for it', async () => {
    const env = fakeDevices([device('a'), device('b')]);
    const user = renderMenu();
    await user.click(screen.getByRole('button', { name: 'Kamera' }));
    expect(await screen.findByRole('menuitem', { name: 'Kamera 1' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Kamera 2' })).toBeInTheDocument();

    env.set([device('a', 'FaceTime HD'), device('b', 'USB Camera')]);
    await user.click(screen.getByRole('menuitem', { name: 'İzin ver' }));
    expect(env.md.getUserMedia).toHaveBeenCalledWith({ video: true });
    expect(env.stop).toHaveBeenCalled();
    expect(await screen.findByRole('menuitem', { name: 'FaceTime HD' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'İzin ver' })).toBeNull();
  });

  it('says so when there is no device at all', async () => {
    fakeDevices([]);
    const user = renderMenu();
    await user.click(screen.getByRole('button', { name: 'Kamera' }));
    expect(await screen.findByRole('menuitem', { name: 'Cihaz bulunamadı' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'İzin ver' })).toBeInTheDocument();
  });

  it('follows a camera being plugged in', async () => {
    const env = fakeDevices([device('a', 'FaceTime HD')]);
    const user = renderMenu();
    await user.click(screen.getByRole('button', { name: 'Kamera' }));
    expect(await screen.findByRole('menuitem', { name: 'FaceTime HD' })).toBeInTheDocument();
    env.set([device('a', 'FaceTime HD'), device('c', 'Logitech C920')]);
    await act(async () => {
      env.change();
      await Promise.resolve();
    });
    expect(await screen.findByRole('menuitem', { name: 'Logitech C920' })).toBeInTheDocument();
  });
});
