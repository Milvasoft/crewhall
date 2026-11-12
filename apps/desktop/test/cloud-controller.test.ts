import { beforeEach, describe, expect, it } from 'vitest';
import { DriveController, type DriveHandle, type DriveSettings } from '../src/cloud/controller';
import type { CloudSpace } from '../src/cloud/drive';
import type { DriveProblem } from '../src/common/virtual-drive';
import type { PairStatus } from '../src/sync/engine';

const ROOT = 'C:\\Users\\m\\Crewhall';

class FakeHandle implements DriveHandle {
  started: CloudSpace[] | null = null;
  stopped = 0;
  removed = 0;
  spaces: CloudSpace[][] = [];
  changes = 0;
  synced = 0;
  confirmed: string[] = [];
  startError: unknown = null;
  list: PairStatus[] = [];

  constructor(
    readonly root: string,
    readonly onSpacesChanged: () => void,
  ) {}

  start(spaces: CloudSpace[]): Promise<void> {
    if (this.startError) return Promise.reject(this.startError as Error);
    this.started = spaces;
    return Promise.resolve();
  }
  stop(): Promise<void> {
    this.stopped++;
    return Promise.resolve();
  }
  remove(): Promise<void> {
    this.removed++;
    return Promise.resolve();
  }
  setSpaces(spaces: CloudSpace[]): Promise<void> {
    this.spaces.push(spaces);
    return Promise.resolve();
  }
  notifyChange(): void {
    this.changes++;
  }
  syncNow(): void {
    this.synced++;
  }
  confirmDeletes(pairId: string): void {
    this.confirmed.push(pairId);
  }
  statuses(): PairStatus[] {
    return this.list;
  }
}

