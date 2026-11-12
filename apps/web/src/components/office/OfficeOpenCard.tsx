import { type DriveNode } from '@crewhall/shared';
import { Button, Icon } from '@crewhall/ui';
import { Link } from '@tanstack/react-router';
import { NodeIconBox } from '@/features/drive/NodeViews';
import { useI18n } from '@/lib/i18n/I18nContext';

/** Drive previewer for Word, Excel and PowerPoint files: open them in the office editor. */
export function OfficeOpenCard({ node, mode }: { node: DriveNode; mode: 'edit' | 'view' }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <NodeIconBox node={node} size="lg" />
      <span className="text-sub font-semibold">{node.name}</span>
      <span className="max-w-[360px] text-sm text-fg2">{t('office.open.hint')}</span>
      <Button variant="inv" asChild>
        <Link to="/office/$nodeId" params={{ nodeId: node.id }}>
          <Icon name={mode === 'edit' ? 'edit' : 'eye'} size={16} />
          {t(mode === 'edit' ? 'office.open.edit' : 'office.open.view')}
        </Link>
      </Button>
    </div>
  );
}
