# Backend çalıştırma notu (Faz 0)

Bu not `apps/backend` (`@crewhall/backend`), `packages/db` ve `docker/` için yerel çalıştırmayı, test
hesaplarını ve web ile mobilin nasıl bağlanacağını anlatır. Sözleşme: `packages/shared/src/endpoints.ts`
ve better-auth (`/api/auth/*`).

> **Port:** dev compose Postgres'i host'ta **5433**'e açar (5432 değil). `DATABASE_URL=postgres://crewhall:crewhall@localhost:5433/crewhall`.
> api 3000, S3 8333, Mailpit 1025 / 8025.

## Tek komutla (tools/dev-up)

```bash
tools/dev-up/dev-up.sh                                   # bash / Git Bash / macOS / Linux
```

```powershell
powershell -ExecutionPolicy Bypass -File tools/dev-up/dev-up.ps1
```

Betik sırasıyla şunları yapar:

1. Altyapıyı kaldırır: `docker/compose.dev.yml`, portları `docker/.env` verir.
2. Yoksa `apps/backend/.env` ve `apps/web/.env.local` dosyalarını örneklerden oluşturur. Yeni
   `.env.local`'e proxy satırları yazılmaz; hedefler aşağıdaki port düzeninden türetilir.
3. `node_modules` yoksa `pnpm install` çalıştırır.
4. Seed'i çalıştırır: migration'lar ve örnek kurum. Kurum zaten varsa bu adım atlanır.
5. api'yi (worker süreç içinde), collab'ı (sayfa, kart açıklaması ve çizimlerde ortak düzenleme) ve
   web'i başlatır.

Portlar tek bir yerden türetilir; dosyada değer varsa o kullanılır:

| Süreç | Port | Nereden |
| --- | --- | --- |
| api | `PORT` | `apps/backend/.env` (yoksa 3000) |
| collab | `COLLAB_PORT` | `apps/backend/.env`; yoksa api portu + 1 (3000 → 3001, 4100 → 4101, 4401 → 4402) |
| web | `HUB_URL`'in portu | `apps/backend/.env` (`http://localhost:4411` → 4411; portsuzsa 5173) |
| web'in `/api` vekili | `VITE_API_PROXY` | `apps/web/.env.local`; yoksa `http://localhost:<api portu>` |
| web'in `/collab` vekili | `VITE_COLLAB_PROXY` | `apps/web/.env.local`; yoksa `http://localhost:<collab portu>` |

- api aynı `COLLAB_PORT` ile collab'a canlı düzenleme gönderir (geri yükleme, MCP yazımı).
- Tarayıcıya verilen collab adresi geliştirmede `ws://localhost:<collab portu>` olur. Telefondan ya da
  yerel ağdan deneyeceksen `apps/backend/.env`'e `COLLAB_PUBLIC_URL=ws://<makine IP>:<web portu>/collab`
  yaz; bağlantı web portundaki `/collab` vekilinden geçer.

Ctrl+C api'yi, collab'ı ve web'i durdurur (alt süreçleriyle birlikte), altyapı açık kalır. Seçenekler:

| bash | PowerShell | Etkisi |
| --- | --- | --- |
| `--no-seed` | `-NoSeed` | Seed adımını atlar |
| `--no-web` | `-NoWeb` | Web'i başlatmaz (api ve collab çalışır) |
| `--down` | `-Down` | Altyapıyı durdurur |

Portlar ve adresler yalnız bu `.env` dosyalarından gelir, betiğin içinde sabit değer yoktur.

**Uyarı:** worktree'de `docker/.env` yoksa compose varsayılan portlarla (5433, 8333) aynı
`crewhall-dev` projesini yeniden kurar ve çalışan yığının port eşlemelerini değiştirir. Betiği
çalıştırmadan önce `docker/.env` dosyasını ana checkout'tan kopyala.

## Hızlı başlangıç (adım adım)

```bash
docker compose -f docker/compose.dev.yml up -d          # Postgres 17, SeaweedFS, Mailpit
cp apps/backend/.env.example apps/backend/.env
pnpm install
pnpm --filter @crewhall/backend seed                     # isteğe bağlı: Milvasoft örnek kurumu
pnpm --filter @crewhall/backend dev                      # http://localhost:3000
```

- Açılışta migration'lar uygulanır (`MIGRATE_ON_START=true`, Postgres advisory lock ile; birden çok kopya
  aynı anda kalksa da yalnız biri çalıştırır).
- Seed çalıştırılmazsa sunucu "kurulum gerekli" durumunda açılır; kurulumu web'deki sihirbaz ya da aşağıdaki
  curl örneği yapar.
- Sağlık: `GET /healthz` (süreç ayakta), `GET /readyz` (veritabanı erişilebilir).

| Servis                 | Adres                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| api                    | http://localhost:3000                                            |
| Postgres (dev compose) | localhost:**5433** (kullanıcı/şifre/db: `crewhall`)              |
| SeaweedFS S3           | http://localhost:8333 (`crewhall` / `crewhall-dev-secret`)       |
| Mailpit                | SMTP localhost:1025, arayüz http://localhost:8025                |

Postgres host'ta 5433'e açılır, çünkü geliştirme makinelerinde çoğu zaman yerel bir Postgres 5432'yi tutar.
`POSTGRES_PORT=5432 docker compose -f docker/compose.dev.yml up -d` ile değiştirilebilir (o zaman
`DATABASE_URL`'i de güncelle).

Sıfırdan başlamak için: `docker compose -f docker/compose.dev.yml down -v`.

## Ortam değişkenleri

`apps/backend/.env.example` geliştirme değerleriyle gelir; `src/env.ts` hepsini zod ile doğrular, eksik ya da
hatalı değişkende süreç açıklamalı bir hatayla durur.

| Değişken                                              | Anlamı                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `HUB_URL`                                             | Web uygulamasının adresi. E-postadaki bağlantılar buraya gider; CORS ve better-auth bu kökene güvenir.       |
| `API_URL`                                             | Bu api'nin dışarıdan görünen adresi (better-auth `baseURL`). Üretimde Caddy arkasında `HUB_URL` ile aynıdır. |
| `WEB_ORIGINS`                                         | Ek tarayıcı kökenleri (virgülle). Ör. web'i başka portta açıyorsan.                                           |
| `TRUSTED_ORIGINS`                                     | Tarayıcı dışı kökenler: mobil şeması `crewhall://`, Expo Go için `exp://`.                                    |
| `DATABASE_URL`, `MIGRATE_ON_START`, `MIGRATIONS_DIR`  | Veritabanı ve migration'lar.                                                                                 |
| `WORKER_IN_PROCESS`                                   | İşleri (yükleme işleme, önizleme, link kontrolü) api sürecinde çalıştır; dev varsayılanı açık, üretimde kapalı. |
| `AUTH_SECRET`                                         | En az 32 karakter. Oturum imzası ve TOTP sırlarının şifrelenmesi buna bağlıdır; değişirse 2FA'lar bozulur.   |
| `SETUP_TOKEN`                                         | Kurulum anahtarı. Üretimde boşsa rastgele üretilip loga yazılır; dev'de boşsa anahtar istenmez.               |
| `SIGNUP_OPEN`                                         | `true` ise davetsiz kayıt açılır (varsayılan kapalı: yalnız davetli e-postalar kayıt olabilir).              |
| `TOTP_ISSUER`                                         | Doğrulama uygulamasında görünen ad (varsayılan `Crewhall`).                                                   |
| `SMTP_URL`, `MAIL_FROM`                               | E-posta. Boşsa e-posta gönderilmez; davetler bağlantı olarak paylaşılır (`Invitation.url`).                  |
| `S3_*`                                                | Depolama: `S3_ENDPOINT` (api → S3), `S3_PUBLIC_ENDPOINT` (imzalı adreslerin tarayıcıdan görünen kökü), `S3_BUCKET` (yoksa açılışta oluşur), `S3_REGION`, anahtarlar. |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`    | OTLP/HTTP hedefi (ör. Seq `http://seq:5341/ingest/otlp`). Boşsa telemetri kapalı.                             |
| `LOG_LEVEL`                                           | pino seviyesi. Loglar stdout'a JSON; `NODE_ENV=development` iken pino-pretty ile okunur biçimde.             |
| `APP_VERSION`, `MIN_MOBILE_VERSION`                 | `bootstrap.server`: sunucu sürümü (boşsa package.json) ve desteklenen en eski mobil sürüm (boşsa sınır yok). |
| `BUILD_ID`, `BUILD_COMMIT`                          | `getCompat`: imajın CI derleme numarası ve commit'i. CI, imajı derlerken build arg olarak verir; boşsa yanıtta yer almaz. |

## Seed: test hesapları

`pnpm --filter @crewhall/backend seed` yalnız hiç kurum yokken çalışır. Gerçek kurulum servisini çalıştırır,
diğer kişileri davet + kabul akışıyla ekler (veri arayüzden oluşturulmuş gibidir).

Bütün hesapların şifresi: **`Crewhall-dev-2026`**

| Hesap                  | Kurum rolü | 2FA  | Space'ler (varsayılan "Milvasoft" space'i herkeste, misafir hariç) |
| ---------------------- | ---------- | ---- | ------------------------------------------------------------------- |
| `bugra@milvasoft.com`  | Sahip      | TOTP | Hepsinin sahibi                                                     |
| `elif@milvasoft.com`   | Yönetici   | TOTP | Altyapı (yönetici), Dumpapp (düzenleyen)                            |
| `mert@milvasoft.com`   | Üye        | yok  | Altyapı (düzenleyen)                                                |
| `zeynep@milvasoft.com` | Üye        | yok  | Opsiyon (düzenleyen)                                                |
| `can@milvasoft.com`    | Üye        | yok  | Dumpapp (düzenleyen)                                                |
| `selin@milvasoft.com`  | Üye        | yok  | yalnız varsayılan                                                   |
| `destek@dumpapp.io`    | Misafir    | yok  | Dumpapp (izleyen); kişisel space'i yok                              |