describe('DriveController', () => {
  let settings: DriveSettings;
  let handles: FakeHandle[];
  let me: () => Promise<string>;
  let spaces: CloudSpace[];
  let problem: DriveProblem | null;
  let startError: unknown;
  let changes: number;
  let controller: DriveController;

  const make = (retryDelaysMs: readonly number[] = [60_000]) => {
    controller = new DriveController({
      settings: () => settings,
      save: (patch) => (settings = { ...settings, ...patch }),
      defaultRoot: () => ROOT,
      createDrive: (root, onSpacesChanged) => {
        const handle = new FakeHandle(root, onSpacesChanged);
        handle.startError = startError;
        handles.push(handle);
        return handle;
      },
      me: () => me(),
      listSpaces: () => Promise.resolve(spaces),
      checkRoot: () => Promise.resolve(problem),
      onChange: () => changes++,
      retryDelaysMs,
    });
  };

  beforeEach(() => {
    settings = { enabled: false, root: null, userId: null };
    handles = [];
    me = () => Promise.resolve('user-1');
    spaces = [{ id: 's1', name: 'Ekip' }];
    problem = null;
    startError = null;
    changes = 0;
    make();
  });

  it('stays off until the person wants it, and starts nothing', async () => {
    await controller.connect();
    expect(handles).toEqual([]);
    expect(controller.view()).toMatchObject({ enabled: false, state: 'off', root: ROOT });
  });

  it('starts when switched on, on the default folder, and remembers whose it is', async () => {
    await controller.connect();
    expect(await controller.setEnabled(true)).toEqual({ ok: true });
    expect(handles).toHaveLength(1);
    expect(handles[0]!.root).toBe(ROOT);
    expect(handles[0]!.started).toEqual(spaces);
    expect(settings).toEqual({ enabled: true, root: ROOT, userId: 'user-1' });
    expect(controller.view()).toMatchObject({ enabled: true, state: 'running', error: null });
    expect(changes).toBeGreaterThan(0);
  });

  it('starts by itself at the next connection, without asking again', async () => {
    settings = { enabled: true, root: 'D:\\Sürücü', userId: 'user-1' };
    await controller.connect();
    expect(handles[0]!.root).toBe('D:\\Sürücü');
    expect(handles[0]!.removed).toBe(0);
    expect(controller.view().state).toBe('running');
  });

  it('refuses a folder it cannot use and stays off', async () => {
    await controller.connect();
    problem = 'overlap';
    expect(await controller.setEnabled(true)).toEqual({ ok: false, error: 'overlap' });
    expect(settings.enabled).toBe(false);
    expect(handles).toEqual([]);
  });

  it('does not check the folder again at each start: its own files are in it', async () => {
    settings = { enabled: true, root: ROOT, userId: 'user-1' };
    problem = 'notEmpty';
    await controller.connect();
    expect(controller.view().state).toBe('running');
  });

  it('takes the files of another person off first', async () => {
    settings = { enabled: true, root: ROOT, userId: 'user-1' };
    me = () => Promise.resolve('user-2');
    await controller.connect();
    expect(handles).toHaveLength(2);
    expect(handles[0]!.removed).toBe(1);
    expect(handles[0]!.started).toBeNull();
    expect(handles[1]!.started).toEqual(spaces);
    expect(settings.userId).toBe('user-2');
  });

  it('touches nothing while nobody is signed in, and says so', async () => {
    settings = { enabled: true, root: ROOT, userId: 'user-1' };
    me = () => Promise.reject(Object.assign(new Error('x'), { status: 401 }));
    await controller.connect();
    expect(handles).toEqual([]);
    expect(settings.userId).toBe('user-1');
    expect(controller.view()).toMatchObject({
      state: 'error',
      error: { code: 'signed_out' },
    });
    await controller.disconnect();
  });

  it('tries again when the page signs in', async () => {
    settings = { enabled: true, root: ROOT, userId: 'user-1' };
    me = () => Promise.reject(Object.assign(new Error('x'), { status: 401 }));
    await controller.connect();
    me = () => Promise.resolve('user-1');
    controller.notifyChange();
    await controller.connect();
    expect(controller.view().state).toBe('running');
    expect(handles[0]!.started).toEqual(spaces);
  });

  it('tries again by itself after a failure, then stops trying once running', async () => {
    make([5]);
    settings = { enabled: true, root: ROOT, userId: 'user-1' };
    startError = new Error('sync root failed');
    await controller.connect();
    expect(controller.view()).toMatchObject({
      state: 'error',
      error: { code: 'failed', details: { text: 'sync root failed' } },
    });
    expect(handles[0]!.stopped).toBe(1);
    startError = null;
    const end = Date.now() + 2000;
    while (controller.view().state !== 'running' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(controller.view().state).toBe('running');
    const count = handles.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(handles).toHaveLength(count);
    await controller.disconnect();
  });

  it('tries again soon at first, then less often, and starts counting anew once running', async () => {
    make([5, 100_000]);
    settings = { enabled: true, root: ROOT, userId: 'user-1' };
    let asked = 0;
    let answer: () => Promise<string> = () => {
      asked++;
      return Promise.reject(Object.assign(new Error('x'), { status: 401 }));
    };
    me = () => answer();
    await controller.connect();
    expect(asked).toBe(1);
    const end = Date.now() + 2000;
    while (asked < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 2));
    expect(asked).toBe(2);
    // The long wait now: nothing more on its own.
    await new Promise((r) => setTimeout(r, 40));
    expect(asked).toBe(2);
    expect(controller.view().error).toMatchObject({ code: 'signed_out' });

    // A hint from the server does not wait for it.
    answer = () => Promise.resolve('user-1');
    controller.notifyChange();
    await controller.connect();
    expect(controller.view().state).toBe('running');
    await controller.disconnect();
  });

  it('stops trying once the connection is down', async () => {
    make([5]);
    settings = { enabled: true, root: ROOT, userId: 'user-1' };
    startError = new Error('x');
    await controller.connect();
    await controller.disconnect();
    const count = handles.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(handles).toHaveLength(count);
    expect(controller.view().state).toBe('off');
  });

  it('keeps the files when the connection goes down, and comes back', async () => {
    await controller.connect();
    await controller.setEnabled(true);
    await controller.disconnect();
    expect(handles[0]!.stopped).toBe(1);
    expect(handles[0]!.removed).toBe(0);
    expect(settings.enabled).toBe(true);
    expect(controller.view().state).toBe('off');
    await controller.connect();
    expect(handles).toHaveLength(2);
    expect(controller.view().state).toBe('running');
  });

  it('takes the files off when switched off', async () => {
    await controller.connect();
    await controller.setEnabled(true);
    expect(await controller.setEnabled(false)).toEqual({ ok: true });
    expect(handles[0]!.stopped).toBe(1);
    expect(handles[1]!.removed).toBe(1);
    expect(settings).toEqual({ enabled: false, root: ROOT, userId: null });
    expect(controller.view()).toMatchObject({ state: 'off', spaces: [] });
  });

  it('takes the files off when the server changes, though the app is not connected', async () => {
    settings = { enabled: true, root: ROOT, userId: 'user-1' };
    await controller.remove();
    expect(handles[0]!.removed).toBe(1);
    expect(settings.enabled).toBe(false);
    expect(settings.userId).toBeNull();
  });

  it('has nothing to take off when it was never on', async () => {
    await controller.remove();
    expect(handles).toEqual([]);
  });

  it('never overlaps two steps: quick on and off end up off', async () => {
    await controller.connect();
    await Promise.all([
      controller.setEnabled(true),
      controller.setEnabled(false),
      controller.setEnabled(true),
      controller.setEnabled(false),
    ]);
    expect(settings.enabled).toBe(false);
    expect(controller.view().state).toBe('off');
  });

  it('reads the spaces again when the feed says they changed', async () => {
    await controller.connect();
    await controller.setEnabled(true);
    spaces = [
      { id: 's1', name: 'Yeni Ad' },
      { id: 's2', name: 'İkinci' },
    ];
    handles[0]!.onSpacesChanged();
    await controller.connect();
    expect(handles[0]!.spaces).toEqual([spaces]);
    expect(controller.view().spaces.map((s) => s.name)).toEqual(['Yeni Ad', 'İkinci']);
  });

  it('shows each space with its status and passes the buttons on', async () => {
    await controller.connect();
    await controller.setEnabled(true);
    const status = { id: 'space-s1', state: 'confirm' } as PairStatus;
    handles[0]!.list = [status];
    expect(controller.view().spaces).toEqual([{ id: 's1', name: 'Ekip', status }]);
    controller.syncNow();
    controller.confirmDeletes('space-s1');
    controller.notifyChange();
    expect(handles[0]!.synced).toBe(1);
    expect(handles[0]!.confirmed).toEqual(['space-s1']);
    expect(handles[0]!.changes).toBe(1);
  });

  it('keeps a chosen folder only while the drive is off', async () => {
    controller.setRoot('D:\\Başka');
    expect(settings.root).toBe('D:\\Başka');
    await controller.connect();
    await controller.setEnabled(true);
    expect(handles[0]!.root).toBe('D:\\Başka');
    controller.setRoot('E:\\Olmaz');
    expect(settings.root).toBe('D:\\Başka');
  });
});
