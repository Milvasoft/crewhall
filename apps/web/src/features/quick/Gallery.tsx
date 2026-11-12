import { type CardType } from '@crewhall/shared';
import { Icon, IconButton, Input, type IconName } from '@crewhall/ui';
import { useState } from 'react';
import { useI18n, type WebKey } from '@/lib/i18n/I18nContext';
import { useCardTypeEnabled } from '@/lib/identity/modules';
import { endGalleryDrag, startGalleryDrag } from './SurfaceGrid';
import { ResizablePane } from '@/components/shell/ResizablePane';

type Kind = { key: string; icon: IconName; type: CardType; size: [number, number] };

/** Card types of 2.2; the ones after `node` read their modules and hide while one is off. */
const KINDS: Kind[] = [
  { key: 'link', icon: 'link', type: 'link', size: [2, 1] },
  { key: 'link_group', icon: 'list', type: 'link_group', size: [3, 4] },
  { key: 'note', icon: 'sticky', type: 'note', size: [3, 2] },
  { key: 'todo', icon: 'todo', type: 'todo', size: [3, 3] },
  { key: 'node', icon: 'folder', type: 'node', size: [3, 2] },
  { key: 'page', icon: 'page', type: 'page', size: [3, 3] },
  { key: 'chat', icon: 'chat', type: 'chat', size: [3, 3] },
  { key: 'meeting', icon: 'video', type: 'meeting', size: [3, 2] },
  { key: 'board', icon: 'board', type: 'board_assigned', size: [4, 3] },
  { key: 'vault', icon: 'vault', type: 'vault_item', size: [3, 1] },
];

/** Right panel in edit mode: pick or drag a card type onto the surface (2.2). */
export function Gallery({
  surfaceName,
  onPick,
  onClose,
}: {
  surfaceName: string;
  onPick: (type: CardType) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const typeOn = useCardTypeEnabled();
  const shown = KINDS.filter((k) => typeOn(k.type)).filter((k) =>
    `${t(`quick.gallery.kinds.${k.key}` as WebKey)} ${t(`quick.gallery.hints.${k.key}` as WebKey)}`
      .toLocaleLowerCase()
      .includes(q.trim().toLocaleLowerCase()),
  );
  return (
    <ResizablePane id="home-gallery" side="right" defaultWidth={300}>
      <aside
        aria-label={t('quick.gallery.title')}
        className="flex w-full min-w-0 flex-col gap-3 overflow-y-auto border-l border-line bg-bg px-4 py-5"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col">
            <h2 className="m-0 text-sub font-semibold">{t('quick.gallery.title')}</h2>
            <span className="text-xs text-fg2">{t('quick.gallery.to', { name: surfaceName })}</span>
          </div>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('common.actions.close')}
            onClick={onClose}
          >
            <Icon name="x" size={15} />
          </IconButton>
        </div>
        <Input
          containerClassName="h-9 rounded-md"
          icon="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('quick.gallery.search')}
          aria-label={t('quick.gallery.search')}
        />
        <div className="grid grid-cols-2 gap-2">
          {shown.map((k) => (
            <button
              key={k.key}
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', k.type);
                startGalleryDrag(k.type, k.size[0], k.size[1]);
              }}
              onDragEnd={endGalleryDrag}
              onClick={() => onPick(k.type)}
              className="flex cursor-grab flex-col items-start gap-1.5 rounded-xl bg-surface p-3 text-left shadow-line hover:shadow-line2"
            >
              <span className="flex size-8 items-center justify-center rounded-md bg-bg2">
                <Icon name={k.icon} size={16} />
              </span>
              <span className="text-cap font-semibold">
                {t(`quick.gallery.kinds.${k.key}` as WebKey)}
              </span>
              <span className="text-[11.5px] leading-[15px] text-fg2">
                {t(`quick.gallery.hints.${k.key}` as WebKey)}
              </span>
            </button>
          ))}
        </div>
        <p className="m-0 text-xs text-fg3">{t('quick.gallery.tip')}</p>
      </aside>
    </ResizablePane>
  );
}