- Ortak space'ler: Milvasoft (varsayılan), Altyapı, Dumpapp, Opsiyon. Her kişinin bir kişisel space'i vardır.
- Faz 1 örneği: sahibin "Benim" yüzeyinde Milvasoft link grubu (sağlık kontrolü kapalı; gerçek siteler), not ve
  yapılacaklar; Milvasoft space yüzeyinde bir not; Drive'da "Logo ve sunumlar", "Onboarding", "Sunumlar"
  klasörleri. Seed bu örneği daha önce seed edilmiş veritabanına da ekler (Benim boşsa).
- `burak@milvasoft.com` için bekleyen bir davet bırakılır; bağlantısı seed çıktısında yazar (davet kabul ekranını
  denemek için).
- Sahip ve yönetici aynı geliştirme TOTP sırrını kullanır. Geçerli kodu görmek için:
  `pnpm --filter @crewhall/backend totp`. Kendi kurduğun bir 2FA için:
  `pnpm --filter @crewhall/backend totp "otpauth://totp/..."` (two-factor/enable yanıtındaki `totpURI`).
- Yedek kodlar (dev, sahip ve yönetici): `DEVA-2345`, `DEVB-2345` … `DEVK-2345` (I harfi yok); büyük-küçük
  harf ve tire önemsiz, her kod bir kez kullanılır. Sıfırdan başlatmak için seed'i boş veritabanında yeniden çalıştır.

## Kimlik doğrulama ve politika

- better-auth `/api/auth/*`: e-posta + şifre (en az 12 karakter), e-posta doğrulama, şifre sıfırlama
  (30 dk, tek kullanımlık, sıfırlayınca bütün oturumlar kapanır ve hesap kilidi kalkar), TOTP (`/two-factor/*`),
  passkey (`/passkey/*`), `bearer`, `expo`. Organizasyon eklentisi yüklüdür ama HTTP uçları
  kapalıdır: kurum, üye ve davet yönetimi yalnız `/api/v1` üzerinden yapılır (can() ve denetim günlüğü her
  zaman çalışsın diye). Aktif kurum değişimi: `POST /api/v1/me/active-org`.
- Kayıt (`POST /api/auth/sign-up/email`) yalnız bekleyen ve süresi dolmamış daveti olan e-postaya açıktır;
  aksi halde `403 { code: "SIGNUP_REQUIRES_INVITATION" }`. Davet kabul edilince e-posta doğrulanmış sayılır
  (bağlantı o adrese gitti).
- 2FA politikası: kurum ayarı `requireTwoFactor` açıksa herkes, kapalıysa da **sahip ve yöneticiler** her zaman
  (doküman 01, "Zorunlu 2FA"). TOTP ya da passkey politikayı karşılar. 2FA'sı olmayan kişi kurum uçlarında
  `403 two_factor_required` alır; `me`, `updateMe`, `switchOrg`, `listSessions`, `revokeSession` ve
  `acceptInvitation` muaftır. `Me.twoFactorRequired` arayüze 1.14 ekranını açmasını söyler.
- Oturum: 30 gün, 12 saatte bir yenilenir. "Bu cihazda oturumu açık tut" işaretsizse (`rememberMe: false`)
  çerez tarayıcı kapanınca biter.
- Oran sınırı (better-auth, IP başına, 429): giriş 10/dk, 2FA 10/dk, şifre sıfırlama 5/saat, kayıt 5/dk.

### Hesap kilidi (1.2, 1.16) ve yedek kodlar (1.4)

- Hatalı şifre (`/sign-in/email`), hatalı TOTP (`/two-factor/verify-totp`) ve hatalı yedek kod
  (`/two-factor/verify-backup-code`) **e-posta başına tek sayaca** yazılır. Var olmayan e-posta da aynı
  biçimde sayılır ve aynı yanıtları alır. Hesabı olan kişide 2FA adımı yalnız giriş akışında sayılır
  (oturum açıkken 2FA kurarken yazılan yanlış kod sayılmaz).
- Yanıtlar (`AuthFailureBody`):
  - `401 { code: "INVALID_EMAIL_OR_PASSWORD" | "INVALID_CODE", message, remainingAttempts? }`;
    `remainingAttempts` yalnız 3 ya da daha az hak kaldığında gelir (2. hatadan sonra 3, sonra 2, 1).
  - 5. hata ve sonrası: `423 { code: "ACCOUNT_LOCKED", message, lockedUntil, lastFailedAt, lastFailedIp }`.
    Kilitliyken doğru şifre ve doğru kod da 423 alır.
- Süre 15 dk; önceki kilidin bitişinden sonraki 24 saat içinde yeniden kilitlenirse 30, sonra 60 dk (üst sınır).
- Doğru şifre 2FA adımına geçirir ama sayacı sıfırlamaz; giriş tamamlanınca (şifre ya da 2FA kodu) sıfırlanır.
- Kilitlenince: kişiye "Kilidi aç" bağlantılı e-posta (`HUB_URL/forgot-password?email=…`, şifre sıfırlanınca
  kilit kalkar), kurumdaki sahip ve yöneticilere e-posta (`HUB_URL/admin/members/<userId>`), denetim
  günlüğüne `auth.account.locked`.
- Yönetici kilidi kaldırır: `POST /api/v1/org/members/:userId/unlock` (`org.manage_members`,
  `auth.account.unlocked`). `OrgMember.lockedUntil` yalnız bu yetkiye sahip kişilerin listesinde gelir.
- Passkey ile giriş kilitten etkilenmez.
- IP: Caddy arkasında `X-Forwarded-For`'un ilk değeri, doğrudan bağlantıda soket adresi (dev'de `::1`).
- Yedek kodlar 10 adet, 8 karakter, büyük harf ve rakam (karışan 0/O, 1/I/L yok). better-auth onları
  `ABCD2345` biçiminde döndürür; arayüz `formatBackupCode` ile `ABCD-2345` gösterir. Sunucu girilen kodu
  `normalizeBackupCode` ile karşılaştırır (büyük-küçük harf ve tire önemsiz). Eski biçimdeki kodlar geçersizdir.

## Web nasıl bağlanır

Geliştirmede iki yol var; ikisi de çalışır:

1. **Vite proxy (önerilen, üretimle aynı tek köken):** `vite.config.ts` içinde
   `server.proxy = { '/api': 'http://localhost:3000' }`. Web `fetch('/api/...')` çağırır, çerez birinci
   taraftır, CORS devreye girmez. better-auth istemcisi: `createAuthClient({ baseURL: window.location.origin })`.
2. **Doğrudan:** `createApiClient({ baseUrl: 'http://localhost:3000', credentials: 'include' })` ve
   `createAuthClient({ baseURL: 'http://localhost:3000' })`. CORS `HUB_URL` (+ `WEB_ORIGINS`) kökenine
   `credentials` ile açıktır; `localhost:5173` ile `localhost:3000` aynı site sayıldığı için `SameSite=Lax`
   çerez gider.

