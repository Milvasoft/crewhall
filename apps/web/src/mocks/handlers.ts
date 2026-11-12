import { authHandlers } from './auth';
import { chatRawHandlers } from './chat';
import { contractHandlers } from './contract';
import { vaultRawHandlers } from './vault';
import { driveRawHandlers } from './drive';
import { identityAuthHandlers } from './identity';
import { portalRawHandlers } from './portal';
import { aiRawHandlers } from './ai';
import { desktopReleaseRawHandlers } from './desktopReleases';

export const handlers = [
  ...identityAuthHandlers,
  ...authHandlers,
  ...driveRawHandlers,
  ...portalRawHandlers,
  ...chatRawHandlers,
  ...vaultRawHandlers,
  ...aiRawHandlers,
  ...desktopReleaseRawHandlers,
  ...contractHandlers,
];
