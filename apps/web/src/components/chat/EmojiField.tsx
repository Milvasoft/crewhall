import { Button, Icon } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';
import { EmojiPicker } from './EmojiPicker';

/** Channel emoji (group, space and alert chats): pick one from the picker, or remove it. */
export function EmojiField({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (emoji: string | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1.5">
      <EmojiPicker onPick={onChange} align="start">
        <Button
          type="button"
          variant="out"
          aria-label={value ? t('chat.emoji.change', { emoji: value }) : t('chat.emoji.pick')}
          className="min-w-10 px-2.5"
        >
          {value ? (
            <span className="text-[18px] leading-none">{value}</span>
          ) : (
            <Icon name="smile" size={17} />
          )}
        </Button>
      </EmojiPicker>
      {value ? (
        <Button type="button" variant="gh" size="sm" onClick={() => onChange(null)}>
          {t('chat.emoji.remove')}
        </Button>
      ) : null}
    </div>
  );
}
