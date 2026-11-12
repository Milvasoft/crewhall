import { describe, expect, it } from 'vitest';
import { PluginManifest } from '@crewhall/plugin-sdk';
import { notificationSource } from '../src/services/plugins/notify';

/** The source name on a plugin's notifications (docs/contracts/eklentiler.md › Bildirimler). */

const manifest = (extra: Record<string, unknown>) =>
  PluginManifest.parse({
    manifestVersion: 1,
    id: 'com.example.wabridge',
    version: '1.0.0',
    name: { tr: 'WhatsApp Köprüsü (gayriresmî)', en: 'WhatsApp Bridge (unofficial)' },
    description: 'x',
    publisher: { name: 'Example' },
    apiLevel: { min: 1 },
    origin: 'https://wa.example.com',
    ...extra,
  });

const tab = (id: string, title: unknown) => ({ id, title, url: `/${id}`, placement: 'chat' });

describe('notificationSource', () => {
  it("uses the only tab's title, in the recipient's language", () => {
    const m = manifest({
      entryPoints: { tabs: [tab('chats', { tr: 'WhatsApp', en: 'WhatsApp' })] },
    });
    expect(notificationSource(m, 'tr')).toBe('WhatsApp');
    const n = manifest({ entryPoints: { tabs: [tab('notes', { tr: 'Notlar', en: 'Notes' })] } });
    expect(notificationSource(n, 'en')).toBe('Notes');
    expect(notificationSource(n, 'tr')).toBe('Notlar');
  });

  it('falls back to the full name with several tabs or none', () => {
    const two = manifest({ entryPoints: { tabs: [tab('a', 'Gelen'), tab('b', 'Ayarlar')] } });
    expect(notificationSource(two, 'tr')).toBe('WhatsApp Köprüsü (gayriresmî)');
    expect(notificationSource(two, 'en')).toBe('WhatsApp Bridge (unofficial)');
    expect(notificationSource(manifest({}), 'tr')).toBe('WhatsApp Köprüsü (gayriresmî)');
  });

  it('prefers the manifest notificationName', () => {
    const m = manifest({
      notificationName: { tr: 'WhatsApp', en: 'WhatsApp' },
      entryPoints: { tabs: [tab('a', 'Gelen'), tab('b', 'Ayarlar')] },
    });
    expect(notificationSource(m, 'en')).toBe('WhatsApp');
  });
});
