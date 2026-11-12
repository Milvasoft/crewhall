import { Switch } from '@crewhall/ui';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsRow } from '@/components/admin/Settings';

describe('SettingsRow', () => {
  it('keeps the control on the right however long the description is', () => {
    const { container } = render(
      <SettingsRow
        label="Sohbetleri herkes için silme"
        description={'Grup sahibi ya da kurum yöneticisi sohbeti herkes için silebilir. '.repeat(6)}
      >
        <Switch aria-label="Sohbetleri herkes için silme" />
      </SettingsRow>,
    );
    const row = container.querySelector('[data-settings-row]')!;
    const text = container.querySelector('[data-settings-text]')!;
    const control = screen.getByRole('switch').closest('[data-settings-control]')!;
    // No wrapping on desktop: only phones (max-md) may drop the control below the text.
    expect(row.className.split(' ')).not.toContain('flex-wrap');
    expect(row.className).toContain('max-md:flex-wrap');
    expect(row.className).toContain('items-center');
    // The text column takes the room and wraps inside it; the control never shrinks.
    expect(text.className.split(' ')).toEqual(expect.arrayContaining(['flex-1', 'min-w-0']));
    expect(control.className.split(' ')).toContain('shrink-0');
    expect(control.className.split(' ')).not.toContain('flex-wrap');
  });
});
