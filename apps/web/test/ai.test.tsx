import { markdownToDoc } from '@crewhall/editor';
import { http, HttpResponse } from 'msw';
import {
  AssistHighlight,
  editorLabelKeys,
  RichEditor,
  type EditorLabels,
  type RichEditorHandle,
} from '@crewhall/editor/react';
import { AI_RAW_PATHS, type AiCitation, type MeetingRecording } from '@crewhall/shared';
import { TooltipProvider } from '@crewhall/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { Editor } from '@tiptap/core';
import { fireEvent, act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { ChatUnreadSummary } from '@/components/ai/ChatUnreadSummary';
import { MeetingAssistant } from '@/components/ai/MeetingAssistant';
import { useEditorAssist } from '@/components/ai/EditorAssist';
import { sseData } from '@/lib/ai/stream';
import { I18nProvider } from '@/lib/i18n/I18nContext';
import { createQueryClient } from '@/lib/queryClient';
import { closeAsk, openAsk } from '@/lib/ai/ask';
import {
  askDraft,
  bindConversation,
  keepAskDraft,
  KEPT_TURNS,
  resetConversationStore,
  updateConversation,
} from '@/lib/ai/conversation';
import { aiMockState, MOCK_DICTATION, resetAiMock } from '@/mocks/ai';
import { db } from '@/mocks/db';
import { mcpMockState } from '@/mocks/mcp';
import { ORG_ID, USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { server } from './support/server';
import { signedInAs } from './support/session';

/** AI writing help (yol haritası #5) against the contract mock: admin, editor, chat. */

function withProviders(node: ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <I18nProvider locale="tr">
        <TooltipProvider>{node}</TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const labels = Object.fromEntries(editorLabelKeys.map((k) => [k, k])) as unknown as EditorLabels;

let editorOut: Editor | null = null;

function EditorHarness({ md }: { md: string }) {
  const ref = useRef<RichEditorHandle>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    const e = ref.current!.getEditor();
    editorOut = e;
    setEditor(e);
  }, []);
  const assist = useEditorAssist({ editor, editable: true, source: { kind: 'draft' } });
  return (
    <>
      <RichEditor
        value={markdownToDoc(md).doc}
        labels={labels}
        editorRef={ref}
        extensions={[AssistHighlight]}
      />
      {assist.button}
      {assist.panel}
    </>
  );
}

const text = () => editorOut!.state.doc.textContent;

const layout = {
  rangeRect: Range.prototype.getBoundingClientRect,
  rangeRects: Range.prototype.getClientRects,
  elRects: Element.prototype.getClientRects,
};
const noRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;

beforeAll(() => {
  // jsdom has no layout; the editor and the panel position ask for rectangles.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = noRects;
  Element.prototype.getClientRects = noRects;
  Object.defineProperty(Text.prototype, 'getClientRects', { value: noRects, configurable: true });
});
afterAll(() => {
  Range.prototype.getBoundingClientRect = layout.rangeRect;
  Range.prototype.getClientRects = layout.rangeRects;
  Element.prototype.getClientRects = layout.elRects;
  Reflect.deleteProperty(Text.prototype, 'getClientRects');
});

beforeEach(() => {
  resetAiMock();
  signedInAs(USER.bugra);
});

describe('editor writing help', () => {
  it('previews a rewrite, replaces the selection on accept and undoes in one step', async () => {
    const user = userEvent.setup();
    withProviders(<EditorHarness md="toplantı perşembeye kaldı" />);
    const button = await screen.findByRole('button', { name: 'Yapay zekâ ile' });
    act(() => {
      editorOut!.commands.setTextSelection({ from: 1, to: 26 });
    });
    await user.click(button);
    await user.click(await screen.findByRole('button', { name: 'Yeniden yaz' }));
    await user.click(screen.getByRole('button', { name: 'Resmî' }));
    await screen.findByText('Toplantı perşembeye kaldı', {}, { timeout: 5000 });
    await user.click(await screen.findByRole('button', { name: /Değiştir/ }));

    expect(text()).toBe('Toplantı perşembeye kaldı');
    await waitFor(() => expect(aiMockState().runs[0]?.accepted).toBe(true));
    expect(screen.queryByRole('dialog', { name: 'Yapay zekâ ile' })).toBeNull();
    act(() => {
      editorOut!.commands.undo();
    });
    expect(text()).toBe('toplantı perşembeye kaldı');
  });

  it('discards a summary without touching the text', async () => {
    const user = userEvent.setup();
    withProviders(<EditorHarness md="Uzun bir paragraf. İkinci cümle." />);
    const button = await screen.findByRole('button', { name: 'Yapay zekâ ile' });
    act(() => {
      editorOut!.commands.setTextSelection({ from: 1, to: 33 });
    });
    await user.click(button);
    await user.click(await screen.findByRole('button', { name: 'Özetle' }));
    await screen.findByText(/Özet: Uzun bir paragraf\./, {}, { timeout: 5000 });
    expect(screen.getByRole('button', { name: /Altına ekle/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(text()).toBe('Uzun bir paragraf. İkinci cümle.');
    expect(aiMockState().runs[0]?.accepted).toBe(false);
  });

  it('hides the button when the admin turned AI off', async () => {
    aiMockState().settings = { ...aiMockState().settings, enabled: false };
    withProviders(<EditorHarness md="metin" />);
    await waitFor(() => expect(editorOut).not.toBeNull());
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('button', { name: 'Yapay zekâ ile' })).toBeNull();
  });
});

describe('chat unread summary', () => {
  it('streams the summary of the unread messages', async () => {
    const user = userEvent.setup();
    withProviders(
      <ChatUnreadSummary
        conversationId="0192f3a4-1b2c-7d3e-8f40-123456789abc"
        afterSeq={4}
        unread={5}
      />,
    );
    await user.click(await screen.findByRole('button', { name: /5 okunmamış mesajı özetle/ }));
    expect(
      await screen.findByText(/Senden test raporu bekleniyor/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/Yalnız senin görebildiğin mesajlar/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('is not offered for a couple of messages', async () => {
    withProviders(
      <ChatUnreadSummary
        conversationId="0192f3a4-1b2c-7d3e-8f40-123456789abc"
        afterSeq={4}
        unread={2}
      />,
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('button', { name: /özetle/ })).toBeNull();
  });
});

describe('Yönetim › Yapay zekâ', () => {
  it('switches to an own server, tests it and saves; the old key is dropped', async () => {
    const user = userEvent.setup();
    renderApp('/admin/ai');
    expect(await screen.findByRole('heading', { name: 'Yapay zekâ' })).toBeInTheDocument();
    expect(await screen.findByPlaceholderText('Kayıtlı anahtar ••••demo')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Sağlayıcı' }));
    await user.click(await screen.findByRole('option', { name: 'Kendi sunucun (OpenAI uyumlu)' }));
    await user.type(screen.getByLabelText('Sunucu adresi'), 'http://llm.local:8000/v1');
    await user.clear(screen.getByLabelText('Model'));
    await user.type(screen.getByLabelText('Model'), 'llama-3.3');
    expect(screen.getByText(/kayıtlı anahtar silinir/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Bağlantıyı test et/ }));
    expect(await screen.findByText(/Bağlantı çalışıyor/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(aiMockState().settings).toMatchObject({
        provider: 'openai_compatible',
        baseUrl: 'http://llm.local:8000/v1',
        model: 'llama-3.3',
        apiKey: { set: false },
      }),
    );
  });

  it('fills the defaults of a hosted provider and asks for its key', async () => {
    const user = userEvent.setup();
    renderApp('/admin/ai');
    await user.click(await screen.findByRole('combobox', { name: 'Sağlayıcı' }));
    await user.click(await screen.findByRole('option', { name: 'ChatGPT (OpenAI)' }));
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-5-mini');
    expect(screen.getByText(/Önerilen modeller: gpt-5/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Gömme \(embedding\) modeli/)).toHaveValue(
      'text-embedding-3-small',
    );
    expect(screen.getByLabelText('Ağ geçidi adresi (isteğe bağlı)')).toHaveAttribute(
      'placeholder',
      'https://api.openai.com/v1',
    );
    await user.type(screen.getByLabelText('API anahtarı'), 'sk-proj-0123456789');
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(aiMockState().settings).toMatchObject({
        provider: 'openai',
        model: 'gpt-5-mini',
        embeddingModel: 'text-embedding-3-small',
        apiKey: { set: true },
        configured: true,
      }),
    );
  });

  it('asks Azure for the resource, the deployment and the api-version', async () => {
    const user = userEvent.setup();
    renderApp('/admin/ai');
    await user.click(await screen.findByRole('combobox', { name: 'Sağlayıcı' }));
    await user.click(await screen.findByRole('option', { name: 'Azure OpenAI' }));
    await user.type(screen.getByLabelText('Kaynak adresi'), 'https://kurum.openai.azure.com');
    await user.clear(screen.getByLabelText('Dağıtım (deployment) adı'));
    await user.type(screen.getByLabelText('Dağıtım (deployment) adı'), 'gpt4o-prod');
    expect(screen.getByLabelText('API sürümü')).toHaveAttribute('placeholder', '2024-10-21');
    await user.type(screen.getByLabelText('API anahtarı'), 'azure-0123456789');
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() =>
      expect(aiMockState().settings).toMatchObject({
        provider: 'azure_openai',
        baseUrl: 'https://kurum.openai.azure.com',
        model: 'gpt4o-prod',
        apiVersion: null,
        configured: true,
      }),
    );
  });

  it('sets monthly quotas', async () => {
    const user = userEvent.setup();
    renderApp('/admin/ai');
    const perPerson = await screen.findByLabelText('Kişi başına');
    await user.clear(perPerson);
    await user.type(perPerson, '50000');
    await user.click(screen.getByRole('button', { name: 'Kaydet' }));
    await waitFor(() => expect(aiMockState().settings.userMonthlyTokens).toBe(50_000));
  });
});

describe('stream parsing', () => {
  it('reads events split across chunks', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of ['data: {"type":"del', 'ta","text":"a"}\n', '\ndata: x\n\n']) {
          c.enqueue(enc.encode(p));
        }
        c.close();
      },
    });
    const out: string[] = [];
    for await (const d of sseData(body)) out.push(d);
    expect(out).toEqual(['{"type":"delta","text":"a"}', 'x']);
  });
});

describe("Crewhall'a sor", () => {
  it('opens from Ctrl K with the typed question and answers with sources', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('button', { name: "Crewhall'a sor" });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'sunucu envanteri nerede');
    await user.click(
      await screen.findByRole('option', { name: /Crewhall'a sor: sunucu envanteri nerede/ }),
    );
    const panel = await screen.findByRole('dialog', { name: "Crewhall'a sor" });
    expect(
      await within(panel).findByText(/Bulduğum içeriğe göre/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(within(panel).getByText('Kaynaklar')).toBeInTheDocument();
    expect(within(panel).getAllByRole('link').length).toBeGreaterThan(0);
  });

  it('shows the search index on the admin screen', async () => {
    renderApp('/admin/ai');
    expect(await screen.findByText('Arama dizini')).toBeInTheDocument();
    expect(await screen.findByText('Kapalı (tam metin)')).toBeInTheDocument();
  });
});

describe('meeting assistant', () => {
  const recording: MeetingRecording = {
    id: '0192f3a4-1b2c-7d3e-8f40-0000000000a1',
    meetingId: '0192f3a4-1b2c-7d3e-8f40-0000000000a2',
    sessionId: null,
    status: 'ready',
    audioOnly: true,
    startedBy: null,
    startedAt: '2026-10-22T09:00:00.000Z',
    endedAt: '2026-10-22T10:00:00.000Z',
    durationSeconds: 3600,
    sizeBytes: 1000,
    nodeId: '0192f3a4-1b2c-7d3e-8f40-0000000000a3',
    spaceId: '0192f3a4-1b2c-7d3e-8f40-0000000000a4',
    fileName: 'kayit.m4a',
    expiresAt: null,
    error: null,
  };

  function renderAssistant() {
    const root = createRootRoute({ component: () => <MeetingAssistant recording={recording} /> });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    return withProviders(<RouterProvider router={router} />);
  }

  it('transcribes on request and shows decisions and action items', async () => {
    const user = userEvent.setup();
    renderAssistant();
    await user.click(await screen.findByRole('button', { name: 'Dökümü ve özeti çıkar' }));
    expect(await screen.findByText('Sürüm cuma 17:00de çıkacak')).toBeInTheDocument();
    expect(screen.getByText('Test raporunu hazırla')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Panoya kart aç/ })).toHaveLength(2);
  });

  it('stays hidden without a speech server', async () => {
    aiMockState().settings = { ...aiMockState().settings, transcriptionUrl: null };
    renderAssistant();
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('region', { name: 'Toplantı asistanı' })).toBeNull();
  });
});

