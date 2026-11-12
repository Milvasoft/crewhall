import { useEffect, useState } from 'react';

/**
 * True once `on` has stayed true for `ms`: a skeleton that only shows when loading really
 * takes a while (most mail reads come from the cache in a few tens of milliseconds, and a
 * skeleton flashing for that long reads as the page reloading).
 */
export function useDelayed(on: boolean, ms = 180): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setShown(true), ms);
    return () => {
      clearTimeout(timer);
      setShown(false);
    };
  }, [on, ms]);
  return on && shown;
}
