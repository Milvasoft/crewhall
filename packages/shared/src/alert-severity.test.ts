import { describe, expect, it } from 'vitest';
import { guessAlertSeverity, messageSeverity } from './alert-severity';

describe('guessAlertSeverity', () => {
  it('reads the status emoji senders lead with', () => {
    expect(guessAlertSeverity("❌ Job Execution Failed: Job 'X' failed.")).toBe('critical');
    expect(guessAlertSeverity("⚠️ Job misfired: Job 'X' missed its scheduled run")).toBe('warning');
    expect(guessAlertSeverity('✅ Deploy ok')).toBe('success');
    expect(guessAlertSeverity('🔴 api down')).toBe('critical');
  });

  it('takes the first emoji when there are several', () => {
    expect(guessAlertSeverity('✅ resolved, was ❌ failing')).toBe('success');
    expect(guessAlertSeverity('🚨 error rate high ✅ ack')).toBe('critical');
  });

  it('falls back to the words monitoring tools use', () => {
    expect(guessAlertSeverity('[FIRING:1] HighErrorRate')).toBe('critical');
    expect(guessAlertSeverity('[RESOLVED] Disk dolu')).toBe('success');
    expect(guessAlertSeverity('Disk degraded')).toBe('warning');
    expect(guessAlertSeverity('Gece yedeği alındı')).toBe('info');
  });
});

describe('messageSeverity', () => {
  it('uses the card, reads a webhook text and ignores people', () => {
    expect(messageSeverity({ kind: 'webhook', text: '❌ x', card: { severity: 'info' } })).toBe(
      'info',
    );
    expect(messageSeverity({ kind: 'webhook', text: '❌ x', card: null })).toBe('critical');
    expect(messageSeverity({ kind: 'user', text: '❌ x', card: null })).toBeNull();
    expect(messageSeverity({ kind: 'webhook', text: '', card: null })).toBeNull();
  });
});
