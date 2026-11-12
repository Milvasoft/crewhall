import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { setAuthLatency } from '@/mocks/auth';
import { setMockLatency } from '@/mocks/contract';
import { disablePersistence, resetDb } from '@/mocks/db';
import { openChatDialog, openStatusDialog } from '@/components/chat/dialogs';
import { openDriveDialog } from '@/features/drive/actions';
import { resetUploads } from '@/features/drive/uploads';
import { resetConversationStore } from '@/lib/ai/conversation';
import { openDialog } from '@/lib/dialogs';
import { setPaletteOpen } from '@/lib/palette';
import { resetOutbox } from '@/lib/chat/outbox';
import { resetChatStores } from '@/lib/chat/stores';
import { clearSessionExpired } from '@/lib/sessionEvents';
import { resetChatConnections } from '@/mocks/chat';
import { server } from './support/server';

// Route guards chain a few mock requests before the first screen renders.
configure({ asyncUtilTimeout: 4000 });

disablePersistence();
setMockLatency(0);
setAuthLatency(0);

// jsdom lacks these browser APIs the UI touches.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
window.HTMLElement.prototype.scrollIntoView = () => undefined;
window.HTMLElement.prototype.hasPointerCapture = () => false;
window.HTMLElement.prototype.releasePointerCapture = () => undefined;
// jsdom has no layout for ranges; ProseMirror measures the selection when it scrolls to it.
window.Range.prototype.getClientRects ??= () =>
  ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
window.Range.prototype.getBoundingClientRect ??= () => new DOMRect();
globalThis.IntersectionObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
} as unknown as typeof IntersectionObserver;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom's document has focus only while an element is focused; a test page is the window in
// front, as for someone using the app (chat reads and sounds look at it: stores.isLooking).
// A test that needs another window in front overrides it with Object.defineProperty.
Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });

// Listen before test files import the app, so every fetch goes through the mock.
server.listen({ onUnhandledFrame: 'error' });
beforeEach(() => {
  // App-level stores outlive a render; start every test closed.
  setPaletteOpen(false);
  openDialog(null);
  openDriveDialog(null);
  resetUploads();
  openChatDialog(null);
  openStatusDialog(false);
  resetOutbox();
  resetChatStores();
  resetConversationStore();
  resetChatConnections();
  clearSessionExpired();
  resetDb('seed');
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('crewhall.locale', 'tr');
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => server.close());
