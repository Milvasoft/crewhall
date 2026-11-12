import pkg from '../package.json';

/** apps/backend/package.json version; bundled into dist so the image needs no package.json lookup. */
export const PACKAGE_VERSION: string = pkg.version;
