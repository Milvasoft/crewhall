import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { cn } from '../cn';
import { Button } from './button';
import { initials, Skeleton } from './display';
import { Field, Input } from './form';
import { OtpInput } from './otp';

describe('cn', () => {
  it('keeps custom font size and color together', () => {
    expect(cn('text-cap text-fg2')).toBe('text-cap text-fg2');
    expect(cn('text-fg2', 'text-fg')).toBe('text-fg');
    expect(cn('text-cap', 'text-sm')).toBe('text-sm');
  });
});

describe('initials', () => {
  it('uses Turkish casing', () => {
    expect(initials('ilker şahin')).toBe('İŞ');
    expect(initials('Ahmet Buğra Kösen')).toBe('AK');
  });

  it('skips leading punctuation', () => {
    expect(initials('MLV-7 SSO ile giriş (OIDC)')).toBe('MO');
    expect(initials('"Proje" ekibi')).toBe('PE');
    expect(initials('#genel')).toBe('G');
    expect(initials('(?)')).toBe('(');
  });
});

describe('Field + Input', () => {
  it('links the label and shows the error', () => {
    render(
      <Field label="E-posta" error="Geçerli bir e-posta adresi gir">
        <Input defaultValue="x" />
      </Field>,
    );
    const input = screen.getByLabelText('E-posta');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Geçerli bir e-posta adresi gir');
  });
});

describe('Button', () => {
  it('is disabled while loading', () => {
    render(<Button loading>Kaydet</Button>);
    expect(screen.getByRole('button', { name: 'Kaydet' })).toBeDisabled();
  });
});

describe('OtpInput', () => {
  function Harness({ onComplete }: { onComplete: (v: string) => void }) {
    const [v, setV] = useState('');
    return <OtpInput aria-label="Kod" value={v} onChange={setV} onComplete={onComplete} />;
  }

  it('accepts pasted digits and completes once', async () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    const input = screen.getByLabelText('Kod');
    await userEvent.click(input);
    await userEvent.paste('48 29-13');
    expect(input).toHaveValue('482913');
    expect(onComplete).toHaveBeenCalledWith('482913');
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});

describe('Skeleton', () => {
  it('uses the delayed skeleton animation so quick loads never flash it', () => {
    const { container } = render(<Skeleton className="w-10" />);
    expect(container.firstElementChild).toHaveClass('skeleton', 'w-10');
  });
});
