import type { AlertSeverity } from './schemas/chat';

/** Status emoji senders put in front of a line (Milvaion, Grafana templates, CI bots). */
const EMOJI: [RegExp, AlertSeverity][] = [
  [/❌|🔴|🚨|⛔|🔥|💥|🆘/u, 'critical'],
  [/⚠|🟠|🟡/u, 'warning'],
  [/✅|🟢|✔|☑/u, 'success'],
];

/**
 * How serious an alert is when the sender gave no severity (a Google Chat card, or plain text
 * from a webhook): the first status emoji wins, then the words monitoring tools use (Grafana,
 * Uptime Kuma, Seq, Milvaion). Web, mobile and the server use the same reading, so the sound,
 * the bell and the push agree.
 */
export function guessAlertSeverity(text: string): AlertSeverity {
  let first: { at: number; severity: AlertSeverity } | null = null;
  for (const [re, severity] of EMOJI) {
    const at = text.search(re);
    if (at >= 0 && (!first || at < first.at)) first = { at, severity };
  }
  if (first) return first.severity;
  if (/\b(resolved|recovered|is up|back up|ok|success|succeeded|düzeldi|başarılı)\b/i.test(text)) {
    return 'success';
  }
  if (/\b(critical|kritik|firing|down|error|failed|failure|fatal|hata)\b/i.test(text)) {
    return 'critical';
  }
  if (/\b(warn|warning|uyarı|degraded)\b/i.test(text)) return 'warning';
  return 'info';
}

/**
 * The severity a message carries for notifications: its card's, or for a webhook's plain text
 * the one read from the words. Null for people's messages.
 */
export function messageSeverity(m: {
  kind: string;
  text: string;
  card?: { severity: AlertSeverity } | null;
}): AlertSeverity | null {
  if (m.card) return m.card.severity;
  if (m.kind !== 'webhook' || !m.text) return null;
  return guessAlertSeverity(m.text);
}
