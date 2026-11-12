# @crewhall/portal

Portal CMS'in herkese açık sitesi (tasarım 11): eski Docusaurus sitesinin birebir görünümü ve
URL'leri, içerik Hub'ın herkese açık içerik API'sinden (`/api/v1/public/portal/*`) gelir.
Next.js 16 App Router; derleme adımında içerik çekilmez, her sayfa ilk istekte üretilir ve Hub
yayınlayana kadar önbellekte kalır.

## Ortam değişkenleri

`.env.example` dosyasını `.env.local` olarak kopyalayın.

| Değişken                   | Açıklama                                                                  |
| -------------------------- | ------------------------------------------------------------------------- |
| `HUB_API_URL`              | Hub API adresi (ör. `http://localhost:4201`)                              |
| `PORTAL_CONTENT_TOKEN`     | Sitenin salt okunur içerik anahtarı (Hub › Portal › Ayarlar)              |
| `PORTAL_REVALIDATE_SECRET` | Hub'ın `/api/revalidate` çağrısını imzaladığı ortak sır                   |
| `PORTAL_DEFAULT_LOCALE`    | Hub'a ulaşılamazken öneksiz dil (varsayılan `en`; Hub ayarı önceliklidir) |
| `PORTAL_PUBLIC_URL`        | Hub'da site adresi yoksa canonical/sitemap için taban adres               |

## Geliştirme

```bash
pnpm --filter @crewhall/portal dev      # http://localhost:4221
pnpm --filter @crewhall/portal test     # vitest
pnpm --filter @crewhall/portal build && pnpm --filter @crewhall/portal start
node apps/portal/scripts/check-urls.mjs http://localhost:4221   # eski sitemap URL'leri
```

Docker: `docker build -f apps/portal/Dockerfile -t crewhall/portal .` (konteynerde port 3002).

## Nasıl çalışır

- **Yönlendirme:** `src/proxy.ts` Docusaurus URL'lerini iç rotalara çevirir (`resolveRoute`):
  varsayılan dil öneksizdir (`/docs/...` → `/en/docs/...`), diğer diller önekli (`/tr/...`),
  `/en/...` 301 ile öneksiz adrese gider. Bilinmeyen adreste Hub'daki yönlendirme kuralı
  (`portalPublicRedirect`) aranır, yoksa gerçek 404 döner.
- **Önbellek:** Her Hub isteği `fetch(..., { cache: 'force-cache', next: { tags } })` ile
  etiketlenir: `portal:all`, `portal:site`, `portal:sidebar:<v>:<dil>`, `portal:page:<v>:<dil>:<slug>`,
  `portal:paths`, `portal:blog`, `portal:post:<dil>:<slug>`, `portal:redirects`, `portal:media`.
  Sayfalar ISR ile (boş `generateStaticParams`) ilk istekte üretilir ve süresiz önbellekte kalır.
  Hub'a ulaşılamazsa önbellekteki sayfalar sunulmaya devam eder.
- **Yeniden doğrulama:** Hub yayında `POST /api/revalidate` çağırır. Gövde
  `{ site, publish, paths, tags, ts }`, başlık `X-Portal-Signature: sha256=<HMAC-SHA256(sır, gövde)>`.
  İmza zamanlamaya dayanıklı karşılaştırılır, ±5 dakikadan eski çağrı 401 alır. Her etiket
  `revalidateTag(tag, { expire: 0 })` ile hemen geçersiz olur (bir sonraki istek taze veriyle üretilir),
  her yol hem herkese açık hem iç (`/en/...`) haliyle `revalidatePath` edilir. Yanıt
  `{ ok: true, tags: n, paths: n }`.
- **Önizleme:** Hub'daki "Önizle" `GET /api/preview?token=<1 saatlik jeton>&path=/docs/next/...`
  açar. Jeton Hub'a `X-Portal-Preview` başlığıyla doğrulatılır; geçerliyse Next.js taslak modu açılır,
  jeton `portal_preview` httpOnly çerezinde saklanır. Taslak modda Hub istekleri önbelleksiz ve
  jetonla yapılır, sayfalar `noindex` olur, altta koyu önizleme çubuğu çıkar
  (`/api/preview/exit` ile çıkılır).
- **Arama:** Navbar arama kutusu ve `/search` sayfası `/api/search` üzerinden Hub'ın portal
  arama ucunu kullanır; içerik anahtarı tarayıcıya gitmez.
- **Medya:** `/media/<yol>` Hub medyasını akıtır (`Cache-Control: public, max-age=3600,
s-maxage=86400`); eski `/img/...` adresleri `/media/img/...`'e yeniden yazılır, `/favicon.ico`
  site ayarındaki favicon'dur.
- **Görünüm:** Infima + Docusaurus tema CSS'i (`src/styles/docusaurus-theme.css`, orijinal CSS-modül
  sınıf adlarıyla) + eski sitenin `custom.css`'i aynen. Ana sayfa ve alt bilgi eski bileşenlerin
  portu; metin ve görseller Hub'daki ana sayfa bölümlerinden gelir. Hero bölümünün görselleri
  sırayla okunur: `image` marka işareti (alt bilgide de), `images` = [kart şekli, devre arka planı
  (alt bilgide de), dikey yazı, yatay yazı (mobil hero ve alt bilgi)]; özellikler bölümünde
  `images[0]` madde işaretidir.
- **Arayüz metinleri:** Sitenin kendi metinleri `src/i18n/<dil>.ts` içindedir (en, tr; diğer
  diller İngilizceye düşer). Hub arayüzünün sözlüklerinden bağımsızdır.

Birden çok kopya çalıştırılacaksa ISR önbelleği paylaşımlı olmalıdır (Next.js `cacheHandler`);
tek kopyada `.next/cache` diskte tutulur.
