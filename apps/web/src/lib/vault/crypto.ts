import { configureArgon2id, type Argon2idImpl, type Argon2idInput } from '@crewhall/crypto';

/**
 * Wires @crewhall/crypto to the browser: Argon2id runs in a module worker when available
 * (keeps the UI responsive), otherwise in place (tests, old browsers). Randomness uses Web
 * Crypto by default.
 */

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined' || import.meta.env.MODE === 'test') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; out?: Uint8Array; error?: string }>) => {
        const p = pending.get(e.data.id);
        if (!p) return;
        pending.delete(e.data.id);
        if (e.data.out) p.resolve(e.data.out);
        else p.reject(new Error(e.data.error ?? 'argon2 failed'));
      };
      worker.onerror = () => {
        for (const p of pending.values()) p.reject(new Error('argon2 worker failed'));
        pending.clear();
        worker = null;
      };
    } catch {
      worker = null;
    }
  }
  return worker;
}

const workerArgon2: Argon2idImpl = (input: Argon2idInput) => {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = ++seq;
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // A copy goes to the worker; the caller's buffer stays usable.
    w.postMessage({ id, input: { ...input, password: input.password.slice() } });
  });
};

let configured = false;

export function setupVaultCrypto() {
  if (configured) return;
  configured = true;
  if (getWorker()) {
    configureArgon2id(async (input) => {
      try {
        return await workerArgon2(input);
      } catch {
        // Fall back to the in-page implementation (same output).
        configureArgon2id(null);
        const { wasmArgon2 } = await import('@crewhall/crypto');
        return wasmArgon2(input);
      }
    });
  }
}
