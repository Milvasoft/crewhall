import { stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { Materializer } from '../sync/pass';
import type { RemoteEntry } from '../sync/types';
import { PinState, type CloudFilesNative } from './native';

const OK = '0x00000000';

/**
 * Server items on disk as placeholders; the identity of each is its node id.
 *
 * `onPlaced`: a file was put here or lost its bytes. Creating a placeholder raises no change in the
 * folder, and one inside a folder marked to stay has to come down.
 */
export function createMaterializer(
  native: CloudFilesNative,
  onPlaced: (abs: string) => void = () => undefined,
): Materializer {
  const place = async (abs: string, r: RemoteEntry, folder: boolean): Promise<void> => {
    const [result] = await native.createPlaceholders(dirname(abs), [
      {
        name: basename(abs),
        identity: r.nodeId,
        folder,
        size: folder ? 0 : r.size,
        mtimeMs: Date.parse(r.updatedAt),
      },
    ]);
    if (result !== OK) {
      throw Object.assign(new Error(`could not create ${basename(abs)}: ${result}`), {
        hresult: result,
      });
    }
  };

  return {
    async placeFile(abs, r) {
      await place(abs, r, false);
      onPlaced(abs);
    },
    placeFolder: (abs, r) => place(abs, r, true),

    async replaceFile(abs, r) {
      // A file whose conversion failed after its upload, or was saved over since.
      if (!(await native.info(abs)).placeholder) {
        await native.convertToPlaceholder(abs, r.nodeId);
      }
      // Windows refuses to drop the bytes of a file marked to stay. The mark goes back afterwards,
      // and that is what brings the new version down.
      const pinned = (await native.info(abs)).pin === PinState.pinned;
      if (pinned) await native.setPin(abs, PinState.unspecified);
      try {
        await native.updatePlaceholder(abs, {
          identity: r.nodeId,
          size: r.size,
          mtimeMs: Date.parse(r.updatedAt),
          dehydrate: true,
          // An edit since the pass looked would go with the bytes: fail, and the next pass sees it.
          verifyInSync: true,
        });
      } finally {
        if (pinned) await native.setPin(abs, PinState.pinned).catch(() => undefined);
      }
      onPlaced(abs);
    },

    async settle(abs, nodeId) {
      if ((await native.info(abs)).placeholder) {
        // Windows keeps its own record of the size, and an edit in place does not change it. Left
        // old, the file reads as that size once its bytes are freed, and can no longer come down.
        const now = await stat(abs);
        await native.updatePlaceholder(
          abs,
          now.isDirectory() ? { identity: nodeId } : { identity: nodeId, size: now.size },
        );
      } else {
        await native.convertToPlaceholder(abs, nodeId);
      }
    },

    async isCurrent(abs, nodeId) {
      try {
        const info = await native.info(abs);
        return info.placeholder && info.inSync && info.identity === nodeId;
      } catch {
        return false;
      }
    },
  };
}
