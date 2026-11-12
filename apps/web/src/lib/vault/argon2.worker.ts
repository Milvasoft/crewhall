/// <reference lib="webworker" />
import { wasmArgon2, type Argon2idInput } from '@crewhall/crypto';

/**
 * Argon2id off the main thread: 64 MiB / 3 passes takes about a second and would freeze the
 * page otherwise. The password bytes are wiped once the hash is computed.
 */
self.onmessage = async (e: MessageEvent<{ id: number; input: Argon2idInput }>) => {
  const { id, input } = e.data;
  try {
    const out = await wasmArgon2(input);
    input.password.fill(0);
    (self as unknown as Worker).postMessage({ id, out }, [out.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