describe('action assistant', () => {
  it('prepares a proposal for the approval queue in "Yap" mode', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('button', { name: "Crewhall'a sor" });
    act(() => openAsk());
    const panel = await screen.findByRole('dialog', { name: "Crewhall'a sor" });
    await user.click(within(panel).getByRole('radio', { name: 'Yap' }));
    await user.type(within(panel).getByRole('textbox'), 'Sürüm notlarını yaz diye kart aç{Enter}');
    expect(
      await within(panel).findByText('Hazırladığım işlem onayını bekliyor.'),
    ).toBeInTheDocument();
    const review = within(panel).getByRole('link', { name: 'Gözden geçir' });
    const approval = mcpMockState().approvals[0]!;
    expect(approval).toMatchObject({ action: 'ai.action', status: 'pending' });
    expect(review.getAttribute('href')).toBe(`/account/approvals/${approval.id}`);
    expect(within(panel).getByText('Onaylayana kadar hiçbir şey değişmez.')).toBeInTheDocument();
  });

  async function proposalPanel() {
    const user = userEvent.setup();
    const app = renderApp('/');
    await screen.findByRole('button', { name: "Crewhall'a sor" });
    act(() => openAsk());
    const panel = await screen.findByRole('dialog', { name: "Crewhall'a sor" });
    await user.click(within(panel).getByRole('radio', { name: 'Yap' }));
    await user.type(within(panel).getByRole('textbox'), 'Sürüm notlarını yaz diye kart aç{Enter}');
    await within(panel).findByRole('button', { name: 'Onayla' });
    return { user, panel, app, approval: mcpMockState().approvals[0]! };
  }

  it('approves from the card and links to what it created', async () => {
    mcpMockState().verifiedAt = Date.now();
    const { user, panel, approval } = await proposalPanel();
    // What the worker would report once applied (the mock applies at once).
    approval.result = { board_id: 'b1', number: 7 };
    await user.click(within(panel).getByRole('button', { name: 'Onayla' }));
    const outcome = await within(panel).findByRole('status');
    expect(outcome).toHaveTextContent('Kart açıldı');
    expect(within(outcome).getByRole('link', { name: 'Aç' })).toHaveAttribute('href', '/b/b1/7');
    expect(mcpMockState().approvals[0]!.status).toBe('applied');
    // The buttons are gone; keyboard focus stays on the outcome.
    expect(within(panel).queryByRole('button', { name: 'Onayla' })).toBeNull();
    expect(outcome).toHaveFocus();
  });

  it('sends the conversation along and takes "evet" as pressing the card\'s button', async () => {
    mcpMockState().verifiedAt = Date.now();
    const { user, panel } = await proposalPanel();
    await user.type(within(panel).getByRole('textbox'), 'evet{Enter}');
    expect(await within(panel).findByText('Onayını aldım, uyguluyorum.')).toBeInTheDocument();
    await waitFor(() => expect(mcpMockState().approvals[0]!.status).toBe('applied'));
    expect(await within(panel).findByRole('status')).toHaveTextContent('Kart açıldı');
  });

  it('still asks for the check behind "evet", and stops when it is closed', async () => {
    mcpMockState().verifiedAt = 0;
    const { user, panel } = await proposalPanel();
    await user.type(within(panel).getByRole('textbox'), 'evet{Enter}');
    const check = await screen.findByRole('dialog', { name: 'Kimliğini doğrula' });
    expect(mcpMockState().approvals[0]!.status).toBe('pending');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(check).not.toBeInTheDocument());
    expect(mcpMockState().approvals[0]!.status).toBe('pending');
  });

  it('its own dialog keeps the panel open, against a press and against Esc', async () => {
    mcpMockState().verifiedAt = 0;
    const { user, panel } = await proposalPanel();
    await user.type(within(panel).getByRole('textbox'), 'evet{Enter}');
    const check = await screen.findByRole('dialog', { name: 'Kimliğini doğrula' });
    fireEvent.pointerDown(check);
    expect(panel).toBeInTheDocument();
    expect(check).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(check).not.toBeInTheDocument());
    expect(panel).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(panel).not.toBeInTheDocument());
  });

  it('approves a plan of several steps at once', async () => {
    mcpMockState().verifiedAt = Date.now();
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('button', { name: "Crewhall'a sor" });
    act(() => openAsk());
    const panel = await screen.findByRole('dialog', { name: "Crewhall'a sor" });
    await user.click(within(panel).getByRole('radio', { name: 'Yap' }));
    await user.type(within(panel).getByRole('textbox'), 'Bir kart aç ve iki kart aç{Enter}');
    await user.click(await within(panel).findByRole('button', { name: 'Hepsini onayla' }));
    await waitFor(() =>
      expect(
        mcpMockState()
          .approvals.slice(0, 2)
          .map((x) => x.status),
      ).toEqual(['applied', 'applied']),
    );
    await waitFor(() =>
      expect(within(panel).queryByRole('button', { name: 'Hepsini onayla' })).toBeNull(),
    );
  });

  it('rejects from the card with the keyboard', async () => {
    const { user, panel } = await proposalPanel();
    within(panel).getByRole('button', { name: 'Reddet' }).focus();
    await user.keyboard('{Enter}');
    expect(await within(panel).findByRole('status')).toHaveTextContent('Reddedildi');
    expect(mcpMockState().approvals[0]!.status).toBe('rejected');
  });

  it('asks for a passkey or password before approving when the last check is old', async () => {
    const { user, panel } = await proposalPanel();
    await user.click(within(panel).getByRole('button', { name: 'Onayla' }));
    expect(await screen.findByRole('dialog', { name: 'Kimliğini doğrula' })).toBeInTheDocument();
    expect(mcpMockState().approvals[0]!.status).toBe('pending');
  });

  it('rolls back when the approval was closed meanwhile', async () => {
    mcpMockState().verifiedAt = Date.now();
    const { user, panel, approval } = await proposalPanel();
    approval.status = 'expired';
    await user.click(within(panel).getByRole('button', { name: 'Onayla' }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('Süresi doldu');
    expect(approval.status).toBe('expired');
  });

  it('follows a decision taken on the approvals page', async () => {
    const { panel, app, approval } = await proposalPanel();
    approval.status = 'rejected';
    // What the approvals page does after a decision.
    await act(() => app.queryClient.invalidateQueries({ queryKey: ['mcp'] }));
    expect(await within(panel).findByRole('status')).toHaveTextContent('Reddedildi');
  });
});

