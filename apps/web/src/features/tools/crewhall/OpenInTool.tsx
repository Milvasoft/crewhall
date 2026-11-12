import { type DriveNode } from '@crewhall/shared';
import { Button, Icon, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@crewhall/ui';
import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useModuleEnabled } from '@/lib/identity/modules';
import { useLocalizedTool } from '@/features/tools/i18n';
import { toolsForFile } from './output';

/**
 * "Araçta aç" in the Drive viewer: the tools that read this file's type (JSON, YAML, CSV,
 * SQL…), best match first. The tool page loads the file itself; only its id is in the URL.
 */
export function OpenInTool({ node }: { node: DriveNode }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const toolsOn = useModuleEnabled('tools');
  const localize = useLocalizedTool();
  const tools = useMemo(
    () => (node.type === 'file' ? toolsForFile(node.name).map(localize) : []),
    [node, localize],
  );
  if (!toolsOn || tools.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm" variant="out" aria-label={t('tools.open.fromDrive')}>
          <Icon name="tool" size={16} />
          <span className="max-md:hidden">{t('tools.open.fromDrive')}</span>
        </Button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-[360px] w-[240px] overflow-y-auto">
        <MenuLabel>{t('tools.open.pick')}</MenuLabel>
        {tools.map((d) => (
          <MenuItem
            key={d.id}
            onSelect={() =>
              void navigate({
                to: '/tools/$toolId',
                params: { toolId: d.id },
                search: { node: node.id },
              })
            }
          >
            {d.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
