/**
 * Templates that come with the product (design 5.13 "kurum geneli"). These are page content,
 * not UI text, so they live here in both languages; the gallery shows the caller's language.
 * Placeholders: «tarih» / «date» and «yazar» / «author».
 */
export interface BuiltinTemplate {
  key: string;
  category: 'team' | 'engineering' | 'product' | 'project';
  name: Record<'tr' | 'en', string>;
  description: Record<'tr' | 'en', string>;
  markdown: Record<'tr' | 'en', string>;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: 'meeting',
    category: 'team',
    name: { tr: 'Toplantı notu', en: 'Meeting notes' },
    description: { tr: 'Gündem, kararlar, aksiyonlar', en: 'Agenda, decisions, action items' },
    markdown: {
      tr: `«tarih» · Katılanlar: «yazar»

## Gündem

-

## Notlar

## Kararlar

-

## Aksiyonlar

- [ ] `,
      en: `«date» · Attendees: «author»

## Agenda

-

## Notes

## Decisions

-

## Action items

- [ ] `,
    },
  },
  {
    key: 'rfc',
    category: 'engineering',
    name: { tr: 'Teknik tasarım', en: 'Technical design' },
    description: {
      tr: 'Bağlam, öneri, alternatifler, riskler',
      en: 'Context, proposal, alternatives, risks',
    },
    markdown: {
      tr: `:::info[RFC]
Yazar: «yazar» · Tarih: «tarih» · Durum: Taslak
:::

## Bağlam

Neden bu değişikliğe ihtiyaç var?

## Öneri

## Alternatifler

| Seçenek | Artı | Eksi |
| --- | --- | --- |
|  |  |  |

## Riskler ve açık sorular

-

## Karar
`,
      en: `:::info[RFC]
Author: «author» · Date: «date» · Status: Draft
:::

## Context

Why is this change needed?

## Proposal

## Alternatives

| Option | Pros | Cons |
| --- | --- | --- |
|  |  |  |

## Risks and open questions

-

## Decision
`,
    },
  },
  {
    key: 'incident',
    category: 'engineering',
    name: { tr: 'Olay raporu', en: 'Incident report' },
    description: {
      tr: 'Zaman çizelgesi, kök neden, önlemler',
      en: 'Timeline, root cause, follow-ups',
    },
    markdown: {
      tr: `:::danger[SEV-2]
Tarih: «tarih» · Raporlayan: «yazar»
:::

## Özet

## Etki

## Zaman çizelgesi

| Saat | Olay |
| --- | --- |
|  |  |

## Kök neden

## Önlemler

- [ ] `,
      en: `:::danger[SEV-2]
Date: «date» · Reported by: «author»
:::

## Summary

## Impact

## Timeline

| Time | Event |
| --- | --- |
|  |  |

## Root cause

## Follow-ups

- [ ] `,
    },
  },
  {
    key: 'onboarding',
    category: 'team',
    name: { tr: 'Onboarding', en: 'Onboarding' },
    description: { tr: 'İlk gün, ilk hafta, erişimler', en: 'First day, first week, access' },
    markdown: {
      tr: `Ekibe hoş geldin. Bu sayfa ilk haftanı planlaman için.

## İlk gün

- [ ] Hesabını aç ve 2FA'yı kur
- [ ] Ekip sohbetine katıl

## İlk hafta

- [ ] Geliştirme ortamını kur
- [ ] Ekip arkadaşlarınla tanış

## Erişimler

| Sistem | Kimden istenir |
| --- | --- |
|  |  |
`,
      en: `Welcome to the team. Use this page to plan your first week.

## First day

- [ ] Open your account and set up 2FA
- [ ] Join the team chat

## First week

- [ ] Set up your development environment
- [ ] Meet your teammates

## Access

| System | Ask |
| --- | --- |
|  |  |
`,
    },
  },
  {
    key: 'release',
    category: 'product',
    name: { tr: 'Sürüm notları', en: 'Release notes' },
    description: {
      tr: 'Yeni, iyileştirme, düzeltme, kırıcı',
      en: 'New, improved, fixed, breaking',
    },
    markdown: {
      tr: `«tarih» · «yazar»

## Yeni

-

## İyileştirmeler

-

## Düzeltmeler

-

:::warning[Kırıcı değişiklikler]
Yok.
:::
`,
      en: `«date» · «author»

## New

-

## Improvements

-

## Fixes

-

:::warning[Breaking changes]
None.
:::
`,
    },
  },
  {
    key: 'kickoff',
    category: 'project',
    name: { tr: 'Proje başlangıcı', en: 'Project kickoff' },
    description: {
      tr: 'Amaç, kapsam, ekip, kilometre taşları, riskler',
      en: 'Goal, scope, team, milestones, risks',
    },
    markdown: {
      tr: `«tarih» · Hazırlayan: «yazar»

## Amaç

Bu proje bitince ne değişmiş olacak? Tek paragrafta anlat.

## Başarı ölçütleri

-

## Kapsam

| Kapsamda | Kapsam dışında |
| --- | --- |
|  |  |

## Ekip ve roller

| Kişi | Rol |
| --- | --- |
|  |  |

## Kilometre taşları

- [ ] Başlangıç toplantısı
- [ ] İlk sürüm
- [ ] Kapanış

:::warning[Riskler]
Bilinen riskleri ve alınan önlemleri yaz.
:::
`,
      en: `«date» · Prepared by: «author»

## Goal

What will be different when this project is done? One paragraph.

## Success criteria

-

## Scope

| In scope | Out of scope |
| --- | --- |
|  |  |

## Team and roles

| Person | Role |
| --- | --- |
|  |  |

## Milestones

- [ ] Kickoff meeting
- [ ] First release
- [ ] Wrap-up

:::warning[Risks]
List the known risks and what is done about them.
:::
`,
    },
  },
  {
    key: 'sprint',
    category: 'engineering',
    name: { tr: 'Sprint planı', en: 'Sprint plan' },
    description: {
      tr: 'Sprint hedefi, kapasite, işler, retro',
      en: 'Sprint goal, capacity, work, retro',
    },
    markdown: {
      tr: `«tarih» · Sprint sahibi: «yazar»

## Sprint hedefi

Bu sprintin sonunda tek cümleyle ne teslim edilmiş olacak?

## Kapasite

| Kişi | Gün |
| --- | --- |
|  |  |

## Sprintteki işler

- [ ]

## Retro

| İyi gitti | Geliştirilmeli | Aksiyon |
| --- | --- | --- |
|  |  |  |
`,
      en: `«date» · Sprint owner: «author»

## Sprint goal

In one sentence: what is delivered at the end of this sprint?

## Capacity

| Person | Days |
| --- | --- |
|  |  |

## Work in this sprint

- [ ]

## Retro

| Went well | To improve | Action |
| --- | --- | --- |
|  |  |  |
`,
    },
  },
];

export function fillPlaceholders(markdown: string, values: { date: string; author: string }) {
  return markdown
    .replaceAll('«tarih»', values.date)
    .replaceAll('«date»', values.date)
    .replaceAll('«yazar»', values.author)
    .replaceAll('«author»', values.author);
}
