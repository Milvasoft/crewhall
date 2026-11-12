import { type SVGProps } from 'react';
import { cn } from '../cn';
import { ICON_PATHS, type IconName } from './paths';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** Pixel size; kit sizes are 12, 14, 16, 18, 20 (default), 24, 32, 40. */
  size?: number;
  strokeWidth?: number;
}

/** Kit line icon (24x24, stroke 1.8, currentColor). Decorative unless `aria-label` is given. */
export function Icon({ name, size = 20, strokeWidth = 1.8, className, ...rest }: IconProps) {
  const labelled = rest['aria-label'] !== undefined;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      focusable="false"
      className={cn('shrink-0', className)}
      // Static, generated markup from the design kit (no user input).
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
      {...rest}
    />
  );
}

/** Crewhall product mark ("Halka"). The ring takes currentColor, the dot uses --chDot. */
export function CrewhallMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      className={cn('shrink-0', className)}
    >
      <path
        fill="currentColor"
        d="M26.17 28.13A14.219 14.219 0 0 1 21.514 29.948A2.718 2.718 0 0 1 20.457 24.615A8.783 8.783 0 0 0 23.333 23.492A2.718 2.718 0 0 1 26.17 28.13ZM12.919 28.969A14.219 14.219 0 0 1 8.791 26.149A2.718 2.718 0 0 1 12.598 22.269A8.783 8.783 0 0 0 15.148 24.01A2.718 2.718 0 0 1 12.919 28.969ZM4.751 18.499A14.219 14.219 0 0 1 4.751 13.501A2.718 2.718 0 0 1 10.104 14.456A8.783 8.783 0 0 0 10.104 17.544A2.718 2.718 0 0 1 4.751 18.499ZM8.791 5.851A14.219 14.219 0 0 1 12.919 3.031A2.718 2.718 0 0 1 15.148 7.99A8.783 8.783 0 0 0 12.598 9.731A2.718 2.718 0 0 1 8.791 5.851ZM21.514 2.052A14.219 14.219 0 0 1 26.17 3.87A2.718 2.718 0 0 1 23.333 8.508A8.783 8.783 0 0 0 20.457 7.385A2.718 2.718 0 0 1 21.514 2.052Z"
      />
      <path
        fill="var(--chDot,#118478)"
        d="M14.149 16a4.6 4.6 0 1 0 9.201 0a4.6 4.6 0 1 0 -9.201 0Z"
      />
    </svg>
  );
}

export { ICON_PATHS, type IconName };
