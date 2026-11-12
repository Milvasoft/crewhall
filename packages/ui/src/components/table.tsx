import { type HTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import { cn } from '../cn';

/** Kit `.tbl`: dense data table inside a `.wcard`. */
export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <table
      className={cn('w-full border-collapse text-[13.5px] leading-[18px]', className)}
      {...props}
    />
  );
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'border-b border-line px-3.5 py-2.5 text-left text-xs font-medium whitespace-nowrap text-fg2 first:pl-5 last:pr-5',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={cn(
        'border-b border-line px-3.5 py-[var(--row-pad)] align-middle whitespace-nowrap first:pl-5 last:pr-5 [tr:last-child>&]:border-b-0',
        className,
      )}
      {...props}
    />
  );
}

export function Tr({
  className,
  selected,
  ...props
}: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean }) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cn(selected && '[&>td]:bg-capsule', className)}
      {...props}
    />
  );
}
