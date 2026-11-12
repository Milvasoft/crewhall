import { type IdpRoleMapping } from '@crewhall/shared';
import {
  Button,
  Icon,
  IconButton,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '@/lib/i18n/I18nContext';
import { orgSpacesQuery } from '@/lib/queries';

const NONE = '__none';
type OrgRole = NonNullable<IdpRoleMapping['orgRole']>;
type SpaceRole = NonNullable<IdpRoleMapping['spaceRole']>;
const ORG_ROLES: OrgRole[] = ['admin', 'member', 'guest'];
const SPACE_ROLES: SpaceRole[] = ['admin', 'editor', 'viewer'];

/**
 * IdP group → org role and/or space + space role (9.14). The highest mapped org role wins;
 * owner can never come from a directory.
 */
export function RoleMappingEditor({
  value,
  onChange,
  groupHint,
}: {
  value: IdpRoleMapping[];
  onChange: (v: IdpRoleMapping[]) => void;
  groupHint: string;
}) {
  const { t } = useI18n();
  const spaces = useQuery(orgSpacesQuery());
  const update = (i: number, patch: Partial<IdpRoleMapping>) =>
    onChange(value.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 ? (
        <p className="m-0 rounded-lg bg-bg2 px-3 py-2.5 text-xs text-fg2">
          {t('identity.idp.noMappings')}
        </p>
      ) : (
        <div className="hidden grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_32px] gap-2 px-1 text-[11.5px] font-semibold text-fg3 md:grid">
          <span>{t('identity.idp.mapGroup')}</span>
          <span>{t('identity.idp.mapOrgRole')}</span>
          <span>{t('identity.idp.mapSpace')}</span>
          <span>{t('identity.idp.mapSpaceRole')}</span>
          <span />
        </div>
      )}
      {value.map((m, i) => {
        const incomplete = !m.group.trim() || (!m.orgRole && !m.spaceId);
        return (
          <div
            key={i}
            className="grid grid-cols-1 items-center gap-2 rounded-lg bg-bg2 p-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_32px] md:bg-transparent md:p-0"
          >
            <Input
              aria-label={t('identity.idp.mapGroup')}
              value={m.group}
              placeholder={groupHint}
              onChange={(e) => update(i, { group: e.target.value })}
              invalid={incomplete && m.group.length > 0}
              spellCheck={false}
              className="font-mono text-[12.5px]"
              containerClassName="h-9 rounded-md"
            />
            <Select
              value={m.orgRole ?? NONE}
              onValueChange={(v) => update(i, { orgRole: v === NONE ? null : (v as OrgRole) })}
            >
              <SelectTrigger className="h-9" aria-label={t('identity.idp.mapOrgRole')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('identity.idp.mapKeep')}</SelectItem>
                {ORG_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`common.roles.org.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={m.spaceId ?? NONE}
              onValueChange={(v) =>
                update(i, {
                  spaceId: v === NONE ? null : v,
                  spaceRole: v === NONE ? null : (m.spaceRole ?? 'editor'),
                })
              }
            >
              <SelectTrigger className="h-9" aria-label={t('identity.idp.mapSpace')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('identity.idp.mapNoSpace')}</SelectItem>
                {(spaces.data?.items ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
                {m.spaceId && !spaces.data?.items.some((s) => s.id === m.spaceId) ? (
                  <SelectItem value={m.spaceId}>{t('identity.idp.mapUnknownSpace')}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            <Select
              value={m.spaceRole ?? 'editor'}
              disabled={!m.spaceId}
              onValueChange={(v) => update(i, { spaceRole: v as SpaceRole })}
            >
              <SelectTrigger className="h-9" aria-label={t('identity.idp.mapSpaceRole')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPACE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {t(`common.roles.space.${r}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <IconButton
              size="xs"
              tone="plain"
              aria-label={t('identity.idp.mapRemove')}
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Icon name="x" size={15} />
            </IconButton>
          </div>
        );
      })}
      <Button
        size="sm"
        variant="out"
        className="self-start"
        onClick={() =>
          onChange([...value, { group: '', orgRole: 'member', spaceId: null, spaceRole: null }])
        }
      >
        <Icon name="plus" size={14} />
        {t('identity.idp.mapAdd')}
      </Button>
    </div>
  );
}
