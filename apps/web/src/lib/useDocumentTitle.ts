import { useEffect } from 'react';

/**
 * Sets the tab title while the calling screen is mounted and puts the previous one (the org
 * title from BrandingSync) back when it leaves. `undefined` leaves the title alone.
 */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
