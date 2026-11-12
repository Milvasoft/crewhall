// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/components/ui/Button.tsx. See THIRD_PARTY.md.
// Crewhall: the same props, drawn with the Crewhall Button (packages/ui).
import { Button as UiButton } from '@crewhall/ui';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANTS = { primary: 'pri', secondary: 'out', ghost: 'gh' } as const;
const SIZES = { sm: 'xs', md: 'sm' } as const;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', type = 'button', ...props },
  ref,
) {
  return (
    <UiButton ref={ref} type={type} variant={VARIANTS[variant]} size={SIZES[size]} {...props} />
  );
});
