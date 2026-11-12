# Crewhall web (`@crewhall/web`)

React 19 + Vite SPA: giriş ve güvenlik ekranları, uygulama kabuğu (ray, space seçici, Ctrl K), space ayarları,
Yönetim (genel, marka, tema, üyeler, space'ler) ve Hesabım.

## Çalıştırma

```bash
pnpm install
pnpm --filter @crewhall/web dev:mock   # backend olmadan, tarayıcı içi mock (MSW) ile
pnpm --filter @crewhall/web dev        # gerçek backend: /api → VITE_API_PROXY (varsayılan http://localhost:3000)
```

Varsayılan adres `http://localhost:5173`. Port doluysa `PORT=5180 pnpm --filter @crewhall/web dev:mock`.

### Ortam değişkenleri (`.env.example`)

| Değişken         | Anlamı                                                                               |
| ---------------- | ------------------------------------------------------------------------------------ |
| `VITE_API_URL`   | Backend origin. Boşsa aynı origin (`/api`, geliştirmede Vite proxy, üretimde Caddy). |
| `VITE_API_PROXY` | Yalnız geliştirme: `VITE_API_URL` boşken `/api` isteklerinin gideceği adres.         |
| `VITE_API_MOCK`  | `1` ise MSW mock açılır. `dev:mock` (`--mode mock`) bunu kendisi açar.               |

### Mock modu

`src/mocks` sözleşme tablosundan (`packages/shared/src/endpoints.ts`) üretilir: gövde ve sorgu zod şemasıyla doğrulanır
(hata 422 `validation_failed`), her yanıt `response` şemasından geçirilir; mock sözleşmeden sapamaz. better-auth
uçları (`/api/auth/*`: giriş, 2FA, yedek kod, passkey, şifre sıfırlama, kayıt, oturum) da taklit edilir. Veri
tarayıcıda `localStorage`'da tutulur, yeniden yüklemede korunur.

- `?mock=reset`: Milvasoft örnek kurumuna döner (7 kişi, 4 ortak space, 2 davet).
- `?mock=setup`: boş kurulum, kurulum sihirbazı açılır. Kurulum anahtarı `demo-setup-token`; bu senaryoda
  SMTP yok sayılır, davet bağlantıları kopyalanmak üzere listelenir.

Test hesapları (yalnız mock; `src/mocks/seed.ts`):

| Kişi                      | E-posta               | Durum                                        |
| ------------------------- | --------------------- | -------------------------------------------- |
| Ahmet Buğra Kösen (sahip) | `bugra@milvasoft.com` | TOTP açık, 2 passkey                         |
| Elif Yıldız (yönetici)    | `elif@milvasoft.com`  | TOTP açık                                    |
| Selin Öztürk (üye)        | `selin@milvasoft.com` | 2FA yok: zorunlu 2FA kurulumuna düşer (1.14) |
| Burak Şahin (üye)         | `burak@milvasoft.com` | Yönetim ve Portal rayda görünmez             |

Şifre hepsinde `crewhall-demo-2026`, TOTP kodu `123456`, yedek kod örn. `4F7K-92QD`. Davet bağlantısı
`/davet/demo-invite`, süresi dolmuş davet `/davet/expired-invite`, şifre yenileme `/sifre-yenile?t=demo-reset-token`.
Kayıt yalnız bekleyen daveti olan e-postaya açıktır (backend ile aynı).
5 hatalı denemede hesap 15 dk kilitlenir (1.16). Mock modunda passkey WebAuthn penceresi açılmaz, doğrulama taklit edilir.

Faz 1 verisi (`src/mocks/driveSeed.ts`, `quickSeed.ts`): Buğra'nın Benim yüzeyi 2.1'deki kartlarla, Milvasoft ve
Altyapı space yüzeyleri, Milvasoft/Altyapı/Dumpapp/Opsiyon Drive ağaçları, çöp kutusu (3.16), sürümler, favoriler ve
son açılanlar. Yükleme sahte bir nesne deposuna gider (`/__mock/s3`, parça başına ETag), imzalı adresler
`/__mock/blobs` ve `/__mock/preview`'dan sunulur; tohum PDF'ler gerçek çok sayfalı PDF olarak üretilir.
RedisInsight (Test) "erişilemiyor", Portainer (Prod) "yavaş" görünür. Herkese açık linkler:

| Link          | Durum                                              |
| ------------- | -------------------------------------------------- |
| `/s/Rm4tQ8vW` | Dosya, indirme açık (19.1)                         |
| `/s/k7Fq2xP9` | Şifreli, indirme kapalı; şifre `milva-2026` (19.2) |
| `/s/Hq81mZ4c` | Süresi dolmuş, 410 (19.3)                          |
| `/s/Lg5sNw2e` | Klasör "Logo ve sunumlar" (19.5)                   |

## Komutlar

| Komut               | İş                                                               |
| ------------------- | ---------------------------------------------------------------- |
| `dev` / `dev:mock`  | Geliştirme sunucusu (gerçek backend / mock)                      |
| `build`             | `tsc` + `vite build`                                             |
| `typecheck`, `lint` | TypeScript strict, ESLint (react-hooks, `@/` alias kuralı)       |
| `test`              | Vitest + Testing Library; uygulama mock'a karşı uçtan uca render |
| `e2e`               | Playwright: giriş → 2FA → space; yükleme → önizleme → açık link  |

Playwright tarayıcısı yoksa bir kez: `pnpm --filter @crewhall/web exec playwright install chromium`.

## Yapı

```
src/
  routes/          TanStack Router dosya tabanlı rotalar (routeTree.gen.ts otomatik üretilir, commit'lenir)
  components/      auth (giriş düzeni, marka sahnesi), shell (ray, üst çubuk, palet), spaces, admin, common
  lib/             api (api-client), auth (better-auth istemcisi + sarmalayıcı), i18n, theme, queries, oturum
  features/        quick (hızlı erişim yüzeyi, kartlar), drive (liste, yükleme, önizleme, paylaşım, açık link)
  mocks/           MSW: seed, contract (endpoints.ts'ten), drive, quick, auth (better-auth), browser başlatıcı
test/              Vitest; support/ altında render ve MSW node sunucusu
e2e/               Playwright
```

Rotalar (tasarımla aynı Türkçe yollar): `/login`, `/login/2fa`, `/login/2fa/yedek`, `/sifremi-unuttum`,
`/sifre-yenile`, `/davet/$token`, `/kurulum`, `/guvenlik/2fa-kur`, `/` (hızlı erişim, `?yuzey=<space>`),
`/drive/$space` ve `/drive/$space/k/$klasör` (`?onizle=`, `?detay=`, `?g=izgara`), `/drive/$space/cop-kutusu`,
`/drive/son` (son açılanlar ve favoriler), `/drive/ara?q=`, `/s/$token` (herkese açık link, kabuksuz),
`/$modul/$space` (diğer modüller sonraki fazda), `/spaces/$space/ayarlar`,
`/yonetim/{genel,marka,tema,uyeler,spaceler}`, `/hesap/{profil,guvenlik,gorunum}`.

## Kararlar

- **Tasarım sistemi** `@crewhall/ui`: Tailwind 4 preset (`styles.css`, kit tokenları CSS değişkeni olarak), shadcn
  tarzı Radix bileşenleri, kit ikon seti (`_kit/icons.html`'den üretilir: `pnpm --filter @crewhall/ui icons`).
  Mobil yalnız `@crewhall/ui/tokens` kullanır (saf TS, React/DOM yok).
- **White-label**: `bootstrap` ucundaki tema `applyOrgTheme` ile çalışma zamanında CSS değişkenine çevrilir
  (bg/surface/accent'ten oklch türetme, doküman 16 §4); son tema `localStorage`'da önbelleğe alınır, ilk boyamada
  uygulanır. Kurum adı, logo, favicon, sekme başlığı ve "Crewhall ile" ibaresi kurum verisidir.
- **i18n**: `@crewhall/i18n` sözlükleri, ICU (intl-messageformat), anahtarlar tipli (`t('auth.login.title')`).
  Kullanıcı seçimi tarayıcıda; oturum açıkken dil hesaba da yazılır (`updateMe`).
- **Oturum**: better-auth httpOnly çerez. 2FA zorunluluğu `/api/v1/*` uçlarının `two_factor_required`
  yanıtından anlaşılır; kabuk korumaları sırası: kurulum → oturum → 2FA politikası.
- **Kurulum sihirbazı**: dört adımın verisi tek `setup` isteğiyle gider (kurulum anahtarı, kurum, sahip,
  space'ler, davetler). SMTP yoksa yanıt dönen davet bağlantıları listelenir, ardından zorunlu 2FA kurulumu açılır.
- **2FA politikası**: `Me.twoFactorRequired` true ise kabuk açılmadan 1.14 ekranına gidilir; `two_factor_required`
  yanıtı da aynı yere yönlendirir.
- **Gerçek backend**: çalıştırma ve seed hesapları `docs/contracts/backend-calistirma.md`. Geliştirmede Vite proxy
  (`/api` → 3000) kullanılır, tek köken. better-auth istemcisinde `organizationClient` yok (backend'de uçları kapalı).

- **Hızlı erişim (Faz 1)**: ızgara `react-grid-layout` (MIT) ile 12 sütun, 84 px satır, dikey sıkıştırma. Konumlar
  bırakınca `layoutRev` ile kaydedilir (yazımlar sıralı; 409'da yüzey yeniden yüklenir), "Geri al" son 20 adımı tutar.
  Sunucu yüzey uçlarına 501 dönerse Faz 0 karşılama ekranı gösterilir. Kapsam dışı: şablonlar (2.11), diğer
  modül kartları, link sıralamasının sürüklenmesi.
- **Drive (Faz 1)**: yükleme yöneticisi `features/drive/uploads.ts`: 16 MiB parça, dört paralel PUT (XHR, ilerleme),
  parça başına 3 deneme; bağlantı koparsa dosya "duraklatıldı" olur ve `online` olayında `getUpload` ile kaldığı
  yerden sürer. Yarım kalan yüklemeler `localStorage`'da tutulur; sayfa yenilenince aynı dosya seçilince devam eder.
  Ad çakışması 409 `node_name_taken` ile gelir, diyalog `version / replace / rename` ile yeniden başlatır.
  Önizleyici imzalı indirme adresini kullanır (PDF tarayıcının görüntüleyicisinde); liste küçük resimleri
  `RAW_PATHS.preview` (302) ile `<img>`'e bağlanır. Kapsam dışı: ZIP indirme, etiketler, yorumlar, aktivite,
  içerikte arama, sayfa/pano/çizim oluşturma (menüde "Yakında").

### Gerçek backend'e karşı doğrulama (19 Ekim 2026)

Ayrı bir veritabanında (`crewhall_web`), `SETUP_TOKEN` açık ve SMTP kapalı çalışan api'ye Vite proxy ile bağlanıp
elle denendi: kurulum sihirbazı (anahtar, sistem kontrolü, tek istek, davet bağlantısı) → giriş → zorunlu TOTP
kurulumu (kod `pnpm --filter @crewhall/backend totp "<otpauth URI>"` ile) → yedek kodlar → space oluşturma →
Yönetim › Üyeler'den davet (bağlantı listesi) → davet bağlantısıyla hesap oluşturup katılma → çıkış, giriş, yanlış ve
doğru TOTP. Hepsi çalıştı. Gerçek yedek kodlar büyük-küçük harfe duyarlı ve tireli (`TFOTo-APr`); istemci kodu
olduğu gibi gönderir.

## Sözleşme ihtiyaçları

Main 5eb77be ile gelenler kullanılıyor: `listOrgSpaces`, `SetupRequest.setupToken/spaces/invitations`,
`SetupResult.invitations`, `PublicBootstrap.auth.emailEnabled` ve `setup.checks`, `Me.twoFactorRequired`,
`Invitation.url`, `InvitationPreview.spaces/hasAccount`, `Space.isDefault`, `archived` için `z.stringbool()`.

Hâlâ açık olanlar (ilgili alanlar gizli ya da pasif):

1. Logo, favicon ve avatar yükleme ucu (9.2, 9.18 "Değiştir" pasif).
2. Zorunlu 2FA geçiş süresi (1.14 "Sonra hatırlat", kalan gün).
3. Kurum e-posta alan adları ayarı (Misafir ayrımı şimdilik davet edenin alan adıyla yapılıyor), alan adı, destek adresi (9.1).
4. Üye detayı: space'leri, oturumları, 2FA sıfırlama, 2FA yöntemi (TOTP/passkey) (9.6, 9.8).
5. Space sahipliği devri ve silme (3.3, 9.9); space açıklaması ve görünürlüğü (3.2).
6. `Invitation`'da `spaceIds` (yeniden gönderim space'leri koruyamıyor); yeniden gönder ucu.
7. Hesap görünüm tercihleri (`appearance`, yoğunluk) `UpdateMe`'de yok; tarayıcıda tutuluyor.
8. better-auth giriş hatalarında `details.remainingAttempts` ve kilitte `423 { code: 'ACCOUNT_LOCKED', details.lockedUntil }`
   (1.2, 1.16). Gerçek backend şu an şifre hatasında yalnız `INVALID_EMAIL_OR_PASSWORD` dönüyor, şifre için kilit yok
   (yalnız TOTP'de). Web bu alanları okuyor; gelmedikçe sayaç ve kilit ekranı görünmez.
