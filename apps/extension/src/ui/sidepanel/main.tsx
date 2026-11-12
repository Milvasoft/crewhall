import type { AiAskResult, AiSearchHit } from '@crewhall/shared';
import { Button, Icon, Spinner, Textarea } from '@crewhall/ui';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../../shared/api';
import { errorText, locale, t } from '../../shared/i18n';
import { hitPath } from '../../shared/links';
import type { Connection } from '../../shared/storage';
import { Brand, mount, NeedsConnection, Notice, useConnection, useLoad } from '../shell';

interface Turn {
  question: string;
  answer: string;
  sources: AiSearchHit[];
}

function Sources({ hits, connection, slugs }: { hits: AiSearchHit[]; connection: Connection; slugs: Map<string, string> }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {hits.flatMap((hit) => {
        const path = hitPath(hit, (id) => slugs.get(id));
        if (!path) return [];
        return [
          <li key={`${hit.kind}:${hit.refId}`}>
            <a
              href={new URL(path, connection.origin).href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 text-xs font-semibold text-fg2 hover:text-fg"
            >
              <Icon name="ext" size={12} />
              <span className="truncate">{hit.title || hit.snippet}</span>
            </a>
          </li>,
        ];
      })}
    </ul>
  );
}

function Assistant({ connection }: { connection: Connection }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const info = useLoad(async () => {
    const client = await api();
    const [ai, spaces] = await Promise.all([client.call('getAiStatus'), client.call('listSpaces')]);
    return { ai, slugs: new Map(spaces.items.map((s) => [s.id, s.slug])) };
  }, []);
  const canAsk = info.data?.ai.available ?? false;
  const slugs = info.data?.slugs ?? new Map<string, string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setQuestion('');
    try {
      const client = await api();
      let turn: Turn;
      if (canAsk) {
        const result: AiAskResult = await client.call('askAi', {
          body: {
            question: text,
            history: turns.slice(-4).map((x) => ({ question: x.question, answer: x.answer.slice(0, 8000) })),
            locale: locale(),
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          },
        });
        turn = { question: text, answer: result.answer, sources: result.citations };
      } else {
        const hits = await client.call('searchContent', { query: { q: text, limit: 10 } });
        turn = {
          question: text,
          answer: hits.items.length ? '' : t('assistant.noResults'),
          sources: hits.items,
        };
      }
      setTurns((list) => [...list, turn]);
      requestAnimationFrame(() => end.current?.scrollIntoView({ behavior: 'smooth' }));
    } catch (err) {
      setError(errorText(err));
      setQuestion(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
        {!turns.length && !info.loading ? (
          <p className="m-auto max-w-64 text-center text-xs text-fg3">
            {canAsk ? t('assistant.empty') : t('assistant.searchOnly')}
          </p>
        ) : null}
        {turns.map((turn, i) => (
          <article key={i} className="flex flex-col gap-2">
            <p className="m-0 self-end rounded-lg bg-bg2 px-2.5 py-1.5 text-sm">{turn.question}</p>
            {turn.answer ? <p className="m-0 whitespace-pre-wrap text-sm">{turn.answer}</p> : null}
            <Sources hits={turn.sources} connection={connection} slugs={slugs} />
          </article>
        ))}
        {busy ? <Spinner /> : null}
        <div ref={end} />
      </div>
      <form className="flex flex-col gap-2 border-t border-line p-3" onSubmit={(e) => void submit(e)}>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Textarea
          rows={2}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={canAsk ? t('assistant.ask') : t('assistant.search')}
          aria-label={canAsk ? t('assistant.ask') : t('assistant.search')}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <Button variant="pri" type="submit" loading={busy} disabled={!question.trim()}>
          {canAsk ? t('assistant.send') : t('assistant.searchAction')}
        </Button>
      </form>
    </>
  );
}

function SidePanel() {
  const connection = useConnection();
  if (connection === undefined) return null;
  return (
    <div className="flex h-screen flex-col">
      <Brand />
      {connection ? <Assistant connection={connection} /> : <NeedsConnection />}
    </div>
  );
}

mount(<SidePanel />);
