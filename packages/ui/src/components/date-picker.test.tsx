import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DatePicker,
  DateRangePicker,
  PickerLocaleProvider,
  TimePicker,
  type DateRange,
  type PickerLabels,
} from './date-picker';
import { Field } from './form';
import { Dialog, DialogContent, DialogTitle } from './overlay';

const LABELS: PickerLabels = {
  datePlaceholder: 'Tarih seç',
  rangePlaceholder: 'Aralık seç',
  timePlaceholder: '--:--',
  chooseDate: 'Tarih seç',
  chooseRange: 'Tarih aralığı seç',
  chooseTime: 'Saat seç',
  clear: 'Temizle',
  previousMonth: 'Önceki ay',
  nextMonth: 'Sonraki ay',
  previousYear: 'Önceki yıl',
  nextYear: 'Sonraki yıl',
  previousYears: 'Önceki yıllar',
  nextYears: 'Sonraki yıllar',
  chooseMonthYear: 'Ay ve yıl seç',
  chooseYear: 'Yıl seç',
  hours: 'Saat',
  minutes: 'Dakika',
  pickEnd: (from) => `Başlangıç ${from}, bitiş tarihini seç`,
  presets: {
    today: 'Bugün',
    yesterday: 'Dün',
    last7: 'Son 7 gün',
    last30: 'Son 30 gün',
    thisMonth: 'Bu ay',
    lastMonth: 'Geçen ay',
    custom: 'Özel',
  },
};

function Tr({ children }: { children: ReactNode }) {
  return (
    <PickerLocaleProvider locale="tr-TR" labels={LABELS}>
      {children}
    </PickerLocaleProvider>
  );
}

function Single({
  initial = null,
  onChange,
  min,
  max,
}: {
  initial?: string | null;
  onChange?: (v: string | null) => void;
  min?: string;
  max?: string;
}) {
  const [v, setV] = useState(initial);
  return (
    <Tr>
      <Field label="Bitiş">
        <DatePicker
          value={v}
          min={min}
          max={max}
          today="2026-10-18"
          onChange={(x) => {
            setV(x);
            onChange?.(x);
          }}
        />
      </Field>
    </Tr>
  );
}

const day = (name: RegExp) => screen.getByRole('button', { name });

function TimeHarness() {
  const [v, setV] = useState<string | null>('09:00');
  return (
    <Tr>
      <TimePicker aria-label="Saat" value={v} onChange={setV} />
    </Tr>
  );
}

