'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface TabMeta {
  value: string;
  label: string;
  default: boolean;
}

interface Props {
  groupId: string | null;
  tabs: TabMeta[];
  children: ReactNode[];
}

const STORAGE_PREFIX = 'docusaurus.tab.';
const SYNC_EVENT = 'portal:tab-group';

function readStored(groupId: string | null): string | null {
  if (!groupId) return null;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + groupId);
  } catch {
    return null;
  }
}

/** Docusaurus `<Tabs>`: Infima tabs, `groupId` synced through localStorage and between instances. */
export function Tabs({ groupId, tabs, children }: Props) {
  const initial = (tabs.find((t) => t.default) ?? tabs[0])?.value ?? '';
  const [selected, setSelected] = useState(initial);
  const refs = useRef<(HTMLLIElement | null)[]>([]);

  useEffect(() => {
    if (!groupId) return;
    const apply = (value: string | null) => {
      if (value && tabs.some((t) => t.value === value)) setSelected(value);
    };
    apply(readStored(groupId));
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ groupId: string; value: string }>).detail;
      if (detail.groupId === groupId) apply(detail.value);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_PREFIX + groupId) apply(e.newValue);
    };
    window.addEventListener(SYNC_EVENT, onSync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(SYNC_EVENT, onSync);
      window.removeEventListener('storage', onStorage);
    };
  }, [groupId, tabs]);

  const select = useCallback(
    (value: string) => {
      setSelected(value);
      if (!groupId) return;
      try {
        window.localStorage.setItem(STORAGE_PREFIX + groupId, value);
      } catch {
        // storage unavailable: the choice still applies to this page
      }
      window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { groupId, value } }));
    },
    [groupId],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (next === null) return;
    e.preventDefault();
    refs.current[next]?.focus();
  };

  return (
    <div className="tabs-container tabList__CuJ">
      <ul role="tablist" aria-orientation="horizontal" className="tabs">
        {tabs.map((tab, i) => {
          const active = tab.value === selected;
          return (
            <li
              key={tab.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className={`tabs__item tabItem_LNqP${active ? ' tabs__item--active' : ''}`}
              onClick={() => select(tab.value)}
              onFocus={() => select(tab.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
            >
              {tab.label}
            </li>
          );
        })}
      </ul>
      <div className="margin-top--md">
        {tabs.map((tab, i) => (
          <div
            key={tab.value}
            role="tabpanel"
            className="tabItem_Ymn6"
            hidden={tab.value !== selected}
          >
            {children[i]}
          </div>
        ))}
      </div>
    </div>
  );
}
