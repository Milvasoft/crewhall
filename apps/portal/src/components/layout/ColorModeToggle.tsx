'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore, type MouseEvent } from 'react';
import { THEME_STORAGE_KEY } from '@/components/layout/theme-script';

type Choice = 'system' | 'light' | 'dark';

interface Props {
  labels: { aria: string; light: string; dark: string; system: string };
  /** Hidden below 996px (navbar); the mobile drawer has its own toggle. */
  className?: string;
}

const darkQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)');

function readChoice(): Choice {
  const v = document.documentElement.getAttribute('data-theme-choice');
  return v === 'light' || v === 'dark' ? v : 'system';
}

function subscribeChoice(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme-choice'],
  });
  return () => observer.disconnect();
}

function resolve(choice: Choice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return darkQuery()?.matches ? 'dark' : 'light';
}

function apply(choice: Choice) {
  const d = document.documentElement;
  d.setAttribute('data-theme', resolve(choice));
  d.setAttribute('data-theme-choice', choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // private mode: the choice lasts for this page
  }
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/**
 * Docusaurus colour mode toggle (system → light → dark) with the old site's circular
 * view-transition reveal from the button.
 */
export function ColorModeToggle({ labels, className }: Props) {
  const choice = useSyncExternalStore(subscribeChoice, readChoice, () => null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Pages rendered on the client only (Next's 404 error shell) never ran the <head> script.
    if (!document.documentElement.hasAttribute('data-theme')) {
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      } catch {
        // storage unavailable
      }
      apply(stored === 'light' || stored === 'dark' ? stored : 'system');
    }
    const media = darkQuery();
    const onSystem = () => {
      if (readChoice() === 'system') apply('system');
    };
    media?.addEventListener('change', onSystem);
    return () => {
      media?.removeEventListener('change', onSystem);
    };
  }, []);

  const onClick = useCallback((e: MouseEvent) => {
    e.preventDefault();
    const current = readChoice();
    const next: Choice = current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system';
    const doc = document as ViewTransitionDocument;
    const rect = ref.current?.getBoundingClientRect();
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || !rect || reduce || resolve(next) === resolve(current)) {
      apply(next);
      return;
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const style = document.documentElement.style;
    style.setProperty('--theme-x', `${x}px`);
    style.setProperty('--theme-y', `${y}px`);
    style.setProperty('--theme-r', `${r}px`);
    doc.startViewTransition(() => apply(next));
  }, []);

  const mode = choice === 'light' ? labels.light : choice === 'dark' ? labels.dark : labels.system;
  return (
    <div ref={ref} className="theme-toggle-wrapper">
      <div className={`toggle_vylO${className ? ` ${className}` : ''}`}>
        <button
          className={`clean-btn toggleButton_gllP${choice === null ? ' toggleButtonDisabled_aARS' : ''}`}
          type="button"
          disabled={choice === null}
          title={mode}
          aria-label={labels.aria.replace('{mode}', mode)}
          aria-live="polite"
          onClick={onClick}
        >
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            aria-hidden="true"
            className="toggleIcon_g3eP lightToggleIcon_pyhR"
          >
            <path
              fill="currentColor"
              d="M12,9c1.65,0,3,1.35,3,3s-1.35,3-3,3s-3-1.35-3-3S10.35,9,12,9 M12,7c-2.76,0-5,2.24-5,5s2.24,5,5,5s5-2.24,5-5 S14.76,7,12,7L12,7z M2,13l2,0c0.55,0,1-0.45,1-1s-0.45-1-1-1l-2,0c-0.55,0-1,0.45-1,1S1.45,13,2,13z M20,13l2,0c0.55,0,1-0.45,1-1 s-0.45-1-1-1l-2,0c-0.55,0-1,0.45-1,1S19.45,13,20,13z M11,2v2c0,0.55,0.45,1,1,1s1-0.45,1-1V2c0-0.55-0.45-1-1-1S11,1.45,11,2z M11,20v2c0,0.55,0.45,1,1,1s1-0.45,1-1v-2c0-0.55-0.45-1-1-1C11.45,19,11,19.45,11,20z M5.99,4.58c-0.39-0.39-1.03-0.39-1.41,0 c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0s0.39-1.03,0-1.41L5.99,4.58z M18.36,16.95 c-0.39-0.39-1.03-0.39-1.41,0c-0.39,0.39-0.39,1.03,0,1.41l1.06,1.06c0.39,0.39,1.03,0.39,1.41,0c0.39-0.39,0.39-1.03,0-1.41 L18.36,16.95z M19.42,5.99c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06c-0.39,0.39-0.39,1.03,0,1.41 s1.03,0.39,1.41,0L19.42,5.99z M7.05,18.36c0.39-0.39,0.39-1.03,0-1.41c-0.39-0.39-1.03-0.39-1.41,0l-1.06,1.06 c-0.39,0.39-0.39,1.03,0,1.41s1.03,0.39,1.41,0L7.05,18.36z"
            />
          </svg>
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            aria-hidden="true"
            className="toggleIcon_g3eP darkToggleIcon_wfgR"
          >
            <path
              fill="currentColor"
              d="M9.37,5.51C9.19,6.15,9.1,6.82,9.1,7.5c0,4.08,3.32,7.4,7.4,7.4c0.68,0,1.35-0.09,1.99-0.27C17.45,17.19,14.93,19,12,19 c-3.86,0-7-3.14-7-7C5,9.07,6.81,6.55,9.37,5.51z M12,3c-4.97,0-9,4.03-9,9s4.03,9,9,9s9-4.03,9-9c0-0.46-0.04-0.92-0.1-1.36 c-0.98,1.37-2.58,2.26-4.4,2.26c-2.98,0-5.4-2.42-5.4-5.4c0-1.81,0.89-3.42,2.26-4.4C12.92,3.04,12.46,3,12,3L12,3z"
            />
          </svg>
          <svg
            viewBox="0 0 24 24"
            width="24"
            height="24"
            aria-hidden="true"
            className="toggleIcon_g3eP systemToggleIcon_QzmC"
          >
            <path
              fill="currentColor"
              d="m12 21c4.971 0 9-4.029 9-9s-4.029-9-9-9-9 4.029-9 9 4.029 9 9 9zm4.95-13.95c1.313 1.313 2.05 3.093 2.05 4.95s-0.738 3.637-2.05 4.95c-1.313 1.313-3.093 2.05-4.95 2.05v-14c1.857 0 3.637 0.737 4.95 2.05z"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
