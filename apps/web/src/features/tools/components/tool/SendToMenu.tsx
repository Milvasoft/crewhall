// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/tool/SendToMenu.tsx. See THIRD_PARTY.md.
// Crewhall: a Crewhall menu, TanStack navigation, and Crewhall targets (chat, page, Drive).
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@crewhall/ui';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  SendDialog,
  type SendRequest,
  type SendTarget,
} from '@/features/tools/crewhall/SendDialogs';
import { useLocalizedTool } from '@/features/tools/i18n';
import { getSendToTargets } from '@/features/tools/lib/registry';
import type { ToolDataType, ToolDefinition } from '@/features/tools/lib/tool-sdk';
import { stageTransfer } from '@/features/tools/lib/transfer/transfer';
import { Button } from '@/features/tools/components/ui/Button';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';

/**
 * "Send To": hands the current output to a compatible tool (targets come from the registry's
 * type rules, so no tool knows about another), or out of the tools: a chat, a new page or a
 * Drive file. The tool-to-tool payload travels in memory, never in the URL.
 */
export function SendToMenu({
  source,
  value,
  outputType,
}: {
  source: ToolDefinition;
  value: string;
  /** Override the source's static output type (tools whose output format is chosen at runtime). */
  outputType?: ToolDataType;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const localize = useLocalizedTool();
  const chatOn = useModuleEnabled('chat');
  const pagesOn = useModuleEnabled('wiki');
  const [request, setRequest] = useState<SendRequest | null>(null);
  const effectiveType = outputType ?? source.outputType;
  const targets = useMemo(
    () => getSendToTargets(source, effectiveType).map(localize),
    [source, effectiveType, localize],
  );
  const open = (target: SendTarget) =>
    setRequest({
      target,
      value,
      type: effectiveType,
      toolId: source.id,
      toolName: localize(source).name,
    });

  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <Button size="sm" variant="ghost" disabled={!value}>
            {t('tools.send.menu')}
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="max-h-[420px] w-[240px] overflow-y-auto">
          {chatOn ? (
            <MenuItem icon="chat" onSelect={() => open('chat')}>
              {t('tools.send.toChat')}
            </MenuItem>
          ) : null}
          {pagesOn ? (
            <MenuItem icon="page" onSelect={() => open('page')}>
              {t('tools.send.toPage')}
            </MenuItem>
          ) : null}
          <MenuItem icon="folder" onSelect={() => open('drive')}>
            {t('tools.send.toDrive')}
          </MenuItem>
          {targets.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuLabel>{t('tools.send.toTool')}</MenuLabel>
              {targets.map((d) => (
                <MenuItem
                  key={d.id}
                  onSelect={() => {
                    stageTransfer({
                      toolId: d.id,
                      value,
                      sourceType: effectiveType,
                      sourceToolId: source.id,
                    });
                    void navigate({ to: '/tools/$toolId', params: { toolId: d.id } });
                  }}
                >
                  {d.name}
                </MenuItem>
              ))}
            </>
          ) : null}
        </MenuContent>
      </Menu>
      <SendDialog request={request} onClose={() => setRequest(null)} />
    </>
  );
}
