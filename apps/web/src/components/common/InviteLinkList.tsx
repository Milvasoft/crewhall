import { Button, Icon, toast } from '@crewhall/ui';
import { useI18n } from '@/lib/i18n/I18nContext';

export interface InviteLink {
  email: string;
  url: string;
}

/**
 * Accept links to hand out when the server cannot send e-mail (bootstrap.auth.emailEnabled
 * false): setup wizard 1.13 and the invite dialog 9.7.
 */
export function InviteLinkList({ links }: { links: InviteLink[] }) {
  const { t } = useI18n();

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(t('setup.links.copied'));
    } catch {
      /* clipboard blocked: the link stays visible to copy by hand */
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {links.map((l) => (
          <li key={l.email} className="flex items-center gap-3 rounded-lg bg-bg2 py-2 pr-2 pl-3.5">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold">{l.email}</span>
              <span className="truncate font-mono text-xs text-fg2">{l.url}</span>
            </div>
            <Button size="sm" onClick={() => void copy(l.url)}>
              <Icon name="copy" size={16} />
              {t('setup2fa.codes.copy')}
            </Button>
          </li>
        ))}
      </ul>
      {links.length > 1 ? (
        <Button
          variant="gh"
          size="sm"
          className="self-start"
          onClick={() => void copy(links.map((l) => `${l.email}  ${l.url}`).join('\n'))}
        >
          {t('setup.links.copyAll')}
        </Button>
      ) : null}
    </div>
  );
}
