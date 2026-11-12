import { type Card, type SpaceColor } from '@crewhall/shared';
import {
  Button,
  cn,
  Field,
  Icon,
  IconButton,
  Input,
  Radio,
  RadioGroup,
  Segmented,
  Switch,
} from '@crewhall/ui';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ColorPicker } from '@/components/spaces/ColorPicker';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { newId } from '@/lib/ids';
import { type CardConfigOf, useQuick } from './context';
import { EditLinkDialog, type EditTarget } from './EditLinkDialog';
import { GroupSections } from './GroupSections';
import { ResizablePane } from '@/components/shell/ResizablePane';

type Group = Extract<Card, { type: 'link_group' }>;
type Config = CardConfigOf<'link_group'>;

const COLORS: SpaceColor[] = ['s1', 's2', 's3', 's4', 's5', 's6'];

/** Link group settings (2.5): the card updates live on the left as each change saves. */
export function GroupSettings({ card, onClose }: { card: Group; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuick();
  const c = card.config;
  const [title, setTitle] = useState(c.title);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const qc = useQueryClient();
  const set = (patch: Partial<Config> | ((prev: Config) => Partial<Config>)) =>
    q.updateConfig(card, (prev) => ({
      ...prev,
      ...(typeof patch === 'function' ? patch(prev) : patch),
    }));
  const setSection = (id: string, patch: Partial<Config['sections'][number]>) =>
    set((prev) => ({ sections: prev.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));

  return (
    <ResizablePane id="home-group" side="right" defaultWidth={320}>
      <aside
        aria-label={t('quick.settings.title')}
        className="flex w-full min-w-0 flex-col gap-4 overflow-y-auto border-l border-line bg-bg px-4 py-5"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col">
            <h2 className="m-0 text-sub font-semibold">{t('quick.settings.title')}</h2>
            <span className="text-xs text-fg2">{t('quick.gallery.kinds.link_group')}</span>
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

        <Field label={t('quick.settings.name')}>
          <Input
            value={title}
            maxLength={60}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title.trim() !== c.title && set({ title: title.trim() })}
          />
        </Field>

        <Row label={t('quick.settings.dot')}>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-pressed={c.color === null}
              onClick={() => set({ color: null })}
              className={cn(
                'h-[22px] rounded-[7px] px-2 text-[11px] font-semibold',
                c.color === null ? 'bg-fg text-bg' : 'bg-bg2 text-fg2',
              )}
            >
              {t('quick.settings.noDot')}
            </button>
            <ColorPicker
              value={c.color ?? 's1'}
              colors={COLORS}
              onChange={(color) => set({ color })}
              size={20}
            />
          </div>
        </Row>

        <Row label={t('quick.settings.density')}>
          <Segmented
            value={c.density ?? 'normal'}
            onValueChange={(density) => set({ density })}
            size="sm"
            aria-label={t('quick.settings.density')}
            options={(['compact', 'normal', 'large'] as const).map((v) => ({
              value: v,
              label: t(`quick.settings.densities.${v}`),
            }))}
          />
        </Row>

        <Row label={t('quick.settings.view')}>
          <Segmented
            value={c.view}
            onValueChange={(view) => set({ view })}
            size="sm"
            options={[
              { value: 'list', label: t('quick.settings.list'), icon: 'list' },
              { value: 'grid', label: t('quick.settings.grid'), icon: 'grid' },
            ]}
          />
        </Row>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-cap font-semibold">{t('quick.settings.sections')}</span>
            <Button
              size="xs"
              variant="gh"
              disabled={c.sections.length >= 12}
              onClick={() =>
                set((prev) => ({
                  sections: [
                    ...prev.sections,
                    {
                      id: newId(),
                      title: t('quick.settings.newSection', { n: prev.sections.length + 1 }),
                      items: [],
                    },
                  ],
                }))
              }
            >
              <Icon name="plus" size={14} />
              {t('quick.settings.addSection')}
            </Button>
          </div>
          <GroupSections
            card={card}
            onChange={(sections) => set({ sections })}
            onEdit={(sectionId, itemId) => setEditing({ sectionId, itemId })}
            onAdd={(sectionId) => q.addLink({ groupCardId: card.id, sectionId })}
            onRemoveLink={(sectionId, itemId) =>
              set((prev) => ({
                sections: prev.sections.map((x) =>
                  x.id === sectionId ? { ...x, items: x.items.filter((i) => i.id !== itemId) } : x,
                ),
              }))
            }
            onRenameSection={(id, title) => setSection(id, { title })}
            onRemoveSection={(id) =>
              set((prev) => ({ sections: prev.sections.filter((x) => x.id !== id) }))
            }
          />
        </div>

        <Toggle
          label={t('quick.settings.asTabs')}
          checked={c.sectionsAsTabs}
          onChange={(sectionsAsTabs) => set({ sectionsAsTabs })}
        />

        <div className="flex flex-col gap-2">
          <span className="text-cap font-semibold">{t('quick.settings.sort')}</span>
          <RadioGroup
            value={c.sort}
            onValueChange={(v) => set({ sort: v as Config['sort'] })}
            className="flex flex-col gap-2"
          >
            {(['manual', 'name', 'popular'] as const).map((v) => (
              <label key={v} className="flex items-center gap-2.5 text-cap">
                <Radio value={v} aria-label={t(`quick.settings.sorts.${v}`)} />
                {t(`quick.settings.sorts.${v}`)}
              </label>
            ))}
          </RadioGroup>
        </div>

        <Toggle
          label={t('quick.settings.showUrls')}
          checked={c.showUrls}
          onChange={(showUrls) => set({ showUrls })}
        />
        <Toggle
          label={t('quick.settings.showHealth')}
          checked={c.showHealth}
          onChange={(showHealth) => {
            set({ showHealth });
            // Showing health means checking it: links added with the check off join in.
            if (showHealth) void enableChecks(qc, card);
          }}
        />

        <div className="mt-auto flex items-center justify-between border-t border-line pt-3">
          <Button size="sm" variant="dng" onClick={() => q.remove(card)}>
            {t('quick.settings.removeCard')}
          </Button>
          <span className="text-xs text-fg3">{t('quick.settings.autosave')}</span>
        </div>
        <EditLinkDialog card={card} target={editing} onClose={() => setEditing(null)} />
      </aside>
    </ResizablePane>
  );
}

/** Turns the health check on for the group's links that have it off. */
export async function enableChecks(qc: QueryClient, card: Group): Promise<void> {
  const off = Object.values(card.links).filter((l) => !l.checkEnabled);
  if (!off.length) return;
  await Promise.all(
    off.map((l) =>
      api.call('updateLink', { params: { linkId: l.id }, body: { checkEnabled: true } }),
    ),
  );
  await qc.invalidateQueries({ queryKey: ['surfaces'] });
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-cap font-semibold">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-cap font-semibold">
      {label}
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
