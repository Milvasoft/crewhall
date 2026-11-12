'use client';

import { useRouter } from 'next/navigation';
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { highlightParts, searchSite, type SearchHit } from '@/components/search/search-client';

interface Props {
  locale: string;
  version: string | null;
  /** /search or /tr/search */
  searchPagePath: string;
  labels: { placeholder: string; seeAll: string; noResults: string };
}

const PageIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20">
    <path
      d="M17 6v12c0 .52-.2 1-1 1H4c-.7 0-1-.33-1-1V2c0-.55.42-1 1-1h8l5 5zM14 8h-3.13c-.51 0-.87-.34-.87-.87V4"
      stroke="currentColor"
      fill="none"
      fillRule="evenodd"
      strokeLinejoin="round"
    />
  </svg>
);
const HeadingIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20">
    <path
      d="M13 13h4-4V8H7v5h6v4-4H7V8H3h4V3v5h6V3v5h4-4v5zm-6 0v4-4H3h4z"
      stroke="currentColor"
      fill="none"
      fillRule="evenodd"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const ActionIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20">
    <g
      stroke="currentColor"
      fill="none"
      fillRule="evenodd"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M18 3v4c0 2-2 4-4 4H2" />
      <path d="M8 17l-6-6 6-6" />
    </g>
  </svg>
);
const NoResultsIcon = () => (
  <svg
    width="40"
    height="40"
    viewBox="0 0 20 20"
    fill="none"
    fillRule="evenodd"
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15.5 4.8c2 3 1.7 7-1 9.7h0l4.3 4.3-4.3-4.3a7.8 7.8 0 01-9.8 1m-2.2-2.2A7.8 7.8 0 0113.2 2.4M2 18L18 2" />
  </svg>
);

const noop = () => () => undefined;

const isEditable = (el: Element | null) =>
  !!el &&
  (el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el as HTMLElement).isContentEditable);

/**
 * Navbar search with the look and keyboard behaviour of @easyops-cn/docusaurus-search-local:
 * Ctrl/⌘ K and "/" focus it, the first hit is preselected, arrows move, Enter opens.
 * Results come from the Hub's portal search index through /api/search.
 */
export function SearchBar({ locale, version, searchPagePath, labels }: Props) {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const isMac = useSyncExternalStore(
    noop,
    () => /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent),
    () => false,
  );

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && k === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (
        k === '/' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isEditable(document.activeElement)
      ) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchSite({ q, locale, version, limit: 8 }, controller.signal)
        .then((items) => {
          setHits(items);
          setCursor(0);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 150);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, locale, version]);

  const allResultsHref = `${searchPagePath}?q=${encodeURIComponent(query.trim())}`;

  const open = useCallback(
    (href: string) => {
      setFocused(false);
      inputRef.current?.blur();
      router.push(href);
    },
    [router],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const count = hits?.length ?? 0;
    if (e.key === 'ArrowDown' && count) {
      e.preventDefault();
      setCursor((c) => (c + 1) % count);
    } else if (e.key === 'ArrowUp' && count) {
      e.preventDefault();
      setCursor((c) => (c - 1 + count) % count);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = hits?.[cursor];
      if (hit) open(hit.path);
      else if (query.trim()) open(allResultsHref);
    } else if (e.key === 'Escape') {
      if (query) setQuery('');
      else inputRef.current?.blur();
    }
  };

  const showMenu = focused && query.trim() !== '' && hits !== null;

  return (
    <div
      className={`navbar__search searchBarContainer_NW3z${loading ? ' searchIndexLoading_EJ1f' : ''}${focused ? ' focused_OWtg' : ''}`}
      dir="ltr"
    >
      <span
        className="searchBar_RVTs"
        style={{ position: 'relative', display: 'inline-block', direction: 'ltr' }}
      >
        <input
          ref={inputRef}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
          className="navbar__search-input"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showMenu}
          aria-controls={listId}
          aria-activedescendant={showMenu && hits?.length ? `${listId}-${cursor}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLoading(e.target.value.trim() !== '');
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => window.setTimeout(() => setFocused(false), 150)}
          onKeyDown={onKeyDown}
        />
        <span
          className="dropdownMenu_qbY6"
          role="listbox"
          id={listId}
          style={{
            position: 'absolute',
            top: '100%',
            zIndex: 100,
            display: showMenu ? 'block' : 'none',
          }}
        >
          {showMenu && (
            <div className="aa-dataset-1">
              {hits.length ? (
                <>
                  <span className="aa-suggestions" style={{ display: 'block' }}>
                    {hits.map((hit, i) => {
                      const heading = hit.path.includes('#');
                      return (
                        <div
                          key={`${hit.path}-${i}`}
                          id={`${listId}-${i}`}
                          role="option"
                          aria-selected={i === cursor}
                          className={`aa-suggestion suggestion_fB_2${i === cursor ? ' cursor_eG29' : ''}`}
                          onMouseEnter={() => setCursor(i)}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            open(hit.path);
                          }}
                        >
                          <span className="hitIcon_a7Zy">
                            {heading ? <HeadingIcon /> : <PageIcon />}
                          </span>
                          <span className="hitWrapper_sAK8">
                            <span className="hitTitle_vyVt">
                              {highlightParts(hit.title, query).map((p, j) =>
                                p.mark ? (
                                  <mark key={j}>{p.text}</mark>
                                ) : (
                                  <Fragment key={j}>{p.text}</Fragment>
                                ),
                              )}
                            </span>
                            {hit.section && <span className="hitPath_ieM4">{hit.section}</span>}
                          </span>
                          <span className="hitAction_NqkB">
                            <ActionIcon />
                          </span>
                        </div>
                      );
                    })}
                  </span>
                  <div className="hitFooter_E9YW">
                    <a
                      href={allResultsHref}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        open(allResultsHref);
                      }}
                    >
                      {labels.seeAll}
                    </a>
                  </div>
                </>
              ) : (
                <span className="noResults_l6Q3">
                  <span className="noResultsIcon_EBY5">
                    <NoResultsIcon />
                  </span>
                  <span>{labels.noResults}</span>
                </span>
              )}
            </div>
          )}
        </span>
      </span>
      <div className="loadingRing_RJI3 searchBarLoadingRing_YnHq">
        <div />
        <div />
        <div />
        <div />
      </div>
      {!focused && !query && (
        <div className="searchHintContainer_Pkmr">
          <kbd className="searchHint_iIMx">{isMac ? '⌘' : 'ctrl'}</kbd>
          <kbd className="searchHint_iIMx">K</kbd>
        </div>
      )}
    </div>
  );
}
