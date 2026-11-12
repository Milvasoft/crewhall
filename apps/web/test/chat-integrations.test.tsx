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
