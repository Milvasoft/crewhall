import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The preset adds font sizes and colors with names tailwind-merge cannot guess;
// without this, `text-cap text-fg2` would be treated as two conflicting font sizes.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [
        'hero',
        'large',
        'title',
        'wtitle',
        'h',
        'sub',
        'num',
        'body',
        'btn',
        'nav',
        'cap',
        'tag',
        'micro',
      ],
      color: [
        'bg',
        'bg2',
        'surface',
        'line',
        'line2',
        'fg',
        'fg2',
        'fg3',
        'accent',
        'accent-fg',
        'accent-text',
        'accent10',
        'danger',
        'success',
        'warning',
        'info',
        'glass',
        'glass-line',
        'capsule',
        'scrim',
        'ch-dot',
        'graphite',
        's1',
        's2',
        's3',
        's4',
        's5',
        's6',
      ],
      radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'],
      shadow: ['sm', 'overlay', 'line', 'line2'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