- Ortak düzenleme (Hocuspocus): web dev sunucusu `/collab` yolunu `VITE_COLLAB_PROXY` hedefine
  (varsayılan `http://localhost:3001`) önekini silerek iletir (Caddy'deki `handle_path /collab*` gibi);
  telefon ve LAN tek port üzerinden bağlansın diye backend'de `COLLAB_PUBLIC_URL=ws://<host>:<web portu>/collab`
  ver (ör. `ws://192.168.1.14:4110/collab`).
- Collab adresi web kökenindeyse (`HUB_URL` ya da `WEB_ORIGINS`), tarayıcıya yalnız yolu verilir: `collab-token`
  cevabındaki `url` `/collab` olur (B12). Web bu yolu sayfanın adresine göre `ws(s)://` olarak çözer
  (`resolveCollabUrl`, `@crewhall/shared`). Böylece sayfa 127.0.0.1'den, alan adından ya da VPN'den açılınca da
  bağlanır. `COLLAB_PUBLIC_URL=/collab` de yazılabilir.
- **LAN adresinden açmak (başka cihaz, telefon tarayıcısı):** `http://<LAN IP>:<web portu>` güvenli bağlam değildir;
  tarayıcı kamera, mikrofon ve ekran paylaşımını açmaz (`navigator.mediaDevices` yok). Uygulama çalışır, toplantıya
  yalnız dinleyici olarak katılınır ve ekran nedenini söyler. Kamera ve mikrofonla denemek için web dev sunucusunu
  https açın: `VITE_DEV_HTTPS=1` (`@vitejs/plugin-basic-ssl`, kendinden imzalı sertifika; tarayıcıda bir kez "yine de
  devam et" denir). Örnek: `VITE_DEV_HTTPS=1 pnpm --filter @crewhall/web dev --host 0.0.0.0 --port 4112`, sonra
  `https://192.168.1.14:4112`. Bu kökeni backend `WEB_ORIGINS`'e ekleyin. https sayfası `ws://` LiveKit'e bağlanamadığı
  için (karışık içerik) dev'de LiveKit sinyali web sunucusunun `/livekit` yolundan geçer (`VITE_LIVEKIT_PROXY`,
  varsayılan `http://localhost:7880`); medya UDP ile doğrudan gider.
- Çerez: `crewhall.session_token`, httpOnly, `SameSite=Lax`, `API_URL` https ise `Secure` (adı da
  `__Secure-` önekiyle başlar). 2FA ara adımında `crewhall.two_factor` çerezi kullanılır.
- better-auth tarayıcıdan gelen isteklerde `Origin` başlığını güvenilen kökenlerle karşılaştırır; curl ile
  denerken `-H "Origin: http://localhost:5173"` ekle.
- Web istemci eklentileri: `twoFactorClient()`, `passkeyClient()` (`@better-auth/passkey/client`).
  `organizationClient` kullanma (uçları kapalı).
- Şifre sıfırlama e-postasındaki bağlantı `HUB_URL/reset-password?t=<token>`; sayfa
  `authClient.resetPassword({ newPassword, token })` çağırır. Davet bağlantısı `HUB_URL/invite/<token>`:
  `getInvitation` (herkese açık önizleme, `hasAccount` ile giriş/kayıt seçimi) → kayıt ya da giriş →
  `acceptInvitation`. E-posta doğrulama bağlantısı api'ye gider ve doğruladıktan sonra `HUB_URL/`'e yönlendirir.
- `listSpaces` ve `listOrgSpaces` sorgusundaki `archived` dize olarak gider: `"true"` / `"false"` (`z.stringbool()`;
  `"1"`/`"0"` da olur, başka değer `422 validation_failed`).
- Tema CSS'i: `GET /api/theme.css` (ETag'li; `--ch-bg`, `--ch-surface`, `--ch-accent`, `--ch-radius`).
- Hata gövdesi `{ code, message, details? }`; `message` `Accept-Language`'a göre tr/en gelir, arayüz yine de
  `errors.<code>` anahtarını kullanmalı.

## Mobil nasıl bağlanır

- Sunucu adresi: Android emülatörden `http://10.0.2.2:3000`, iOS simülatörden `http://localhost:3000`,
  gerçek cihazdan bilgisayarın LAN IP'si (`http://192.168.x.x:3000`).
