// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/user-agent-parser/logic.ts. See THIRD_PARTY.md.
import { UAParser } from 'ua-parser-js';

export interface UaField {
  label: string;
  value: string;
}

const j = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' ').trim();

// ua-parser-js 1.x (MIT; 2.x is AGPL) still says "Mac OS"; use Apple's current name.
const osName = (name: string | undefined) => (name === 'Mac OS' ? 'macOS' : name);

/** Parse a User-Agent string into labeled, display-ready fields. */
export function parseUserAgent(ua: string): UaField[] {
  const r = new UAParser(ua).getResult();
  return [
    { label: 'Browser', value: j(r.browser.name, r.browser.version) || 'Unknown' },
    { label: 'Engine', value: j(r.engine.name, r.engine.version) || 'Unknown' },
    { label: 'Operating system', value: j(osName(r.os.name), r.os.version) || 'Unknown' },
    {
      label: 'Device',
      value:
        j(r.device.vendor, r.device.model) || (r.device.type ? r.device.type : 'Desktop / unknown'),
    },
    { label: 'Device type', value: r.device.type || 'desktop' },
    { label: 'CPU architecture', value: r.cpu.architecture || 'Unknown' },
  ];
}
