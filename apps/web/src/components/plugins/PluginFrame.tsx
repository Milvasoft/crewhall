import { frameAllow, localize } from '@crewhall/plugin-sdk';
import { attachHost, type BridgeContextInput } from '@crewhall/plugin-sdk/bridge';
import { type PluginSurface } from '@crewhall/shared';
import { Button, cn, Dialog, DialogContent, DialogFooter, DialogHeader, toast } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/I18nContext';
import { pluginKeys } from '@/lib/plugins/queries';
import { useMe } from '@/lib/session';
import { useTheme } from '@/lib/theme/ThemeContext';
import { useBootstrap } from '@/lib/useBranding';

/**
 * A plugin page (docs/contracts/eklentiler.md › Köprü): the plugin's own origin in a sandboxed
 * iframe. It reaches Crewhall only through the bridge (token, navigate, toast, resize), and the
 * bridge answers only that origin and this frame.
 */

// allow-same-origin keeps the plugin's *own* origin (its cookies, storage); it never gets ours.
// allow-popups-to-escape-sandbox: a link the plugin opens (a map, a shared page) is a normal
// tab, not one stuck in this sandbox; its opener is the plugin frame, never Crewhall's window.
const SANDBOX =
  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-same-origin';

function accentColour(): string {
  if (typeof document === 'undefined') return '#FBC419';
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#FBC419'
  );
}

export function PluginFrame({
  surface,
  entry,
  placement,
  className,
  autoHeight,
  deepLink,
}: {
  surface: PluginSurface;
  entry: { id: string; url: string };
  /**
   * The Crewhall URL's query and fragment (a notification's `/plugins/<id>/<tab>?chat=42`):
   * added to the tab's own URL, so the plugin opens on that item.
   */
  deepLink?: { search: string; hash: string };
  placement: BridgeContextInput['placement'];
  className?: string;
  /** Cards: the plugin's `resize` sets the height (clamped). */
  autoHeight?: { min: number; max: number };
}) {
  const { t, locale } = useI18n();
  const me = useMe();
  const { branding } = useBootstrap();
  const { scheme } = useTheme();
  const navigate = useNavigate();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const qc = useQueryClient();
  // The plugin asked for background access: only this dialog, in Crewhall's own page, can say yes.
  const [consent, setConsent] = useState<((ok: boolean) => void) | null>(null);
  const search = deepLink?.search ?? '';
  const hash = deepLink?.hash ?? '';
  const src = useMemo(() => {
    const url = new URL(entry.url, surface.origin);
    for (const [k, v] of new URLSearchParams(search)) url.searchParams.set(k, v);
    if (hash) url.hash = hash;
    return url.toString();
  }, [entry.url, surface.origin, search, hash]);
  const name = localize(surface.name, locale);
  const minH = autoHeight?.min;
  const maxH = autoHeight?.max;

  // A refetch gives a new array; only a changed grant reloads the frame.
  const granted = surface.permissions?.join() ?? '';
  const delegated = surface.browser?.join() ?? '';
  const context = useMemo<BridgeContextInput | null>(
    () =>
      me
        ? {
            pluginId: surface.pluginId,
            installationId: surface.installationId,
            placement,
            entryId: entry.id,
            user: { id: me.user.id, name: me.user.name, email: me.user.email },
            org: { id: me.activeOrgId ?? '', name: branding.orgName },
            locale,
            theme: { scheme, accent: accentColour() },
            platform: 'web',
            permissions: surface.permissions ?? [],
            browser: surface.browser ?? [],
          }
        : null,
    // The theme goes out as its own message; it does not reload the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [me?.user.id, surface.installationId, granted, delegated, entry.id, placement, locale],
  );

  const host = useRef<ReturnType<typeof attachHost> | null>(null);
  useEffect(() => {
    if (!context) return;
    host.current = attachHost({
      window,
      frame: () => frame.current?.contentWindow ?? null,
      origin: surface.origin,
      context,
      handlers: {
        token: () =>
          api.call('createPluginSessionToken', {
            params: { installationId: surface.installationId },
          }),
        navigate: (to) => void navigate({ to }),
        toast: (text, tone) => (tone === 'error' ? toast.error(text) : toast(text)),
        offlineAccess: async (action) => {
          const params = { installationId: surface.installationId };
          if (action === 'status') return api.call('getPluginOfflineGrant', { params });
          if (action === 'revoke') {
            const out = await api.call('revokePluginOffline', { params });
            void qc.invalidateQueries({ queryKey: pluginKeys.notificationPrefs });
            return out;
          }
          const ok = await new Promise<boolean>((resolve) => setConsent(() => resolve));
          setConsent(null);
          if (!ok) return { granted: false };
          const out = await api.call('grantPluginOffline', { params });
          void qc.invalidateQueries({ queryKey: pluginKeys.notificationPrefs });
          return out;
        },
        resize:
          minH !== undefined && maxH !== undefined
            ? (h) => setHeight(Math.min(maxH, Math.max(minH, h)))
            : undefined,
      },
    });
    return () => {
      host.current?.detach();
      host.current = null;
    };
  }, [context, surface.origin, surface.installationId, navigate, minH, maxH, qc]);

  useEffect(() => {
    host.current?.setTheme({ scheme, accent: accentColour() });
  }, [scheme]);

  return (
    <>
      <iframe
        ref={frame}
        src={src}
        title={t('plugins.frame.title', { name })}
        sandbox={SANDBOX}
        referrerPolicy="no-referrer"
        // Only the browser features the admin granted, and only for the plugin's own origin.
        allow={frameAllow(surface.origin, surface.browser ?? [])}
        className={cn('block w-full border-0 bg-surface', className)}
        style={minH !== undefined ? { height: height ?? minH } : undefined}
      />
      <Dialog open={!!consent} onOpenChange={(open) => !open && consent?.(false)}>
        <DialogContent>
          <DialogHeader title={t('plugins.offline.title', { name })} />
          <p className="text-sm text-fg2">{t('plugins.offline.body', { name })}</p>
          <DialogFooter>
            <Button variant="out" onClick={() => consent?.(false)}>
              {t('plugins.offline.deny')}
            </Button>
            <Button onClick={() => consent?.(true)}>{t('plugins.offline.allow')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