- better-auth: `expoClient({ scheme: 'crewhall', storagePrefix: 'crewhall', storage: SecureStore })` ve
  `twoFactorClient()`. Expo eklentisi `expo-origin` başlığıyla köken kontrolünü geçer; sunucuda
  `TRUSTED_ORIGINS=crewhall://,exp://` olmalı (dev `.env.example`'da var).
- `/api/v1` çağrıları: `createApiClient({ baseUrl, getToken })`. Oturum jetonu giriş ya da
  `two-factor/verify-totp` yanıtındaki `set-auth-token` başlığından gelir (bearer eklentisi); SecureStore'da
  tutulup `Authorization: Bearer <token>` olarak gönderilir. Bearer ile `/api/auth/get-session` da çalışır.
- 2FA: `signIn.email` yanıtı `{ twoFactorRedirect: true }` ise kodla `twoFactor.verifyTotp({ code })`.
  Ara adım çerezini expo istemcisi kendisi saklar ve gönderir.
- Ortak düzenleme: `createCollabToken` `source: 'mobile'` ile çağrılınca `url` her zaman tam adrestir
  (`ws(s)://…`). `COLLAB_PUBLIC_URL` bir yolsa `HUB_URL`'in hostuna göre tamamlanır. Yalnız web (`source: 'web'`)
  ve pano/çizim jetonu (`createBoardsCollabToken`) göreli yol (`/collab`) alabilir. Mobil göreli yolu kendi sunucu
  adresine göre çözmeye geçerse (`resolveCollabUrl(url, sunucuAdresi)`) backend mobil için de yol döndürebilir.
  O zamana kadar kurulu APK'lar bozulmasın diye tam adres döner.
- Sunucu sürümü: `bootstrap.server = { version, minMobileVersion }`. `version` `APP_VERSION` env'den,
  yoksa `apps/backend/package.json`'dan (şu an `0.1.0`); `minMobileVersion` `MIN_MOBILE_VERSION`'dan
  (boşsa `null`).

### QR ile bağlanma (12.3)

- Web: `POST /api/v1/mobile/connect` (oturum gerekir) → `{ url, expiresAt }`; `url`
  `crewhall://connect?server=<HUB_URL kökeni>&token=…`, QR olarak gösterilir, 5 dk geçerli.
- Mobil: `parseConnectUrl(qr)` → `GET /api/v1/mobile/connect/:token` → `{ email, name, orgName }`.
  Jeton okununca tüketilir; kullanılmış ya da süresi dolmuşsa `410 mobile_connect_invalid`. Jeton sunucuda
  sha256 olarak tutulur; `mobile.connect.create` ve `mobile.connect.use` denetime yazılır.

### Tarayıcıyla giriş (passkey; faz-0-kapanis §4)

1. Mobil `codeVerifier` (43-128 karakter) üretir, `codeChallenge = base64url(sha256(verifier))`.
2. Tarayıcıda `<server>/mobile-login?challenge=…&redirect=crewhall://auth` (Expo Go: `exp://…/--/auth`) açılır.
3. Web oturum açtıktan sonra `POST /api/v1/mobile/handoff { codeChallenge, redirectUri }` → `{ code, expiresAt }`
   ve `redirectUri?code=…` adresine yönlenir. `redirectUri` yalnız `crewhall:` ve (üretim dışında)
   `exp:` şemalarında kabul edilir; başkası `422 validation_failed`. `NODE_ENV=production` iken Expo Go ile
   giriş yapılamaz: `exp://` bağlantısı kodu bağlantıyı yazanın projesine götürebilir.
4. Mobil `POST /api/v1/mobile/handoff/exchange { code, codeVerifier }` → `{ token, expiresAt }`. `token`
   bearer oturum jetonudur (`set-auth-token` ile aynı biçim), cihaz için yeni bir oturumdur.
- Kod 60 sn geçerli ve tek kullanımlıktır (yanlış verifier da kodu yakar); hatada `400 mobile_handoff_invalid`.
  Yeni oturum denetime `auth.session.new_device` olarak yazılır ve oturum listesinde IP ile görünür.

### Mobilden posta ve takvim hesabı bağlama (OAuth hand-off, `oauth.handoff`)

Google ve Microsoft girişi sistem tarayıcısında yapılır. Bu tarayıcıda web oturumu yoktur, bu yüzden
uygulama tek kullanımlık bir bağlantı ister:

1. Uygulama (bearer oturum) `POST /api/v1/me/oauth-handoffs` gönderir:
   `{ purpose: 'mail' | 'calendar', provider?: 'google' | 'microsoft', redirectUri }`.
   - Takvimde `provider` zorunludur.
   - `redirectUri` yalnız `crewhall:` ya da üretim dışında `exp:` olabilir (ör. `crewhall://open`).
   - Yanıt `{ url, expiresAt }`. Kişinin bu hesabı bağlama yetkisi baştan denetlenir (modül açık, misafir
     değil); yoksa 403.
2. Uygulama `url`'i (`/api/oauth/handoff?code=`) sistem tarayıcısında açar.
   - Kod 2 dk geçerlidir ve tek kullanımlıktır; sonra `410 oauth_handoff_invalid`.
   - Api sağlayıcının akışını o kişi için başlatır ve tarayıcıya httpOnly bir çerez koyar.
3. Sağlayıcı callback'i (`/api/mail/oauth/callback`, `/api/calendar/oauth/callback`) oturum olmadan, o
   bağlantının kişisi olarak çalışır.
   - Yalnız aynı tarayıcıda çalışır: çerez sağlayıcının `state`'ine bağlıdır.
   - Bitince `<redirectUri>?url=<sayfa>` adresine döner. Sayfa webdekiyle aynıdır:
     `/calendar?connected=google`, `/mail?connected=1` ya da `?error=<kod>`.
- Kod ve state bağı better-auth'un `verifications` tablosunda yalnız hash olarak durur; migration yok.
- API ve MCP jetonları bağlantı isteyemez.
- Denetim kaydına `oauth.handoff.create` ve `oauth.handoff.open` yazılır. Bağlanan hesap her zamanki gibi
  `mail.account.connect` / `calendar.account.connect` olarak kaydedilir.
- Paylaşılan kutuların girişi (inbox) bu yoldan yapılmaz; webde kalır.

## Faz 1: Drive ve hızlı erişim

Sözleşme `packages/shared/src/schemas/drive.ts`, `schemas/quick.ts` ve `endpoints.ts`'in Faz 1 bölümüdür.
Gerçek zamanlı olay bu fazda yok; istemciler değişiklikten sonra sorguyu yeniler (refetch).

### Depolama ve yükleme

- Baytlar api'den geçmez: istemci imzalı adreslerle doğrudan S3'e (dev'de SeaweedFS, `localhost:8333`) yükler
  ve indirir. İmzalı adresler `S3_PUBLIC_ENDPOINT` ile üretilir (üretimde `https://s3.<alan>`); api S3'e
  `S3_ENDPOINT`'ten konuşur. Bucket açılışta yoksa oluşturulur.
- SeaweedFS CORS'u açıktır ve `ETag` başlığını tarayıcıya gösterir (çok parçalı yüklemede gerekli).
- Akış:
  1. `createUpload { spaceId, parentId, name, sizeBytes, mime?, onConflict?, nodeId? }` → `Upload`
     (`partSize` 16 MiB, `partCount`). Yetki, dosya boyutu (`maxFileBytes`, varsayılan 5 GB) ve kota burada
     denetlenir; boyut yükleme bitene kadar kotadan ayrılır.
  2. `getUploadPartUrls { partNumbers }` → parça başına imzalı PUT adresi (1 saat). İstemci parçaları paralel
     PUT eder ve yanıttaki `ETag`'i saklar.
  3. Bağlantı koparsa `getUpload` → `uploadedParts` (depodaki parçalar); kalan parçalar için yeni adres alınır.
  4. `completeUpload { parts: [{ partNumber, etag }] }` → `{ node, version }`. Sunucu parçaları birleştirir,
     depodaki boyutu `HeadObject` ile karşılaştırır (tutmazsa `upload_invalid` + `size_mismatch`), düğümü ya da
     yeni sürümü oluşturur ve kotayı kesinleştirir. Yükleme 7 gün içinde tamamlanmazsa süresi dolar.
- Ad çakışması (3.14): `onConflict` `ask` (varsayılan, `409 node_name_taken` + `details.nodeId`), `version`
  (aynı düğüme yeni sürüm), `rename` (`rapor (2).txt`) ya da `replace` (yeni sürüm, eski sürümler silinir).
- İşleme (worker): `blob.process` sha256'yı hesaplar, türü içerikten bulur (`node.mime` güncellenir),
  boyut ya da gizlenmiş çalıştırılabilir dosyada karantinaya alır, kurumda aynı içerik varsa tek blob'a indirir
  (ikinci nesne silinir). `preview` görsellerde WebP 256 ve 1024, PDF'de ilk sayfa (`pdf_p1`) üretir;
  `DriveNode.preview` `ready` olunca `getPreview` adres döner, yoksa `404 preview_unavailable`. Video kapağı ve
  Office önizlemesi bu fazda yok.
- Tekilleştirme yüklemeden sonra yapılır (doküman 17 §8): istemcinin bildirdiği özete güvenilmez, bu yüzden
  "içerik zaten var, yükleme anında biter" (tasarım 3.7) yoktur; aynı içerik depoda yine tek kalır.
- İndirme: `getDownloadUrl` (5 dk, dosya adı Content-Disposition'da, `?versionId=` eski sürüm) ya da tarayıcıda
  doğrudan `GET /api/v1/nodes/:nodeId/download` (302, oturum çereziyle). Önizleme için
  `GET /api/v1/nodes/:nodeId/preview/raw?kind=` (302). Bu yollar `RAW_PATHS`'tedir.

### Space silme ve geri yükleme

- `DELETE /api/v1/spaces/:spaceId`: yalnız sahip çağırabilir; kişisel space silinemez.
- Silinen space herkes için kaybolur: listeler, içerik, sohbetler ve yüzeyler 404 döner.
- Sahip silinen space'leri `listSpaces?deleted=true` ile görür ve `POST .../restore` ile geri alır.
- 30 gün sonra `trash.purge` işi space'i içeriği ve blob referanslarıyla birlikte kalıcı siler.
- Space'te opsiyonel `description` ve `visibility` (`invite_only` | `org`) alanları var (tasarım 3.2).
  Keşfet listesi henüz yok.

### Ağaç, çöp, sürüm, kota

- `listNodes` klasörleri önce, sonra `sort` (`name` Türkçe sıralama, `updatedAt`, `size`, `type`) ile listeler;
  imleçlidir. Kök için `parentId` verilmez.
- Taşıma alt ağacın ltree yolunu tek UPDATE ile değiştirir; kendi altına taşıma `400 invalid_target`. Space'ler
  arası taşımada kişiye özel paylaşımlar kalkar, açık linkler çalışır (3.13). Kopyalama aynı blob'u paylaşır.
- Çöp: düğüm ve alt ağacı aynı `deletedAt` ile çöpe gider, birlikte geri gelir; üst klasör de çöpteyse köke
  döner, ad doluysa "(2)" eklenir. Çöpteki düğümün adı yeniden kullanılabilir. 30 gün sonra `trash.purge`
  (her gece 03:00) kalıcı siler; referansı kalmayan blob bir gün sonra depodan silinir. Kalıcı silme ve çöpü
  boşaltma `space.purge` (yönetici ve sahip) ister.
- Sürümler: her yükleme bir sürüm; en son 50 tutulur. `restoreVersion` eskiyi yeni sürüm olarak üste koyar.
- Kota mantıksal boyuttur (doküman 17 §8): her sürüm ve çöp dahil. Kişisel space 10 GB, ortak space sınırsız
  (yönetici `updateSpace.quotaBytes` ile koyar), kurum `settings.storageQuotaBytes` (yoksa sınırsız).
  Aşımda `413 quota_exceeded` (`details.scope` = `space` | `org`). `getQuota` `%90`'da `warning`, `%100`'de
  `full` döner. `quota.reconcile` her gece farkları düzeltir.

### Paylaşım ve herkese açık link

- **Link adresi sonradan da görülür (H16):**
  - Token iki biçimde saklanır: aramak için sha256'sı, gösterebilmek için `shares.token_enc` sütununda
    AES-256-GCM ile şifrelisi. Şifreleme anahtarı `AUTH_SECRET`'tan HKDF ile türetilir.
  - `listShares` linkin `url` alanını yalnız linki açana ve düğümde link paylaşma yetkisi olanlara
    döner.
  - **Migration notu (0015):** önceki linklerde `token_enc` boştur. Bu linkler çalışmaya devam eder,
    ama adresleri gösterilemez; listede `urlLost: true` gelir ve pencere "Yeni adres üret" önerir.
    Yeni adres üretilince eski adres çalışmaz olur.
  - `AUTH_SECRET` değişirse kayıtlı adresler okunamaz; linkler yine çalışır, yalnız gösterilemez.

- Etkin rol = space rolü ile düğümde ya da üstlerinde kişiye verilen paylaşımın büyüğü (`effectiveNodeRole`).
  Paylaşım yetkiyi yalnız genişletir; kimse kendi rolünden yüksek veremez. Kişi paylaşımı `space.share_user`
  (düzenleyen ve üstü), link `space.share_link` (yönetici; düzenleyen için space ayarı) ister.
- Link adresi `HUB_URL/s/<token>` yalnız `createShare` ve `regenerateShareLink` yanıtında gelir; sunucu token'ın
  özetini saklar. Web `/s/:token` sayfası `getPublicShare` çağırır:
  - Şifreli link: `{ status: "password_required" }` → `unlockPublicShare { password }` → `grant` (12 saat).
    Sonraki bütün herkese açık çağrılara `?grant=` eklenir. Yanlış şifre `401 share_password_invalid`
    (`details.remainingAttempts`), 5. hatada link + IP için 15 dk `423 share_locked`.
  - Süresi dolmuş link `410 share_expired` (`details.sharedByName`); iptal edilmiş, silinmiş ya da hiç olmayan
    link `404 not_found` (19.3).
  - Klasör linkinde `listPublicShareNodes`, dosya için `getPublicDownloadUrl` (indirme kapalıysa
    `403 forbidden`) ve `getPublicPreview`; paylaşılan klasörün dışına çıkılamaz.
- Denetim günlüğü: `share.user.create`, `share.link.create`, `share.update`, `share.delete`,
  `share.link.regenerate`, ilk açılışta `share.link.open`, `share.link.password_failed`, `share.link.locked`,
  ayrıca `node.move` (space'ler arası) ve `node.purge`.

### Hızlı erişim

- `listSurfaces`: önce "Benim", sonra üye olunan ortak space'lerin yüzeyleri (Türkçe ada göre). Yüzeyler ilk
  istekte oluşur. Space yüzeyini `space.edit_surface` (düzenleyen ve üstü) düzenler; izleyen yalnız görür ve
  `pinCard` ile kendi yüzeyine sabitler (kaynak değişince sabitlenen de değişir, kaynak kalkınca
  `sourceMissing`, `updateCard { detach: true }` bağımsız kopyaya çevirir).
- Kart türleri: `link`, `link_group`, `note`, `todo`, `node` (dosya ya da klasör; yetkisi olmayan kişide
  `node: null`, kart kilitli çizilir). Izgara 12 sütun; `layout` olmadan eklenen kart en alta gelir.
  Sürükle-bırak sonrası `updateSurfaceLayout { layoutRev, items, mobileOrder }`; eski `layoutRev` `409 conflict`.
- Linkler kurum genelinde tektir (aynı URL bir kez kontrol edilir). `previewLink` başlık ve favicon'u sunucudan
  bir kez çeker ve aynı URL'nin görünen kartlarını (`existingCardIds`) söyler.
- Sağlık kontrolü (worker döngüsü, 15 sn'de bir uygun linkleri alır; yalnız bir kartta görünen linkler):
  HEAD (desteklenmiyorsa GET), 10 sn zaman aşımı, en çok 5 yönlendirme. 2xx, 3xx, 401, 403 `up`; 1,5 sn
  üstü ya da 14 günden az kalan sertifika `warn`; diğerleri hata ve üst üste 3 hatada `down`. Varsayılan
  aralık 60 sn (`updateLink` ile 300 ya da 900). `checkLinkNow` hemen dener, `getLinkHistory` son kontrolleri
  ve erişilebilirlik oranını verir, `recordLinkOpen` "en çok açılan" sıralamasını besler.
- Kurum kendi sunucusunda çalıştığı için iç ağ adresleri de kontrol edilir (doküman 17 §10); SaaS'ta bu
  kapatılacak.
- Hata alan link, kırmızıya dönene kadar tam aralık yerine en çok 30 sn sonra yeniden denenir; böylece 3 ardışık
  hata 60 sn aralıkta yaklaşık 2 dakikada doğrulanır (Faz 1 ölçütü: en geç 4 dakika).

### Kabul betiği (faz-1.md "Bitti")

Çalışan bir yığına karşı Faz 1 ölçütlerini dener ve oluşturduğu her şeyi sonunda siler:

```bash
pnpm --filter @crewhall/backend accept:phase1 -- --env-file=.env
```

- 5 GB'lık dosyayı 16 MiB parçalarla yükler (baytlar üretilir, diske dosya yazılmaz), yarıda bağlantıyı keser,
  `getUpload` ile kaldığı yerden tamamlar; sha256'yı ve son baytları doğrular.
- Aynı içeriği iki kez yükler: depoda tek blob ve `ref_count` 2 olmalı.
- Yerelde açıp kapattığı bir HTTP sunucusunun linkinin en geç 4 dakikada `down` olduğunu ölçer (worker çalışmalı).
- Space ve kurum kotasının mantıksal boyut kadar arttığını kontrol eder.
- Ayarlar: `ACCEPT_API` (varsayılan `http://localhost:4100`), `ACCEPT_EMAIL`, `ACCEPT_PASSWORD`, `ACCEPT_TOTP`
  (varsayılan seed sahibi), `ACCEPT_SIZE_GB` (hızlı deneme için küçült). Doğrulama ve temizlik için `.env`'deki
  veritabanı ve S3 adreslerini kullanır.
- Not: Docker Desktop'ın WSL diski silinen veriden sonra kendiliğinden küçülmez; 5 GB'lık koşu makinede o kadar
  yer tüketebilir.

### Worker

- Üretimde ayrı süreç: `node --import ./dist/otel.js dist/worker.js` (compose'da `worker` servisi).
- Dev'de `WORKER_IN_PROCESS=true` (varsayılan) ile api süreci işleri kendisi çalıştırır; ayrıca worker
  başlatmaya gerek yoktur. Ayrı denemek için: `pnpm --filter @crewhall/backend dev:worker`.
- Kuyruk pg-boss'tur (`pgboss` şeması). İşler: `blob.process`, `preview`, `trash.purge` (03:00),
  `quota.reconcile` (03:30), `push.send`, `push.receipts` (15 dk'da bir), `chat.digest` (15 dk'da bir),
  `chat.cleanup` (04:00); link kontrolü aynı süreçte döngüyle çalışır.
- Ayrı worker süreci WS olaylarını (önizleme hazır, link durumu) Postgres `NOTIFY crewhall_bus` ile api'ye
  gönderir; api bunları kendi bağlı istemcilerine dağıtır.

## Faz 3: Chat, gerçek zamanlı akış, bildirimler

Sözleşme: `packages/shared/src/endpoints/chat.ts` (uçlar) ve `schemas/chat.ts` (şemalar, WS olayları,
`CHAT_LIMITS`, `CHAT_RAW_PATHS`). Doküman 17 §4, §6, §10; tasarım 04 ve 19.13-19.17.

### WebSocket (`/ws`)

- Bağlanma: önce `POST /api/v1/ws/ticket` (oturum gerekir), sonra `GET /ws?ticket=<bilet>`. Bilet tek
  kullanımlıktır ve 30 sn geçerlidir. Geçersiz bilette bağlantı `4401` koduyla kapanır.
- Yazma her zaman HTTP iledir. WS yalnız olay dağıtır. İstemcinin gönderdiği üç olay var:
  - `heartbeat {active, focused}`: 25 sn'de bir. Arka plandaki mobil `focused: false` gönderir. 62 sn
    sessiz kalan bağlantı `4408` ile kapanır.
  - `typing {conversationId}`: yalnız sohbet görünürken.
  - `presence.watch {userIds}`: ekranda gösterilen kişiler. Liste her seferinde baştan verilir.
- Sunucu olayları (`WsServerEvent`): `ready`, `message.created`, `message.updated`, `message.deleted`,
  `reaction`, `read`, `typing`, `presence`, `conversation.updated`, `conversation.removed`, `notification`,
  `notifications.changed`, `node.updated`, `link.status`, `resync`, `error`.
- Olaylardaki mesajlarda `reactions[].mine` her zaman `false` gelir, çünkü olay herkese aynıdır.
  İstemci bunu `userIds` listesinden hesaplar. HTTP yanıtlarında `mine` doğrudur.
- Yeniden bağlanınca sıra şöyledir: `GET /api/v1/me/unreads`, ardından açık sohbetler için
  `listMessages?afterSeq=<son görülen>`. Kaçırılan düzenleme, silme ve tepkiler için
  `listMessages?updatedAfter=<son bağlantı zamanı>`. Sohbet içinde `seq` boşluksuzdur: atlanan numara
  eksik mesaj demektir. `resync` gelirse aynı adımlar uygulanır.
- Bus süreç içidir (tek api düğümü). Ayrı worker süreci olayları `NOTIFY` ile api'ye iletir.

### Sohbet kuralları (kısaca)

- Türler:
  - `direct`: aynı çift için tek kayıt; ilk mesaja kadar karşı tarafın listesinde görünmez.
  - `group`: 3-50 kişi, adsızsa üyelerin adlarıyla anılır.
  - `space`: üyelik ve roller space'ten gelir.
  - `alert`: space'e bağlı ya da kişi listeli; webhook mesajları için.
  - `meeting` ve `card` türleri meet ve boards modüllerine bırakıldı.
- Yetkiler doküman 17 §5'e göredir:
  - Space sohbeti: İzleyen yazar; Düzenleyen ve üstü sabitler ve webhook ekler; Yönetici ve üstü
    başkasının mesajını siler ve arşivler.
  - Grup ve birebir: üyelik yeter.
  - Üye olmayan her istekte 404 alır, böylece sohbetin var olup olmadığı belli olmaz.
- Gönderim `clientMsgId` ile idempotenttir. Mention token'ları: `<@userId>`, `<@all>`, `<@here>`.
  `@all` ve `@here` yalnız 3+ kişilik sohbette çalışır. 20+ kişide `confirmMentionAll: true` gerekir,
  yoksa 409 `chat_mention_all_confirm` döner.
- Okunma yalnız ileri gider (GREATEST). `markConversationUnread` geri almanın tek yoludur. Okunan sohbetin
  o seq'e kadarki bildirimleri de okundu sayılır.
- Ekler, Drive yükleme akışıyla `getChatAttachmentFolder` klasörüne yüklenir:
  - Space sohbetinde `Ekler/<sohbet adı>` klasörüne gider. İzleyen space'e yazamadığı için onun
    dosyaları Kişisel `Chat ekleri` klasörüne düşer.
  - Birebir ve grupta gönderenin Kişisel `Chat ekleri` klasörüne gider.
  - Ek URL'si sohbet üyeliğiyle imzalanır (`getChatAttachmentUrl`). Mesaj silinince dosya çöpe gider ve
    URL 410 döner.

### Gelen webhook'lar

- `POST /api/hooks/<id>?key=<anahtar>` oturum istemez.
- Kabul edilen gövde biçimleri:
  - Crewhall: `{text?, card?}`. `card` alanı `AlertCard` şemasındadır (severity, title, fields,
    buttons).
  - Google Chat: `text` ve/veya `cardsV2`. Tanınmayan widget'lar metne indirgenir. Google Chat'te önem
    alanı olmadığı için severity metindeki kelimelerden tahmin edilir (FIRING, down, error → kritik;
    RESOLVED, recovered → başarılı).
- Anahtar yalnız sha256 olarak saklanır. Tam URL'yi yalnız oluşturma ve yeniden üretme yanıtı içerir.
- Sınırlar: dakikada 60 istek (aşınca 429 + `Retry-After`), gövde en çok 32 KB (aşınca 413).
- Her istek teslim günlüğüne yazılır; 30 günden eski satırlar gece silinir. Hatalı gövdenin ilk 2 KB'ı
  saklanır. Anahtar URL'de durduğu için günlüğe hiç girmez.
- Bir saatte 3 ret olursa oluşturan kişiye günde en çok bir `chat.webhook_failing` bildirimi gider.
- Sessize alınan webhook mesaj yazmaya devam eder ama bildirim üretmez.

### Bildirimler, push, özet

- **Açık sohbet (H8):**
  - İstemci heartbeat'e `activeConversationId` ekler. Bu heartbeat açılan sohbet ya da sekmenin
    görünürlüğü değişince hemen, sonra 25 sn'de bir gönderilir.
  - Kişinin görünür (focused) bir oturumunda o sohbet açıksa, oradan gelen mesaj için bildirim satırı
    hiç yazılmaz: zil, toast ve push çıkmaz. Mesaj WS'ten yine gelir; okundu ilerletmeyi istemci yapar.
  - Başka sohbetlerden gelen mesajlar normal bildirilir. Alanı göndermeyen eski istemcilerde davranış
    değişmez.

- Bildirim satırı olayla aynı transaction'da yazılır. Teslim commit'ten sonra yapılır: önce WS
  `notification`, sonra `push.send` işi.
- Tercihler kategori matrisindedir (`NotificationCategory`). `security` ve `portal` kategorilerinde
  uygulama içi ve e-posta kapatılamaz.
- Push hangi durumda gitmez:
  - Kişinin odakta bir oturumu varsa (`focused: true` ve taze heartbeat).
  - Meşgul durumundaysa.
  - Rahatsız etme ya da sessiz saatlerdeyse; kritik alarm bu ikisini deler.
- Aynı `groupKey`'e sahip push'lar 60 sn içinde tek gönderime iner. Okunmamış kritik alarm 5 dk sonra
  bir kez daha gönderilir.
- Push iki yoldan gider; yolu cihaz kaydındaki `provider` alanı belirler. Alan gönderilmezse token'dan
  çıkarılır: `ExponentPushToken[…]` Expo, başka her şey FCM sayılır.
  - **Expo:** Expo push servisine toplu gönderilir. Makbuzlar 15 dk sonra sorulur;
    `DeviceNotRegistered` dönen cihaz kapatılır.
  - **FCM (HTTP v1):** her cihaza `projects/{project_id}/messages:send` ile ayrı gönderilir.
    - Erişim jetonu servis hesabının anahtarıyla imzalanan JWT'den alınır ve süresi dolana kadar
      bellekte tutulur. 401 gelirse bir kez yenilenir.
    - `UNREGISTERED`, `NOT_FOUND` ya da `INVALID_ARGUMENT` dönen cihaz kapatılır.
    - 429 ve 5xx'te iş pg-boss ile yeniden denenir.
    - Android'de öncelik HIGH, kanal `default` (kritik alarmda `alerts`). iOS için `apns` alanları
      dolu; çalışması için APNs anahtarının Firebase'e yüklenmesi gerekir.
- **Push kararı ve tanılama:**
  - Sohbet düzeyinin varsayılanı (`defaultNotify`): birebir ve grup `all`, uyarı `critical`, space kanalı, toplantı ve kart `mentions`. Düzey üyelik satırına katılırken yazılır, yani varsayılanı değiştirmek eski satırları değiştirmez. Grup için `0074` göçü dokunulmamış satırları `all` yaptı; sessize alınmış, kişisel arşivdeki ya da düzeyi değiştirilmiş satırlar kaldı.
  - Kişi bir oturumun başındaysa push gitmez. Başında sayılmak için oturum görünür olmalı, kalp atışı 40 sn içinde gelmiş olmalı ve bilgisayarda son 2 dk içinde girdi olmalı. Görünür ama dokunulmayan sekme telefonu susturmaz. Ön plandaki telefon olduğu gibi sayılır, çünkü kendisi kilitlenir.
  - Aynı sohbetin push'ları 15 sn'lik pencerelerle gruplanır: ilki hemen gider, kalanlar pencere bitince birlikte gider; iş o an sohbetin en yeni satırını gönderir.
  - `notifications.push_skip` neden push istenmediğini, `push_outcome` her cihazın sağlayıcı yanıtını, `push_devices.disabled_reason` cihazı neyin kapattığını tutar. Yönetim › Üyeler › kişi › "Push tanılama" (`getPushDiagnostics`, `org.manage_members`) bunları ve o anki oturumları gösterir.
  - Açık sohbet ekranı yüzünden hiç satır oluşmayan mesajlar `debug` düzeyinde loglanır.
  - FCM `INVALID_ARGUMENT` cihazı yalnız hata jetonla ilgiliyse kapatır. Geçici hatalar (429, 5xx) artan beklemeyle 4 kez denenir ve yalnız almamış cihazlara gider.
  - Expo isteği reddederse (429 dışındaki 4xx, ör. `EXPO_ACCESS_TOKEN` eksikken 403) yeniden denenmez: sonuç `push_outcome`'a `http_<durum>` olarak yazılır. Expo 5xx ve 429 yeniden denenir.
- Push `data` alanı her iki yolda da `PushData { url, notificationId, type }` biçimindedir.
- FCM ayarı: `FIREBASE_SERVICE_ACCOUNT_FILE` (dosya yolu, geliştirme) ya da
  `FIREBASE_SERVICE_ACCOUNT_JSON` (içerik, üretim). İkisi de yoksa FCM cihazlarına push gitmez.
  Servis hesabı dosyası repo dışında durur; içeriği log'a ya da hataya yazılmaz.
- **iOS VoIP (CallKit, sözleşme `meet.voipPush`):** gelen arama iPhone'da kilit ekranında gerçek
  arama ekranı olarak çalsın diye APNs'e doğrudan gider (Expo VoIP göndermez).
  - Mobil, Expo jetonunun yanında PushKit jetonunu `registerPushDevice` ile `provider: 'voip'`
    olarak kaydeder (`platform: 'ios'`, hex jeton). Bu cihaz yalnız aramalarda kullanılır.
  - `meet.call` push'unda kişinin VoIP cihazlarına `VoipPush` (`type: 'meet.call'`) gider:
    HTTP/2, `apns-push-type: voip`, topic `<APNS_BUNDLE_ID>.voip`, öncelik 10,
    `apns-expiration` çalmanın bittiği an. En az bir iPhone aldıysa o kişinin iOS cihazlarına
    sıradan push gitmez; arama bir kez görünür. APNs ayarlı değilse ya da gönderim olmazsa iPhone
    sıradan push'u alır.
  - Arama başka cihazda açılınca, reddedilince, iptal ya da cevapsız kalınca VoIP ile
    `meet.call_end` gider. Yalnız VoIP ile çalan cihazlara gider (Apple kuralı: her VoIP push
    CallKit'e bildirilir). `reason` CallKit'in bitiş sebebidir: `answered_elsewhere`, `declined`,
    `cancelled`, `missed`.
  - `declineUrl`: oturumsuz reddetme (`declineCallSigned`). AUTH_SECRET'tan türeyen anahtarla
    imzalı jeton aramayı ve kişiyi taşır, çalma bitiminden 1 dk sonra geçersiz olur.
  - Kimlik doğrulama: .p8 anahtarıyla imzalı ES256 JWT, 50 dk'da bir yenilenir. Kaynak başına bir
    HTTP/2 oturumu açık tutulur.
  - 410 ya da `BadDeviceToken` / `DeviceTokenNotForTopic` dönen cihaz kapatılır. Geçici hatada
    (429, 5xx) yeniden denenmez; ikinci çalma CallKit'e iki kez bildirilirdi. Sıradan push yedektir.
  - Ayarlar: `APNS_KEY_PATH` ya da `APNS_KEY_P8` (içerik, `
` kaçışları olabilir),
    `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV` (`production`: TestFlight ve
    App Store; `sandbox`: development derlemeleri). Biri eksikse VoIP kapalıdır. Anahtar log'a
    yazılmaz.
  - Ortam cihaz başınadır: mobil VoIP jetonunu `apnsEnvironment: 'sandbox' | 'production'` ile kaydeder
    (development derlemesi sandbox, TestFlight ve App Store production). Söylemeyen cihaza önce
    `APNS_ENV` denenir; Apple `BadDeviceToken` derse bir kez diğer sunucu denenir. Çalışan ortam cihaza
    yazılır, ikisi de reddederse cihaz kapatılır. Ortamı bilinen cihaz yalnız kendi sunucusuna gider. Her
    sunucuya tek HTTP/2 oturumu açılır.
  - Deneme: `crewhall voip-test --email <e-posta>` kişinin iPhone'larına sahte bir arama gönderir
    ve sonucu cihaz cihaz yazar; çıktıdaki kimlikle `--end <id>` aramayı kapatır. Geliştirmede:
    `pnpm --filter @crewhall/backend exec tsx --env-file=.env src/scripts/crewhall.ts voip-test …`.
- Testlerde `EXPO_PUSH_URL` ve `FCM_API_URL` stub sunuculara yönlendirilir. APNs testleri
  `APNS_URL` ile şifresiz HTTP/2 sahte sunucuya gider ve her koşuda üretilen bir P-256 anahtarı
  kullanır. FCM testleri her koşuda
  üretilen geçici bir anahtar kullanır; Google'a istek gitmez.
- E-posta özeti saatlik ya da günlük (yerel saatle 08:30) gönderilir. Yalnız 30 dk'dan uzun süredir
  okunmamış bildirimleri içerir, okunacak bir şey yoksa e-posta gitmez.

### Chat dev ortamı (bu oturum)

- Api 4401'de, veritabanı `crewhall_chat` (localhost:4132). `.env` dosyası ignore'lu yerel dosyadır:
  `PORT=4401`, `HUB_URL=http://localhost:4411`, `S3_BUCKET=crewhall-chat`.
- Seed örnek sohbetleri de kurar: Milvaion Ekibi, Altyapı, Elif ile birebir, Selin–Can grubu ve
  Prod Alarmları + Seq webhook'u. Webhook URL'si seed çıktısında yazar.
- Yerel teslim süresi (test, 60 mesaj): p50 ≈ 29 ms, p95 ≈ 55 ms.

## Profil fotoğrafı ve marka görselleri (H5)

- **Uçlar:**
  - `uploadAvatar` (`POST /api/v1/me/avatar`) ve `deleteAvatar` profil fotoğrafı içindir.
  - `uploadBrandAsset` (`POST /api/v1/org/branding/assets`, yetki: `org.update_branding`) ve
    `deleteBrandAsset` (`DELETE /api/v1/org/branding/assets/:slot`) marka görselleri içindir.
- **Gövde:** `ImageUpload { data (base64 ya da data URL), crop? }`.
  - Kabul edilen türler JPEG, PNG, WebP, GIF ve AVIF; SVG reddedilir. Sınır 8 MB ve 50 megapiksel.
  - `crop`, orijinal görselin piksellerinde bir karedir.
- **İşleme (sharp):** önce EXIF yönü düzeltilir.
  - Profil fotoğrafı 512×512 JPEG olur (e-postada WebP güvenli değil).
  - Logolar 1024×256'ya sığdırılır (PNG).
  - Amblem 512 px, favicon 64 px kare olur (PNG).
- **Sunum:** dosyalar S3'te `assets/` altında, kayıtları `media_assets` tablosundadır (migration 0016).
  `GET /api/assets/:assetId` oturum istemez (giriş sayfası ve e-postalar için) ve bir yıl
  önbelleklenir (`immutable`). Görsel değişince ya da kaldırılınca eski dosya silinir.
- **Marka akışı:** marka görselleri taslağa girmez, yüklenince hemen uygulanır. Yanıt güncel
  `Branding`'dir.

## Bildirim gönderimi (kurum ayarı: SMTP, FCM, Notifike)

- **Uçlar** (`org.update_settings`, sahip ve yönetici):
  - `getDeliverySettings` (`GET /api/v1/org/delivery`)
  - `updateDeliverySettings` (`PATCH`, kısmi)
  - `testDelivery` (`POST /api/v1/org/delivery/test`, `{ channel: email|push, to? }`)

  Güncelleme ve test denetim kaydına yazılır (`org.delivery.update`, `org.delivery.test`). Şifrelerin
  yalnız alan adı kaydedilir.
- **Kipler:**
  - E-posta: `env` (sunucunun SMTP_URL'i), `smtp` (kurumun sunucusu) veya `notifike`.
  - Push: `env` (FIREBASE_*, EXPO_*), `direct` (kurumun Firebase servis hesabı ve isteğe bağlı Expo jetonu)
    veya `notifike`.
  - Satır yoksa iki kanal da `env`'dir; mevcut kurulumlar etkilenmez.
- **Sırlar:** SMTP şifresi, servis hesabı JSON'u, Expo jetonu ve Notifike anahtarı AI anahtarı gibi
  şifrelenir (`delivery_settings`, migration 0044). Yanıtta yalnız `{ set, hint, updatedAt }` döner;
  `hint` yalnız Notifike anahtarının son dört karakteridir.
- **Kip kuralları:** eksik alanla kip seçmek 422 döner. `smtp` için host, port ve from gerekir; `direct` için
  servis hesabı; `notifike` için URL ve anahtar.
- **Notifike:** `POST {baseUrl}/api/v1.0/notifications/send`, `X-Api-Key` başlığıyla. Gövde camelCase,
  enum'lar sayıdır (Notifike.Contracts istemcisiyle aynı).
  - Yinelemeye karşı alıcı `externalId`'si kullanılır (`<bildirim>:<p|r>:<cihaz>`); entegrasyon ucu
    Idempotency-Key almaz.
  - E-posta: hazır HTML `body` olarak gider, takvim daveti `.ics` eki olur. Gönderen adresi ve adı
    Notifike'deki sağlayıcı hesabından gelir.
  - Push: Notifike yalnız FCM jetonlarına gider; Expo jetonları her kipte Expo'ya gider. Arama zili ve
    `meet.call_end` `pushKind: 2` (Silent) ve `priority: 9` ile veri olarak gider.
  - Dönen `messageId` `push_tickets` tablosuna yazılır (`provider = 'notifike'`). `push.receipts` işi
    durumları `PATCH notifications/statuses` ile okur ve başarısızlığın `lastError`'ını kaydeder.
  - Hatalar `delivery_unauthorized` (401/403), `delivery_rate_limited` (429), `delivery_rejected` (diğer
    4xx) ve `delivery_provider_error` (5xx, ağ) kodlarına çevrilir. `delivery_rejected` dışındakiler
    yeniden denenebilir; push işi pg-boss ile yeniden çalışır. 401/403'te `notifike.authFailedAt` dolar,
    ilk ret denetim kaydına (`org.delivery.auth_failed`) ve loga yazılır, anahtar ya da URL
    değişince temizlenir.

## Dışarı istekler (SSRF koruması)

Sunucunun, kişilerin yazdığı adreslere attığı istekler `src/net/outbound.ts` üzerinden gider:

- Kapsam:
  - Hızlı erişimde link başlığı ve favicon;
  - link sağlık kontrolü (HTTP ve TLS sertifika okuması);
  - otomasyon webhook'u;
  - federasyon keşfi ve gelen kutusu.
- Kurallar:
  - Yalnız http/https; port 80 ve 443 (başkası `OUTBOUND_ALLOWED_PORTS` ile).
  - Ad bir kez çözümlenir. Her cevap kontrol edilir: loopback, RFC1918, link-local/metadata, CGNAT, ULA,
    multicast, ayrılmış aralıklar ve IPv4-mapped IPv6. Bağlantı kontrol edilen adrese sabitlenir (DNS
    rebinding).
  - Her yönlendirme yeniden kontrol edilir.
  - Zaman aşımı ve gövde boyutu sınırı vardır.
- **İzin listesi:** `PRIVATE_FETCH_ALLOWLIST`, virgülle ayrılmış liste. Öğeler CIDR (`10.0.0.0/8`), host
  (`wiki.lan`) ya da `*.corp.example` olabilir. Listedekiler iç adrese ve her porta gidebilir. Varsayılan
  boştur.
- **Sağlık kontrolü:** iç adres (izin listesinde değilse) "kontrol edilemiyor" sayılır: `status: unknown`,
  `reason: internal`. Hata sayılmaz, kırmızıya dönmez.
- **Kapsam dışı:** yöneticinin ayarladığı entegrasyonlar bu korumadan geçmez, çünkü iç ağda olmaları
  beklenir. Bunlar yapay zekâ sunucusu ve konuşma tanıma, Notifike, OIDC sağlayıcısı, portal revalidate,
  FCM/Expo, S3 ve collab'dır.
- **Bilinen boşluk:** posta (IMAP/SMTP) sunucusu bağlantıları da bu korumanın dışındadır.

## Postgres sürümleri ve yedek araçları

- **Desteklenen sunucu:** PostgreSQL 17 ve 18. Geliştirme ve testler 17 ile çalışır (`postgres:17`); test
  sunucusunun ortak `postgredb`'si 18'dir.
- **Yedek araçları 18'dir:** pg_dump ve pg_restore iki yoldan gelebilir. Seçimi `CREWHALL_PG_TOOLS` yapar:
  - `local`: backend imajındaki `postgresql18-client` (Alpine 3.24);
  - `docker`: `postgres:18` imajı (`dockerPgTools`).

  pg_dump kendinden yeni bir sunucuyu dökemez; 18, 17 ve daha eski sunucuları döker. pg_restore 18'in 17
  sunucuya geri yüklemesi testte doğrulanır (`ops-backup.test.ts`).
- **Sürüm kontrolü:** her yedek, döküme başlamadan pg_dump'ın ana sürümünü (`pg_dump --version`) sunucunun
  `server_version_num` değeriyle karşılaştırır.
  - İstemci eskiyse yedek hiçbir şey yazmadan başarısız olur: "pg_dump 17 is older than the PostgreSQL 18
    server…". Denetim kaydına `backup.tools_outdated` düşer.
  - Yönetim › Yedekler `pgTools: { client, server, compatible }` ile uyarı gösterir. Değer 10 dakika
    önbelleklenir.
- **Postgres 19 geldiğinde:** imajdaki istemci paketi ve `PG_TOOLS_IMAGE` aynı sürüme çıkarılır.

## Sürüm uyumu (sunucu ve uygulamalar)

Kurumlar sunucularını kendi takvimlerinde günceller; mobil ve masaüstü bağlandıkları sunucuya uyar.
Ortak tanımlar `packages/shared/src/compat.ts` dosyasındadır.

- **bootstrap.server** artık şunları da içerir:
  - `apiLevel`: tamsayı (`API_LEVEL`), her sözleşme eklemesinde bir artar.
  - `capabilities`: `CAPABILITIES` listesinden, kurumda açık modüllere göre süzülür.
  - `minClientVersion { ios, android, desktop }`.
- **Asgari sürüm:** env `MIN_CLIENT_IOS`, `MIN_CLIENT_ANDROID` ve `MIN_CLIENT_DESKTOP` belirler. Boşsa iOS ve
  Android için `MIN_MOBILE_VERSION`, o da yoksa `MIN_CLIENT_DEFAULTS` (0.0.0) geçerlidir. Güncelleme
  bağlantıları `CLIENT_STORE_URL_*` ile verilir.
- **Uygulama kimliği:** `X-Crewhall-Client: <ios|android|desktop|web>/<semver>` başlığı.
  - Asgari sürümün altındaki uygulama bootstrap, `getCompat` ve `/api/auth/*` dışındaki her `/api` isteğinde
    `426 client_outdated` alır. `details` alanı `{ platform, min, current, storeUrl? }` taşır.
  - bootstrap aynı sonucu `clientStatus: 'ok' | 'outdated'` olarak verir.
  - Başlıksız istekler (web, eski uygulamalar), bozuk başlık ve `web` hiç engellenmez.
- **`getCompat`** (`GET /api/v1/meta/compat`, herkese açık): sürüm, `build`, `commit`, `apiLevel`, `minClientVersion`, `storeUrls`
  ve kaldırılacak uç ve alanların listesi.
- **Kaldırma işareti:** uçta `deprecated: { since, removeAfter, replacement? }` olarak, alanda
  `DEPRECATED_FIELDS` listesinde tutulur. İşaretli uç `Deprecation: @<unix>` ve `Sunset: <HTTP tarihi>`
  başlıklarıyla yanıt verir; ikisi de CORS'ta açıktır.
- **Sözleşme kuralı:** `packages/shared/contract-snapshot.json` son sürümün sözleşmesidir (uç başına bir
  satır). `pnpm --filter @crewhall/shared lint` (CI lint aşaması) şu durumlarda hata verir:
  - uç silinmişse, yöntemi, yolu ya da yetkisi değişmişse;
  - yanıt alanı silinmiş, opsiyonel ya da `null` olabilir hale gelmiş ya da tipi değişmişse;
  - istekte yeni zorunlu alan eklenmiş, opsiyonel alan zorunlu olmuş ya da enum değeri kaldırılmışsa;
  - bir yetenek (capability) kaldırılmışsa;
  - ekleme yapılmış ama `API_LEVEL` artırılmamışsa.

  Yeni uç, opsiyonel alan, enum değeri ve hata kodu eklemek serbesttir. `removeAfter` tarihi geçmiş
  işaretli uç ya da alan silinebilir. Sürüm çıkarken `pnpm --filter @crewhall/shared contract:write`
  çalıştırılır.

## curl ile deneme

```bash
O="Origin: http://localhost:5173"; J=/tmp/crewhall.jar

# 1) Kurulum (seed çalıştırmadıysan). Türkçe karakterler için gövdeyi UTF-8 dosyadan gönder.
curl -s localhost:3000/api/v1/bootstrap
curl -s -X POST localhost:3000/api/v1/setup -H 'Content-Type: application/json' --data-binary @setup.json
#   setup.json: {"org":{"name":"Milvasoft","slug":"milvasoft","defaultLocale":"tr"},
#                "owner":{"name":"Ahmet Buğra Kösen","email":"bugra@milvasoft.com","password":"Crewhall-dev-2026"}}

# 2) Giriş → 2FA ister mi?
curl -s -c $J -b $J -X POST localhost:3000/api/auth/sign-in/email -H "$O" -H 'Content-Type: application/json' \
  -d '{"email":"bugra@milvasoft.com","password":"Crewhall-dev-2026"}'
#   seed'li sahip: {"twoFactorRedirect":true,...}

# 3a) Seed'li hesapta TOTP doğrula
curl -s -c $J -b $J -X POST localhost:3000/api/auth/two-factor/verify-totp -H "$O" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$(pnpm --silent --filter @crewhall/backend totp)\"}"

# 3b) Yeni kurulan sahipte önce TOTP kur (kurulana kadar kurum uçları two_factor_required döner)
curl -s -c $J -b $J -X POST localhost:3000/api/auth/two-factor/enable -H "$O" -H 'Content-Type: application/json' \
  -d '{"password":"Crewhall-dev-2026"}'                       # → totpURI, backupCodes
curl -s -c $J -b $J -X POST localhost:3000/api/auth/two-factor/verify-totp -H "$O" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$(pnpm --silent --filter @crewhall/backend totp '<totpURI>')\"}"

# 4) Uygulama uçları
curl -s -b $J localhost:3000/api/v1/me
curl -s -b $J localhost:3000/api/v1/spaces
curl -s -b $J -X POST localhost:3000/api/v1/spaces -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-1' -d '{"name":"Deneme","color":"s2"}'
```

## Testler

```bash
pnpm turbo run typecheck lint test
pnpm --filter @crewhall/backend test          # Testcontainers: Docker açık olmalı
```

Backend testleri her çalıştırmada Testcontainers ile `postgres:17` ve `chrislusf/seaweedfs` kaldırır, production migration'larını
uygular ve uygulamayı `app.request` ile çağırır; yanıtlar `@crewhall/api-client` üzerinden sözleşme
şemalarıyla doğrulanır. CI'da hazır servisler varsa `TEST_DATABASE_URL` / `TEST_S3_ENDPOINT` verilince konteynerler atlanır. Hata ayıklarken `TEST_LOG_LEVEL=error` sunucu loglarını açar.

## Üretim iskeleti

`docker/compose.yml` (caddy, web, backend, worker, postgres, seaweedfs) ve `docker/Caddyfile`. Değişkenler
`docker/.env.example`'da. Backend imajı: `docker build -f apps/backend/Dockerfile -t crewhall/backend .`
(kökten). İlk açılışta kurulum anahtarı `docker compose logs backend` çıktısında yazar. Worker aynı imajla
`node --import ./dist/otel.js dist/worker.js` komutuyla çalışır (Faz 0'da pg-boss iskeleti).
