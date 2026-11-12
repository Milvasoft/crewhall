import { createFileRoute } from '@tanstack/react-router';
import { MailGate } from '@/components/mail/MailGate';
import { MailSettingsPage } from '@/components/mail/MailSettingsPage';

/** Posta › Ayarlar: the connected account, signature and notifications. */
export const Route = createFileRoute('/_app/mail/settings')({
  component: function MailSettingsRoute() {
    return <MailGate>{(state) => <MailSettingsPage state={state} />}</MailGate>;
  },
});
