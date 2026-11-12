/**
 * @crewhall/plugin-sdk: build plugins for Crewhall (docs/contracts/eklentiler.md).
 * - `.`: manifest schema and signed packages (shared by Crewhall, the marketplace and plugins);
 * - `./bridge`: the iframe bridge (plugin pages and Crewhall's web app);
 * - `./server`: signed requests and session tokens (plugin servers and Crewhall's backend).
 */
export * from './manifest';
export * from './package';
export * from './catalog';
