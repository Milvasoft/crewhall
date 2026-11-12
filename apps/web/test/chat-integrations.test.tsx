import { LOCALES, resources } from '@crewhall/i18n';
import { WEBHOOK_PROVIDER_EVENTS } from '@crewhall/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { webhookEventKey } from '@/components/chat/WebhooksPanel';
import { chatState } from '@/mocks/chat';
import { CONV } from '@/mocks/chatSeed';
import { db } from '@/mocks/db';
import { USER } from '@/mocks/seed';
import { renderApp } from './support/render';
import { signedInAs } from './support/session';

/** GitHub / Azure DevOps / Jira integrations and the actions under a webhook card. */

describe('service integrations', () => {
  it.each(LOCALES)('names every service event in %s, and no event that is gone', (locale) => {
    const events = Object.values(WEBHOOK_PROVIDER_EVENTS).flat();
    const dictionary = resources[locale].web.chat.hooks.integrations.event;
    const keys = events.map((e) => webhookEventKey(e).split('.').at(-1)!);
    expect(keys.filter((k) => !(k in dictionary))).toEqual([]);
    expect(Object.keys(dictionary).sort()).toEqual([...new Set(keys)].sort());
  });

  it('lists the Azure DevOps deployment event by its name', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.prod}?panel=webhooks`);
    const user = userEvent.setup();
    const panel = await screen.findByRole('complementary', { name: "Uygulamalar ve webhook'lar" });
    await user.click(await within(panel).findByRole('button', { name: 'Entegrasyon ekle' }));
    await user.click(within(panel).getByRole('radio', { name: 'Azure DevOps' }));
    expect(within(panel).getByRole('checkbox', { name: 'Dağıtım tamamlandı' })).toBeChecked();
  });

  it('adds a Jira integration with chosen events and shows the secret and the setup', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.prod}?panel=webhooks`);
    const user = userEvent.setup();
    const panel = await screen.findByRole('complementary', { name: "Uygulamalar ve webhook'lar" });
    await user.click(await within(panel).findByRole('button', { name: 'Entegrasyon ekle' }));
    await user.click(within(panel).getByRole('radio', { name: 'Jira' }));
    expect(within(panel).getByRole('textbox', { name: 'Ad' })).toHaveValue('Jira');
    await user.click(within(panel).getByRole('checkbox', { name: 'İş silindi' }));
    await user.click(within(panel).getByRole('button', { name: 'Oluştur' }));

    expect(await within(panel).findByText('Gizli anahtar')).toBeInTheDocument();
    expect(within(panel).getByText('Jira tarafında')).toBeInTheDocument();
    const hook = chatState(db()).webhooks.find((w) => w.provider === 'jira')!;
    expect(hook.events).toEqual(['jira:issue_created', 'jira:issue_updated', 'comment_created']);
  });

  it('sets the severity of messages without a card, and back to reading the text', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.prod}?panel=webhooks`);
    const user = userEvent.setup();
    const panel = await screen.findByRole('complementary', { name: "Uygulamalar ve webhook'lar" });
    await user.click(await within(panel).findByRole('button', { name: 'Gelen webhook ekle' }));
    const field = within(panel).getByRole('combobox', { name: 'Kartsız mesajın önemi' });
    expect(field).toHaveTextContent('Metinden oku');
    await user.click(field);
    await user.click(await screen.findByRole('option', { name: 'Kritik' }));
    await user.type(within(panel).getByRole('textbox'), 'Yedek betiği{Enter}');
    expect(await within(panel).findByText('Oluşturuldu')).toBeInTheDocument();
    const hook = chatState(db()).webhooks.find((w) => w.name === 'Yedek betiği')!;
    expect(hook.textSeverity).toBe('critical');

    // A plain line from it carries the chosen severity; a card keeps its own.
    const res = await fetch(`http://localhost/api/hooks/${hook.id}?key=${hook.key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Gece yedeği alınamadı' }),
    });
    expect(res.status).toBe(200);
    const { messageId } = (await res.json()) as { messageId: string };
    expect(chatState(db()).messages.find((m) => m.id === messageId)?.severity).toBe('critical');

    await user.click(within(panel).getByRole('button', { name: 'Tamam' }));
    await user.click(await within(panel).findByRole('button', { name: /Yedek betiği/ }));
    await user.click(within(panel).getByRole('button', { name: 'Düzenle' }));
    const edit = within(panel).getByRole('combobox', { name: 'Kartsız mesajın önemi' });
    expect(edit).toHaveTextContent('Kritik');
    await user.click(edit);
    await user.click(await screen.findByRole('option', { name: 'Metinden oku' }));
    await waitFor(() => expect(hook.textSeverity).toBeNull());
  });

  it('takes a card with "Ben bakıyorum" and lets go of it', async () => {
    signedInAs(USER.bugra);
    renderApp(`/chat/c/${CONV.prod}`);
    const user = userEvent.setup();
    const msg = chatState(db()).messages.find(
      (m) => m.card?.title === 'Erişilemiyor · RedisInsight',
    )!;
    const card = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-seq="${msg.seq}"]`);
      if (!el) throw new Error('card not rendered yet');
      return el;
    });
    await user.click(within(card).getByRole('button', { name: 'Ben bakıyorum' }));
    expect(await within(card).findByText('Sen bakıyorsun')).toBeInTheDocument();
    expect(msg.claim?.userId).toBe(USER.bugra);
    await user.click(within(card).getByRole('button', { name: 'Bırak' }));
    await waitFor(() => expect(within(card).queryByText('Sen bakıyorsun')).toBeNull());
  });
});
