import { describe, expect, it } from 'vitest';
import { PLUGIN_PERMISSIONS } from '@crewhall/plugin-sdk';
import { CHAT_COMMANDS } from './chat-commands';
import { MCP_ONLY_SCOPES, MCP_SCOPES } from './schemas/mcp';

describe('plugin contract', () => {
  it('keeps plugin permissions the same set as token and MCP scopes, plus background access', () => {
    const shared = PLUGIN_PERMISSIONS.filter((p) => p !== 'offline:access');
    const scopes = MCP_SCOPES.filter((s) => !MCP_ONLY_SCOPES.includes(s));
    expect([...shared].sort()).toEqual([...scopes].sort());
  });

  it('documents that built-in chat commands win over plugin commands', () => {
    // A plugin command named like a built-in one is never reached (see Composer).
    expect(CHAT_COMMANDS).toContain('me');
  });
});
