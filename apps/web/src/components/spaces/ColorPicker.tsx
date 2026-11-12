import { type SpaceColor } from '@crewhall/shared';
import { cn, Icon } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';

const BG: Record<SpaceColor, string> = {
  s1: 'bg-s1',
  s2: 'bg-s2',
  s3: 'bg-s3',
  s4: 'bg-s4',
  s5: 'bg-s5',
  s6: 'bg-s6',
};

/** Space category color swatches. s6 (gray) is reserved for the personal space. */
export const SHARED_COLORS: SpaceColor[] = ['s1', 's2', 's3', 's4', 's5'];

export function ColorPicker({
  value,
  onChange,
  colors = SHARED_COLORS,
  size = 22,
}: {
  value: SpaceColor;
  onChange: (c: SpaceColor) => void;
  colors?: SpaceColor[];
  size?: number;
}) {
  const { t } = useI18n();
  return (
    <div role="radiogroup" aria-label={t('spaces.color')} className="flex items-center gap-2">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={t(`spaces.colors.${c}`)}
          onClick={() => onChange(c)}
          style={{ width: size, height: size }}
          className={cn(
            'flex shrink-0 items-center justify-center rounded-[7px] text-white',
            BG[c],
            value === c && 'shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--fg)]',
          )}
        >
          {value === c ? <Icon name="check" size={13} strokeWidth={3} /> : null}
        </button>
      ))}
    </div>
  );
}
