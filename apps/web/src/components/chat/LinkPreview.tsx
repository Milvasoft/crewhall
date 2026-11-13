import { type MessageLinkPreview } from '@crewhall/shared';
import { Icon, IconButton, toast, Tooltip } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { patchMessage, putMessages } from '@/lib/chat/cache';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';

/**
 * Preview card of a message's first external link (kararlar.md 2026-11-13). The server read the
 * page; the picture loads from the site without a referrer. The author can remove the card.
 */
export function LinkPreviewCard({
  messageId,
  preview,
  canRemove,
}: {
  messageId: string;
  preview: MessageLinkPreview;
  canRemove: boolean;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [imageOk, setImageOk] = useState(true);
  const site = preview.siteName ?? hostOf(preview.url);

  const remove = async () => {
    setBusy(true);
    try {
      const next = await api.call('removeChatLinkPreview', { params: { messageId } });
      putMessages(qc, next.conversationId, [next]);
      patchMessage(qc, next.conversationId, next.id, () => next);
    } catch (e) {
      toast.error(t(errorKey(e)));
      setBusy(false);
    }
  };

  return (
    <div
      data-no-quick-react=""
      data-link-preview=""
      className="group/lp relative flex w-full max-w-[460px] min-w-0 overflow-hidden rounded-lg bg-bg shadow-line before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-line2 before:content-['']"
    >
      <a
        href={preview.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={t('chat.linkPreview.label', { name: site })}
        className="flex min-w-0 flex-1 gap-3 py-2.5 pr-3 pl-4 hover:bg-bg2"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-xs font-semibold text-fg3">{site}</span>
          {preview.title ? (
            <span className="line-clamp-2 text-[13.5px] leading-[19px] font-bold text-info">
              {preview.title}
            </span>
          ) : null}
          {preview.description ? (
            <span className="line-clamp-3 text-cap leading-[18px] text-fg2">
              {preview.description}
            </span>
          ) : null}
        </span>
        {preview.imageUrl && imageOk ? (
          <img
            src={preview.imageUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setImageOk(false)}
            className="size-[72px] shrink-0 self-center rounded-md bg-bg2 object-cover"
          />
        ) : null}
      </a>
      {canRemove ? (
        <Tooltip content={t('chat.linkPreview.remove')}>
          <IconButton
            size="xs"
            tone="plain"
            aria-label={t('chat.linkPreview.remove')}
            disabled={busy}
            onClick={() => void remove()}
            className="absolute top-1 right-1 bg-bg opacity-0 shadow-line transition-opacity group-hover/lp:opacity-100 focus-visible:opacity-100"
          >
            <Icon name="x" size={12} />
          </IconButton>
        </Tooltip>
      ) : null}
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
