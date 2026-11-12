import { TooltipProvider } from '@crewhall/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveMeetingBar } from '@/components/meet/openMeeting';
import { api } from '@/lib/api';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { markInRoomHere, useMeetingsOnOtherDevices } from '@/lib/meet/active';
import { createQueryClient } from '@/lib/queryClient';

const open = vi.fn();
const otherTab = vi.hoisted(() => ({ slug: null as string | null }));
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => open,
}));
vi.mock('../src/lib/identity/modules', () => ({ useModuleEnabled: () => true }));
vi.mock('../src/lib/session', () => ({ usePermissions: () => ({ role: 'member' }) }));
vi.mock('../src/lib/meet/window', async (orig) => ({
  ...(await orig<object>()),
  useMeetingElsewhere: () => (otherTab.slug ? { slug: otherTab.slug, title: '' } : null),
  isMeetingWindow: () => false,
  openMeetingWindow: (_slug: string, path: string) => {
    open(path);
    return 'opened';
  },
}));

const active = (slug: string) => ({
  meetingId: `id-${slug}`,
  slug,
  title: 'Haftalık',
  devices: 1,
  since: new Date().toISOString(),
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nProvider locale="tr">
      <QueryClientProvider client={createQueryClient()}>
        <TooltipProvider>{children}</TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  open.mockReset();
  otherTab.slug = null;
});

describe('being in a meeting on another device', () => {
  it('says so at the top, and joining means moving it here or adding this device', async () => {
    vi.spyOn(api, 'call').mockResolvedValue({ items: [active('haftalik')] } as never);
    render(<ActiveMeetingBar />, { wrapper: Wrapper });
    expect(await screen.findByText('Şu an bu toplantıdasın · Haftalık')).toBeInTheDocument();
    const u = userEvent.setup();
    await u.click(screen.getByRole('button', { name: 'Katıl' }));
    expect(screen.getByRole('menuitem', { name: 'Bu cihazı da ekle' })).toBeInTheDocument();
    await u.click(screen.getByRole('menuitem', { name: 'Bu cihaza aktar' }));
    expect(String(open.mock.calls[0]?.[0])).toContain('device=transfer');
  });

  it('shows nothing when not in a meeting', async () => {
    const spy = vi.spyOn(api, 'call').mockResolvedValue({ items: [] } as never);
    const { container } = render(<ActiveMeetingBar />, { wrapper: Wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('does not count this tab or another tab of this browser as another device', async () => {
    vi.spyOn(api, 'call').mockResolvedValue({
      items: [active('burada'), active('oteki-sekme'), active('telefon')],
    } as never);
    otherTab.slug = 'oteki-sekme';
    const leave = markInRoomHere('burada');
    const { result } = renderHook(() => useMeetingsOnOtherDevices(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.map((m) => m.slug)).toEqual(['telefon']));
    leave();
    await waitFor(() =>
      expect(result.current.map((m) => m.slug).sort()).toEqual(['burada', 'telefon']),
    );
  });
});
