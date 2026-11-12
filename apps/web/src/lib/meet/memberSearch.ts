import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { membersQuery } from '@/lib/queries';

const WAIT_MS = 250;

/**
 * Active members of the organisation matching what is typed, found by the server: an organisation
 * can be larger than one page of members. Nothing is asked for an empty search.
 */
export function useMemberSearch(term: string, enabled = true) {
  const q = term.trim();
  const [asked, setAsked] = useState(q);
  useEffect(() => {
    const id = window.setTimeout(() => setAsked(q), WAIT_MS);
    return () => window.clearTimeout(id);
  }, [q]);
  const found = useQuery({
    ...membersQuery({ status: 'active', q: asked }),
    enabled: enabled && Boolean(asked),
    staleTime: 60_000,
  });
  return (asked && q ? (found.data?.items ?? []) : []).map((m) => m.user);
}