describe('setup help', () => {
  const notConfigured = (enabled: boolean) => {
    aiMockState().settings = {
      ...aiMockState().settings,
      enabled,
      configured: false,
      apiKey: { set: false, hint: null, updatedAt: null },
      lastTest: null,
    };
  };

  function inRouter(node: ReactNode) {
    const root = createRootRoute({ component: () => <>{node}</> });
    const router = createRouter({
      routeTree: root,
      history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    return withProviders(<RouterProvider router={router} />);
  }

  it('saves the switch at once, without the save button', async () => {
    aiMockState().settings = { ...aiMockState().settings, enabled: false };
    const user = userEvent.setup();
    renderApp('/admin/ai');
    const on = await screen.findByRole('switch', { name: 'Yapay zekâ yardımı' });
    expect(screen.queryByRole('region', { name: /Kaydedilmemiş/ })).toBeNull();
    await user.click(on);
    await waitFor(() => expect(aiMockState().settings.enabled).toBe(true));
    expect(on).toBeChecked();
    expect(screen.queryByRole('region', { name: /Kaydedilmemiş/ })).toBeNull();
  });

  it('collects the other fields in a save bar', async () => {
    const user = userEvent.setup();
    renderApp('/admin/ai');
    await user.type(await screen.findByLabelText('Kişi başına'), '9');
    const bar = await screen.findByRole('region', { name: /Kaydedilmemiş/ });
    await user.click(within(bar).getByRole('button', { name: 'Vazgeç' }));
    expect(screen.queryByRole('region', { name: /Kaydedilmemiş/ })).toBeNull();
    expect(aiMockState().settings.userMonthlyTokens).toBe(200_000);
  });

  it('warns when AI is on but has no working provider, with the steps to set it up', async () => {
    notConfigured(true);
    renderApp('/admin/ai');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Açık ama çalışmıyor/);
    expect(screen.getByText('Kurulum adımları')).toBeInTheDocument();
    expect(screen.getByText('API anahtarını gir ve kaydet').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
  });

  it('offers to turn AI on once the test passes and saves the key with it', async () => {
    notConfigured(false);
    const user = userEvent.setup();
    renderApp('/admin/ai');
    await user.type(await screen.findByLabelText('API anahtarı'), 'sk-ant-0123456789');
    await user.click(screen.getByRole('button', { name: 'Bağlantıyı test et' }));
    await user.click(await screen.findByRole('button', { name: 'Kaydet ve aç' }));
    await waitFor(() =>
      expect(aiMockState().settings).toMatchObject({
        enabled: true,
        configured: true,
        apiKey: { set: true },
      }),
    );
  });

  it('points admins to the settings in the editor, chat and Ctrl K', async () => {
    notConfigured(true);
    inRouter(
      <>
        <EditorHarness md="metin" />
        <ChatUnreadSummary conversationId="c1" afterSeq={0} unread={12} />
      </>,
    );
    expect(await screen.findByRole('link', { name: /Ayarlanmadı/ })).toHaveAttribute(
      'href',
      '/admin/ai',
    );
    expect(screen.getByRole('link', { name: /Yapay zekâ ayarlanmadı/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yapay zekâ ile' })).toBeNull();
  });

  it('offers the settings from Ctrl K to admins', async () => {
    notConfigured(true);
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('button', { name: /Yapay zekâ ayarlanmadı/ });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'sunucu envanteri nerede');
    await user.click(await screen.findByRole('option', { name: /Yapay zekâ ayarlanmadı/ }));
    expect(await screen.findByRole('heading', { name: 'Yapay zekâ' })).toBeInTheDocument();
  });

  it('shows members nothing while AI is not set up', async () => {
    notConfigured(true);
    const sessions = db().sessions;
    sessions.splice(0, sessions.length);
    signedInAs(USER.mert);
    inRouter(<EditorHarness md="metin" />);
    await waitFor(() => expect(editorOut).not.toBeNull());
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByRole('link', { name: /Ayarlanmadı/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Yapay zekâ ile' })).toBeNull();
  });
});

describe('kept conversation', () => {
  const storageKey = `crewhall.ask.${ORG_ID}.${USER.bugra}`;

  async function openPanel() {
    await screen.findByRole('button', { name: "Crewhall'a sor" });
    act(() => openAsk());
    return screen.findByRole('dialog', { name: "Crewhall'a sor" });
  }

  it('closes on a press outside, and comes back with the draft and the running answer', async () => {
    const user = userEvent.setup();
    renderApp('/');
    let panel = await openPanel();
    await user.type(within(panel).getByRole('textbox'), 'sunucu envanteri nerede{Enter}');
    await user.type(within(panel).getByRole('textbox'), 'bir sonraki soru');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: "Crewhall'a sor" })).toBeNull();

    panel = await openPanel();
    expect(within(panel).getByRole('textbox')).toHaveValue('bir sonraki soru');
    expect(
      await within(panel).findByText(/Bulduğum içeriğe göre/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it('the button that opens it closes it, and a press inside leaves it open', async () => {
    const user = userEvent.setup();
    renderApp('/');
    const panel = await openPanel();
    await user.click(within(panel).getByRole('textbox'));
    expect(panel).toBeInTheDocument();
    const button = () => screen.getByRole('button', { name: "Crewhall'a sor" });
    await user.click(button());
    expect(screen.queryByRole('dialog', { name: "Crewhall'a sor" })).toBeNull();
    await user.click(button());
    expect(await screen.findByRole('dialog', { name: "Crewhall'a sor" })).toBeInTheDocument();
  });

  it('does not hand a draft to the next person on this computer', () => {
    bindConversation('org', 'one');
    keepAskDraft('gizli taslak');
    bindConversation('org', 'two');
    expect(askDraft()).toBe('');
  });

  it('comes back when the panel is closed and opened again, with the mode', async () => {
    const user = userEvent.setup();
    renderApp('/');
    let panel = await openPanel();
    await user.type(within(panel).getByRole('textbox'), 'sunucu envanteri nerede{Enter}');
    expect(
      await within(panel).findByText(/Bulduğum içeriğe göre/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole('radio', { name: 'Yap' }));
    act(() => closeAsk());
    expect(screen.queryByRole('dialog', { name: "Crewhall'a sor" })).toBeNull();

    panel = await openPanel();
    expect(within(panel).getByRole('radio', { name: 'Yap' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(within(panel).getByRole('radio', { name: 'Sor' }));
    expect(within(panel).getByText('sunucu envanteri nerede')).toBeInTheDocument();
    expect(within(panel).getByText(/Bulduğum içeriğe göre/)).toBeInTheDocument();
  });

  it('survives a reload; a question cut off by it can be asked again', async () => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        mode: 'ask',
        ask: [
          {
            id: 1,
            question: 'eski soru',
            answer: 'eski cevap',
            citations: [],
            status: 'done',
            error: null,
          },
          {
            id: 2,
            question: 'sunucu envanteri nerede',
            answer: '',
            citations: [],
            status: 'running',
            error: null,
          },
        ],
        act: [],
      }),
    );
    const user = userEvent.setup();
    renderApp('/');
    const panel = await openPanel();
    expect(within(panel).getByText(/eski cevap/)).toBeInTheDocument();
    expect(within(panel).getByText(/Yarıda kaldı/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Tekrar sor' }));
    expect(
      await within(panel).findByText(/Bulduğum içeriğe göre/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(within(panel).queryByText(/Yarıda kaldı/)).toBeNull();
    expect(within(panel).getAllByText('sunucu envanteri nerede')).toHaveLength(1);
  });

  it('"Yeni soru" clears it, here and in storage', async () => {
    const user = userEvent.setup();
    renderApp('/');
    const panel = await openPanel();
    await user.type(within(panel).getByRole('textbox'), 'sunucu envanteri nerede{Enter}');
    await within(panel).findByText(/Bulduğum içeriğe göre/, {}, { timeout: 5000 });
    expect(sessionStorage.getItem(storageKey)).toContain('sunucu envanteri nerede');
    await user.click(within(panel).getByRole('button', { name: 'Yeni soru' }));
    expect(within(panel).queryByText('sunucu envanteri nerede')).toBeNull();
    expect(sessionStorage.getItem(storageKey)).not.toContain('sunucu envanteri nerede');
    // A reload finds nothing either.
    resetConversationStore();
    expect(JSON.parse(sessionStorage.getItem(storageKey)!)).toMatchObject({ ask: [] });
  });

  it('keeps only the newest turns', () => {
    const turn = (id: number) => ({
      id,
      question: `soru ${id}`,
      answer: '',
      citations: [],
      status: 'done' as const,
      error: null,
    });
    let kept: number[] = [];
    updateConversation((c) => ({
      ...c,
      ask: Array.from({ length: KEPT_TURNS + 5 }, (_, i) => turn(i + 1)),
    }));
    updateConversation((c) => {
      kept = c.ask.map((t) => t.id);
      return c;
    });
    expect(kept).toHaveLength(KEPT_TURNS);
    expect(kept[0]).toBe(6);
  });
});

describe('dictation', () => {
  class FakeRecognition {
    static last: FakeRecognition | null = null;
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    constructor() {
      FakeRecognition.last = this;
    }
    start() {
      this.started = true;
    }
    stop() {
      this.onend?.();
    }
    abort() {
      this.onend?.();
    }
    hear(...parts: [string, boolean][]) {
      this.onresult?.({ results: parts.map(([t, f]) => ({ isFinal: f, 0: { transcript: t } })) });
    }
  }

  class FakeRecorder {
    static last: FakeRecorder | null = null;
    static isTypeSupported = (t: string) => t.startsWith('audio/webm');
    state: 'inactive' | 'recording' = 'inactive';
    mimeType = 'audio/webm;codecs=opus';
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {
      FakeRecorder.last = this;
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new Blob(['opus'], { type: 'audio/webm' }) });
      this.onstop?.();
    }
  }

  const track = { stop: vi.fn() };
  const w = window as unknown as Record<string, unknown>;

  afterEach(() => {
    delete w.webkitSpeechRecognition;
    Reflect.deleteProperty(navigator, 'mediaDevices');
    vi.unstubAllGlobals();
    FakeRecognition.last = null;
    FakeRecorder.last = null;
  });

  async function openPanel() {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('button', { name: "Crewhall'a sor" });
    act(() => openAsk());
    const panel = await screen.findByRole('dialog', { name: "Crewhall'a sor" });
    const box = within(panel).getByRole('textbox');
    return { user, panel, box };
  }

  it('writes what is heard into the box, live, in the interface language', async () => {
    w.webkitSpeechRecognition = FakeRecognition;
    const { user, panel, box } = await openPanel();
    await user.type(box, 'Soru:');
    await user.click(within(panel).getByRole('button', { name: 'Sesle yaz' }));
    const rec = FakeRecognition.last!;
    expect(rec).toMatchObject({ lang: 'tr-TR', interimResults: true, started: true });
    expect(within(panel).getByText('Dinliyorum…')).toBeInTheDocument();
    act(() => rec.hear(['yarın toplantım', false]));
    expect(box).toHaveValue('Soru: yarın toplantım');
    act(() => rec.hear(['yarın toplantım', true], [' var mı', false]));
    expect(box).toHaveValue('Soru: yarın toplantım var mı');
    await user.click(within(panel).getByRole('button', { name: 'Dinlemeyi durdur' }));
    expect(within(panel).queryByText('Dinliyorum…')).toBeNull();
    expect(box).toHaveValue('Soru: yarın toplantım var mı');
  });

  it('starts with Ctrl Shift M; Esc cancels it and keeps the panel open', async () => {
    w.webkitSpeechRecognition = FakeRecognition;
    const { user, box } = await openPanel();
    await user.type(box, 'önce');
    await user.keyboard('{Control>}{Shift>}m{/Shift}{/Control}');
    act(() => FakeRecognition.last!.hear(['sonra', false]));
    expect(box).toHaveValue('önce sonra');
    await user.keyboard('{Escape}');
    expect(box).toHaveValue('önce');
    expect(screen.getByRole('dialog', { name: "Crewhall'a sor" })).toBeInTheDocument();
  });

  it('stays open for a press outside while it is listening', async () => {
    w.webkitSpeechRecognition = FakeRecognition;
    const { user, box } = await openPanel();
    await user.keyboard('{Control>}{Shift>}m{/Shift}{/Control}');
    fireEvent.pointerDown(document.body);
    expect(box).toBeInTheDocument();
    await user.keyboard('{Escape}');
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: "Crewhall'a sor" })).toBeNull();
  });

  it('explains a refused microphone', async () => {
    w.webkitSpeechRecognition = FakeRecognition;
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('button', { name: 'Sesle yaz' }));
    // Browsers end the session after an error.
    act(() => {
      FakeRecognition.last!.onerror?.({ error: 'not-allowed' });
      FakeRecognition.last!.onend?.();
    });
    expect(within(panel).getByRole('alert')).toHaveTextContent('Mikrofon izni verilmedi');
  });

  it('records and asks the speech server where the browser cannot listen', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn(() => Promise.resolve({ getTracks: () => [track] })) },
    });
    const { user, panel, box } = await openPanel();
    await user.click(await within(panel).findByRole('button', { name: 'Sesle yaz' }));
    expect(FakeRecorder.last?.state).toBe('recording');
    expect(await within(panel).findByText(/0:0\d \/ 1:00/)).toBeInTheDocument();
    await user.click(within(panel).getByRole('button', { name: 'Dinlemeyi durdur' }));
    await waitFor(() => expect(box).toHaveValue(MOCK_DICTATION));
    expect(track.stop).toHaveBeenCalled();
  });

  it('tells why it is off without speech recognition or a speech server', async () => {
    aiMockState().settings = { ...aiMockState().settings, transcriptionUrl: null };
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    const { panel } = await openPanel();
    const mic = await within(panel).findByRole('button', {
      name: 'Sesle yazma için konuşma tanıma sunucusu gerekir',
    });
    expect(mic).toBeDisabled();
  });
});

describe('live sources', () => {
  it('shows a meeting as "Toplantı · Yarın 14:00 → Aç" and sends the time zone', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0);
    const meeting: AiCitation = {
      n: 1,
      kind: 'meeting',
      refId: '0190f0a0-0000-7000-8000-00000000b001',
      title: 'Sprint planlama',
      snippet: '',
      nodeId: null,
      spaceId: null,
      conversationId: null,
      seq: null,
      boardId: null,
      cardNumber: null,
      updatedAt: new Date().toISOString(),
      path: '/meetings/room/sprint-abc',
      at: tomorrow.toISOString(),
    };
    let sent: Record<string, unknown> | null = null;
    server.use(
      http.post(`*${AI_RAW_PATHS.ask}`, async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        const events = [
          { type: 'citations', citations: [meeting] },
          { type: 'start', runId: '0190f0a0-0000-7000-8000-00000000b002' },
          { type: 'delta', text: "Evet, yarın 14:00'te 'Sprint planlama' var [1]." },
          {
            type: 'done',
            runId: '0190f0a0-0000-7000-8000-00000000b002',
            usage: { inputTokens: 1, outputTokens: 1 },
            truncated: false,
          },
        ];
        return new HttpResponse(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('button', { name: "Crewhall'a sor" });
    act(() => openAsk());
    const panel = await screen.findByRole('dialog', { name: "Crewhall'a sor" });
    await user.type(within(panel).getByRole('textbox'), 'yaklaşan toplantım var mı{Enter}');
    expect(await within(panel).findByText(/Sprint planlama' var/)).toBeInTheDocument();
    expect(within(panel).getByText('Toplantı · Yarın 14:00')).toBeInTheDocument();
    // The [1] in the answer and the source line both open the meeting.
    const links = within(panel).getAllByTitle(/Sprint planlama/);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/meetings/room/sprint-abc',
      '/meetings/room/sprint-abc',
    ]);
    expect(links[1]).toHaveTextContent('→ Aç');
    expect(sent).toMatchObject({ question: 'yaklaşan toplantım var mı' });
    expect(typeof sent!.timeZone).toBe('string');
  });
});

describe('panel motion and composer', () => {
  const original = Element.prototype.animate;
  afterEach(() => {
    Element.prototype.animate = original;
  });

  function fakeAnimate() {
    const calls: { frames: Keyframe[]; options: KeyframeAnimationOptions; anim: Animation }[] = [];
    Element.prototype.animate = function (frames, options) {
      const anim = { onfinish: null, cancel: vi.fn() } as unknown as Animation;
      calls.push({
        frames: frames as Keyframe[],
        options: options as KeyframeAnimationOptions,
        anim,
      });
      return anim;
    };
    return calls;
  }

  async function open() {
    renderApp('/');
    await screen.findByRole('button', { name: "Crewhall'a sor" });
    act(() => openAsk());
    return screen.findByRole('dialog', { name: "Crewhall'a sor" });
  }

  it('slides in like a desktop sheet, its sections after it, and stays until it has slid out', async () => {
    const calls = fakeAnimate();
    const panel = await open();
    const sheetIn = 'cubic-bezier(0.32, 0.72, 0, 1)';
    expect(calls[0]!.frames[0]).toMatchObject({ transform: 'translateX(100%)' });
    expect(calls[0]!.options).toMatchObject({ duration: 340, easing: sheetIn });
    // Header, conversation and composer follow, each a little later; the resize edge does not.
    const parts = calls.slice(1);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const delays = parts.map((c) => Number(c.options.delay));
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[0]).toBeGreaterThan(0);
    expect(parts.every((c) => c.frames[0]!.opacity === 0)).toBe(true);
    expect(within(panel).getByRole('separator')).toBeInTheDocument();

    const before = calls.length;
    act(() => closeAsk());
    // Still there while it slides out…
    expect(screen.getByRole('dialog', { name: "Crewhall'a sor" })).toBeInTheDocument();
    const out = calls[before]!;
    expect(out.frames[1]).toMatchObject({ transform: 'translateX(100%)' });
    expect(out.options).toMatchObject({ duration: 200, easing: 'cubic-bezier(0.4, 0, 1, 1)' });
    // …and gone once it has.
    act(() => out.anim.onfinish?.(new Event('finish') as AnimationPlaybackEvent));
    expect(screen.queryByRole('dialog', { name: "Crewhall'a sor" })).toBeNull();
  });

  it('only fades, without moving, with reduced motion', async () => {
    // The OS setting (the account switch is applied by the theme on its own).
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'),
      media: q,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
    onTestFinished(() => {
      window.matchMedia = mm;
    });
    const calls = fakeAnimate();
    await open();
    act(() => closeAsk());
    // A fade in and a fade out, and nothing slides.
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.frames.every((f) => f.transform === undefined))).toBe(true);
    expect(calls.map((c) => c.frames.map((f) => f.opacity))).toEqual([
      [0, 1],
      [1, 0],
    ]);
    act(() => calls[1]!.anim.onfinish?.(new Event('finish') as AnimationPlaybackEvent));
    expect(screen.queryByRole('dialog', { name: "Crewhall'a sor" })).toBeNull();
  });

  it('has one box with the send button inside and the keys under it', async () => {
    const user = userEvent.setup();
    const panel = await open();
    const box = within(panel).getByRole('textbox');
    const send = within(panel).getByRole('button', { name: 'Sor' });
    expect(box.parentElement).toContainElement(send);
    expect(send).toBeDisabled();
    await user.type(box, 'merhaba');
    expect(send).toBeEnabled();
    expect(within(panel).getByText('Enter gönderir · Shift+Enter yeni satır')).toBeInTheDocument();
    await user.type(box, '{Shift>}{Enter}{/Shift}ikinci satır');
    expect(box).toHaveValue('merhaba\nikinci satır');
  });
});

describe('fast model setting', () => {
  it('offers the provider suggestion and saves it', async () => {
    const user = userEvent.setup();
    renderApp('/admin/ai');
    const field = await screen.findByLabelText('Hızlı model (isteğe bağlı)');
    expect(field).toHaveAttribute('placeholder', 'claude-haiku-5-5');
    expect(screen.getByText(/Önerilen: claude-haiku-5-5/)).toBeInTheDocument();
    await user.type(field, 'claude-haiku-5-5');
    await user.click(
      within(await screen.findByRole('region', { name: /Kaydedilmemiş/ })).getByRole('button', {
        name: 'Kaydet',
      }),
    );
    await waitFor(() => expect(aiMockState().settings.fastModel).toBe('claude-haiku-5-5'));
  });
});