describe('DatePicker', () => {
  it('picks a day and shows it in the Turkish format', async () => {
    const onChange = vi.fn();
    render(<Single onChange={onChange} />);
    const trigger = screen.getByLabelText('Bitiş');
    expect(trigger).toHaveTextContent('Tarih seç');
    await userEvent.click(trigger);
    const grid = screen.getByRole('grid');
    // Monday first, today ringed and focused.
    expect(within(grid).getAllByRole('columnheader')[0]).toHaveTextContent(/^Pzt/);
    expect(day(/^18 Ekim 2026/)).toHaveAttribute('aria-current', 'date');
    expect(day(/^18 Ekim 2026/)).toHaveFocus();
    await userEvent.click(day(/^20 Ekim 2026/));
    expect(onChange).toHaveBeenCalledWith('2026-10-20');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('20.10.2026');
    expect(trigger).toHaveAccessibleDescription('20.10.2026');
  });

  it('focuses the day when opened inside a dialog (focus trap)', async () => {
    const onChange = vi.fn();
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Yeni toplantı</DialogTitle>
          <Single initial="2026-10-18" onChange={onChange} />
          <TimeHarness />
        </DialogContent>
      </Dialog>,
    );
    await userEvent.click(screen.getByLabelText('Bitiş'));
    expect(day(/^18 Ekim 2026/)).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenCalledWith('2026-10-19');
    await userEvent.click(screen.getByRole('button', { name: 'Saat' }));
    expect(screen.getByRole('option', { name: '09' })).toHaveFocus();
  });

  it('clears the value', async () => {
    const onChange = vi.fn();
    render(<Single initial="2026-10-05" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Temizle' }));
    expect(onChange).toHaveBeenCalledWith(null);
    expect(screen.getByLabelText('Bitiş')).toHaveFocus();
  });

  it('moves with the keyboard and closes on Escape', async () => {
    const onChange = vi.fn();
    render(<Single initial="2026-10-18" onChange={onChange} />);
    const trigger = screen.getByLabelText('Bitiş');
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(day(/^18 Ekim 2026/)).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(day(/^19 Ekim 2026/)).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(day(/^26 Ekim 2026/)).toHaveFocus();
    await userEvent.keyboard('{PageDown}');
    expect(day(/^26 Kasım 2026/)).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(day(/^23 Kasım 2026 Pazartesi/)).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(day(/^29 Kasım 2026 Pazar/)).toHaveFocus();
    await userEvent.keyboard('{PageUp}{ArrowUp}');
    expect(day(/^22 Ekim 2026/)).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-22');
    expect(trigger).toHaveFocus();

    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('grid')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('disables days outside min and max', async () => {
    const onChange = vi.fn();
    render(<Single min="2026-10-10" max="2026-10-25" onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Bitiş'));
    expect(day(/^9 Ekim 2026/)).toHaveAttribute('aria-disabled', 'true');
    expect(day(/^26 Ekim 2026/)).toHaveAttribute('aria-disabled', 'true');
    expect(day(/^10 Ekim 2026/)).not.toHaveAttribute('aria-disabled');
    await userEvent.click(day(/^9 Ekim 2026/));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Önceki ay' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Sonraki ay' })).toBeDisabled();
    // The keyboard cannot leave the allowed range either.
    await userEvent.click(day(/^25 Ekim 2026/));
    expect(onChange).toHaveBeenLastCalledWith('2026-10-25');
    await userEvent.keyboard('{ArrowDown}{PageDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2026-10-25');
  });

  it('chooses month and year from the header', async () => {
    const onChange = vi.fn();
    render(<Single initial="2026-10-18" onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Bitiş'));
    await userEvent.click(screen.getByRole('button', { name: /Ay ve yıl seç/ }));
    await userEvent.click(screen.getByRole('button', { name: /Yıl seç/ }));
    await userEvent.click(screen.getByRole('button', { name: '2024' }));
    await userEvent.click(screen.getByRole('button', { name: /Mart 2024/i }));
    expect(day(/^18 Mart 2024/)).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('2024-03-18');
  });

  describe('time zones', () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });

    it.each(['Pacific/Kiritimati', 'America/Los_Angeles'])(
      'keeps the picked day in %s',
      async (tz) => {
        process.env.TZ = tz;
        const onChange = vi.fn();
        render(<Single initial="2026-03-29" onChange={onChange} />);
        expect(screen.getByLabelText('Bitiş')).toHaveTextContent('29.03.2026');
        await userEvent.click(screen.getByLabelText('Bitiş'));
        await userEvent.click(day(/^30 Mart 2026/));
        expect(onChange).toHaveBeenCalledWith('2026-03-30');
      },
    );
  });

  it('opens as a bottom sheet on narrow screens', async () => {
    const matchMedia = vi.fn((query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      render(<Single />);
      await userEvent.click(screen.getByLabelText('Bitiş'));
      const sheet = screen.getByRole('dialog', { name: 'Tarih seç' });
      expect(sheet).toHaveAttribute('data-picker-sheet');
      await userEvent.click(day(/^21 Ekim 2026/));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Bitiş')).toHaveTextContent('21.10.2026');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function Range({
  onChange,
  min,
  initial = null,
}: {
  onChange: (v: DateRange | null) => void;
  min?: string;
  initial?: DateRange | null;
}) {
  const [v, setV] = useState<DateRange | null>(initial);
  return (
    <Tr>
      <DateRangePicker
        aria-label="Dönem"
        value={v}
        min={min}
        today="2026-10-18"
        onChange={(x) => {
          setV(x);
          onChange(x);
        }}
      />
    </Tr>
  );
}

describe('DateRangePicker', () => {
  it('selects two days in either order', async () => {
    const onChange = vi.fn();
    render(<Range onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dönem' }));
    await userEvent.click(day(/^10 Ekim 2026/));
    expect(screen.getByRole('status')).toHaveTextContent('Başlangıç 10.10.2026');
    expect(onChange).not.toHaveBeenCalled();
    await userEvent.click(day(/^5 Ekim 2026/));
    expect(onChange).toHaveBeenCalledWith({ from: '2026-10-05', to: '2026-10-10' });
    expect(screen.getByRole('button', { name: 'Dönem' })).toHaveTextContent(
      '05.10.2026 – 10.10.2026',
    );
  });

  it('highlights the ends and the days between', async () => {
    render(<Range onChange={vi.fn()} initial={{ from: '2026-10-05', to: '2026-10-08' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dönem' }));
    const cell = (re: RegExp) => day(re).parentElement!;
    expect(day(/^5 Ekim 2026/)).toHaveClass('bg-accent');
    expect(day(/^8 Ekim 2026/)).toHaveClass('bg-accent');
    expect(cell(/^6 Ekim 2026/)).toHaveClass('bg-accent10');
    expect(cell(/^9 Ekim 2026/)).not.toHaveAttribute('aria-selected');
    expect(screen.getByRole('button', { name: 'Özel' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('applies presets and marks the active one', async () => {
    const onChange = vi.fn();
    render(<Range onChange={onChange} min="2026-10-01" />);
    await userEvent.click(screen.getByRole('button', { name: 'Dönem' }));
    expect(screen.getByRole('button', { name: 'Geçen ay' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Son 7 gün' }));
    expect(onChange).toHaveBeenCalledWith({ from: '2026-10-12', to: '2026-10-18' });
    await userEvent.click(screen.getByRole('button', { name: 'Dönem' }));
    expect(screen.getByRole('button', { name: 'Son 7 gün' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Özel' }));
    expect(screen.getByRole('button', { name: 'Özel' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.keyboard('{Enter}{ArrowRight}{ArrowRight}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-12', to: '2026-10-14' });
  });
});

describe('TimePicker', () => {
  function Time({ onChange }: { onChange: (v: string | null) => void }) {
    const [v, setV] = useState<string | null>('09:00');
    return (
      <Tr>
        <TimePicker
          aria-label="Saat"
          value={v}
          minuteStep={15}
          onChange={(x) => {
            setV(x);
            onChange(x);
          }}
        />
      </Tr>
    );
  }

  it('picks hour then minute', async () => {
    const onChange = vi.fn();
    render(<Time onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Saat' });
    expect(trigger).toHaveTextContent('09:00');
    await userEvent.click(trigger);
    const hours = screen.getByRole('listbox', { name: 'Saat' });
    expect(within(hours).getByRole('option', { name: '09' })).toHaveFocus();
    await userEvent.click(within(hours).getByRole('option', { name: '16' }));
    expect(onChange).toHaveBeenLastCalledWith('16:00');
    const minutes = screen.getByRole('listbox', { name: 'Dakika' });
    expect(within(minutes).getAllByRole('option')).toHaveLength(4);
    await userEvent.click(within(minutes).getByRole('option', { name: '30' }));
    expect(onChange).toHaveBeenLastCalledWith('16:30');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveTextContent('16:30');
  });

  it('works with the keyboard', async () => {
    const onChange = vi.fn();
    render(<Time onChange={onChange} />);
    screen.getByRole('button', { name: 'Saat' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('11:00');
    await act(async () => {
      await userEvent.keyboard('{ArrowRight}{ArrowDown}{Enter}');
    });
    expect(onChange).toHaveBeenLastCalledWith('11:15');
  });
});
