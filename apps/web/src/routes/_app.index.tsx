import { type Space } from '@crewhall/shared';
import { Button, cn, Icon, Skeleton, SpaceDot, type IconName } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { Workspace } from '@/components/shell/Workspace';
import { QuickHome } from '@/features/quick/QuickHome';
import { SpaceAvatar } from '@/components/spaces/SpaceAvatar';
import { spaceName, spaceSubtitle } from '@/components/spaces/spaceUtils';
import { openDialog } from '@/lib/dialogs';
import { formatWeekdayDate } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';
import { spacesQuery } from '@/lib/queries';
import { usePermissions } from '@/lib/session';

export const Route = createFileRoute('/_app/')({
  validateSearch: z.object({ surface: z.string().optional() }),
  component: HomePage,
});

function HomePage() {
  const { surface } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <QuickHome
      surfaceSlug={surface}
      onSurfaceSlug={(slug) => void navigate({ to: '/', search: slug ? { surface: slug } : {} })}
      fallback={<WelcomeHome />}
    />
  );
}

function greetingKey(h: number) {
  if (h < 5) return 'home.greeting.night' as const;
  if (h < 12) return 'home.greeting.morning' as const;
  if (h < 18) return 'home.greeting.afternoon' as const;
  return 'home.greeting.evening' as const;
}

/**
 * Phase 0 welcome: shown while the server does not serve quick access surfaces yet
 * (501 not_implemented), with the person's spaces and first steps (2.11 tone).
 */
function WelcomeHome() {
  const { t, locale } = useI18n();
  const { me, canOrg } = usePermissions();
  const spaces = useQuery(spacesQuery());
  const [surface, setSurface] = useState<string>('mine');
  const shared = (spaces.data?.items ?? []).filter((s) => s.kind === 'shared');
  const firstName = me?.user.name.split(' ')[0] ?? '';
  const now = new Date();

  const tabs = (
    <div
      role="tablist"
      aria-label={t('home.surfaces')}
      className="flex items-center gap-1 rounded-md bg-bg2 p-[3px]"
    >
      <SurfaceTab on={surface === 'mine'} onClick={() => setSurface('mine')}>
        {t('home.mine')}
      </SurfaceTab>
      {shared.slice(0, 4).map((s) => (
        <SurfaceTab key={s.id} on={surface === s.id} onClick={() => setSurface(s.id)}>
          <SpaceDot color={s.color} />
          {s.name}
        </SurfaceTab>
      ))}
    </div>
  );

  const current = shared.find((s) => s.id === surface);

  return (
    <Workspace topLeft={tabs}>
      <div className="flex shrink-0 items-end justify-between gap-4">
        <div className="flex flex-col">
          <h1 className="m-0 text-wtitle font-bold">
            {t(greetingKey(now.getHours()), { name: firstName })}
          </h1>
          <span className="text-[13.5px] leading-[18px] text-fg2">
            {formatWeekdayDate(now, locale)}
          </span>
        </div>
      </div>

      <section className="flex flex-col items-center gap-2 rounded-2xl bg-surface px-6 py-10 text-center shadow-line">
        <span className="eyebrow">{t('home.eyebrow')}</span>
        <h2 className="m-0 text-title font-bold">
          {current
            ? t('home.spaceSurfaceTitle', { name: current.name })
            : t('home.emptyTitle', { name: firstName })}
        </h2>
        <p className="m-0 max-w-[560px] text-sm text-fg2">{t('home.emptyBody')}</p>
        <div className="mt-4 grid w-full max-w-[760px] grid-cols-3 gap-3 text-left">
          {canOrg('org.create_space') ? (
            <StepCard
              icon="space"
              title={t('home.steps.space')}
              body={t('home.steps.spaceBody')}
              onClick={() => openDialog('newSpace')}
            />
          ) : null}
          {canOrg('org.invite') ? (
            <StepCard
              icon="userPlus"
              title={t('home.steps.invite')}
              body={t('home.steps.inviteBody')}
              to="/admin/members"
            />
          ) : null}
          <StepCard
            icon="shield"
            title={t('home.steps.security')}
            body={t('home.steps.securityBody')}
            to="/account/security"
          />
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <span className="eyebrow">{t('home.yourSpaces')}</span>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3">
          {spaces.isLoading
            ? Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-[72px] rounded-xl" />
              ))
            : (spaces.data?.items ?? []).map((s) => <SpaceCard key={s.id} space={s} />)}
        </div>
      </section>
    </Workspace>
  );
}

function SurfaceTab({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={cn(
        'flex h-[30px] items-center gap-1.5 rounded-sm px-3 text-cap font-medium whitespace-nowrap text-fg2 hover:text-fg',
        on && 'bg-surface font-semibold text-fg shadow-sm dark:bg-capsule',
      )}
    >
      {children}
    </button>
  );
}

function StepCard({
  icon,
  title,
  body,
  to,
  onClick,
}: {
  icon: IconName;
  title: string;
  body: string;
  to?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="flex size-9 items-center justify-center rounded-md bg-bg2 text-fg">
        <Icon name={icon} size={18} />
      </span>
      <span className="text-sm font-semibold">{title}</span>
      <span className="text-cap text-fg2">{body}</span>
    </>
  );
  const cls =
    'flex flex-col gap-1.5 rounded-xl p-4 text-left shadow-line transition-colors hover:bg-bg2 hover:shadow-line2';
  return to ? (
    <Link to={to} className={cls}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

function SpaceCard({ space }: { space: Space }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <Button
      variant="out"
      className="h-[72px] justify-start gap-3 rounded-xl bg-surface px-3.5 shadow-line"
      onClick={() =>
        void navigate({
          to: '/$module/$spaceSlug',
          params: { module: 'drive', spaceSlug: space.slug },
        })
      }
    >
      <SpaceAvatar space={space} size="lg" />
      <span className="flex min-w-0 flex-col items-start">
        <span className="truncate text-sm font-semibold">{spaceName(space, t)}</span>
        <span className="truncate text-xs font-normal text-fg2">{spaceSubtitle(space, t)}</span>
      </span>
    </Button>
  );
}
