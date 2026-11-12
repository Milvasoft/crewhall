# Eklentiler ve merkezi pazar yeri

Üçüncü taraflar ve kurumların kendi geliştiricileri Crewhall'a sekme, ana sayfa kartı, sohbet komutu,
asistan aracı ve olay aboneliği ekler. Pazar yeri **merkezidir**: Crewhall ekibi işletir, bütün kurulumlar
eklentiyi oradan kurar. Kararların gerekçesi `kararlar.md` › 2026-10-29 · Eklenti SDK'sı ve merkezi pazar yeri.

| Parça | Yer |
| --- | --- |
| SDK (manifest, imza, köprü, sunucu yardımcıları, CLI) | `packages/plugin-sdk` (`@crewhall/plugin-sdk`, MIT) |
| Pazar yeri servisi | `apps/marketplace` |
| Crewhall tarafı | `apps/backend/src/services/plugins`, `apps/web` › Yönetim › Eklentiler |
| Örnek eklenti | `apps/plugin-hello` |

## İlke: Crewhall eklenti kodu çalıştırmaz

- Eklentinin arayüzü kendi sunucusundan gelir ve korumalı bir iframe'de açılır.
- Mantığı da kendi sunucusunda çalışır.
- Crewhall'ın sakladığı tek şey pazar yerinin imzaladığı manifesttir. Ayrıca kurulum sırrını ve yöneticinin
  onayladığı izinleri tutar.

## Manifest

`PluginManifest` (SDK, `manifest.ts`):

| Alan | Açıklama |
| --- | --- |
| `manifestVersion` | Şimdilik `1` |
| `id` | Ters alan adı: `com.acme.whatsapp`. Pazar yerinde ilk yükleyen sahiplenir. |
| `version` | Semver. Her yükleme bir öncekinden büyük olmalı. |
| `name`, `description` | Düz metin ya da `{ tr, en }` |
| `notificationName` | İsteğe bağlı, düz metin ya da `{ tr, en }`. Bildirimlerde kaynak olarak görünen kısa ad ("WhatsApp"). Yoksa tek sekmenin başlığı, o da yoksa `name`. |
| `publisher` | `name`, isteğe bağlı `url`, `email` |
| `apiLevel` | `{ min, max? }`. Crewhall `PLUGIN_API_LEVEL = 2`. Düzey 2: `board.card.changed` olayı, `offline:access` izni. |
| `origin` | Eklenti sunucusu, ör. `https://wa.acme.com`. Bütün yollar bunun altındadır. `http` yalnız localhost'ta geçer. |
| `hosting` | `hosted` (varsayılan): yayıncının tek sunucusu. `self`: her kurum kendi kopyasını çalıştırır; `origin` incelenen başvuru kurulumudur (bkz. Kendi sunucusunda). |
| `permissions` | Kişisel token ve MCP kapsamlarıyla aynı küme: `hub:read`, `chat:send`, `drive:write`… |
| `browser` | API 32: çerçevelerin isteyebileceği tarayıcı yetenekleri: `microphone`, `camera`, `geolocation`, `clipboard-write`. Her biri yöneticinin onayını ister (bkz. Tarayıcı yetenekleri). |
| `entryPoints.tabs` | `{ id, title, icon?, url, placement: 'rail' \| 'chat', mobile }`. Ray modülü ya da sohbet kenar çubuğunda sekme. `mobile` (varsayılan `true`) mobil uygulamada da gösterir. |
| `entryPoints.cards` | `{ id, title, url, size: 's' \| 'm' \| 'l', mobile }`. Kişisel ana sayfanın altında kart; `mobile` mobil ana sayfada da. |
| `entryPoints.commands` | `{ name, description, url }`. Sohbette `/name`. Yerleşik komutlar adı geçerse önce gelir. |
| `entryPoints.tools` | `{ name, description, inputSchema, url, write }`. Asistana `plugin.<id>.<name>` olarak görünür. |
| `entryPoints.events` | `{ type, url }`. `message.created`, `node.created`, `node.updated`, `member.joined` ya da `board.card.changed`. `hub:read` ister. |
| `lifecycle.url` | Kurulum, güncelleme ve kaldırma bildirimleri. Varsayılan `/crewhall/lifecycle`. |

Doğrulama: `pnpm --filter @crewhall/plugin-sdk plugin validate manifest.json`.

## İmzalı paket

- **Paket:** `{ manifest, review, signature }`. `review` şunları taşır:
  - `risk`: `official`, `verified` ya da `unofficial`;
  - `riskNote`: `unofficial` için zorunlu;
  - `reviewedAt`;
  - `audience`: kurum içi eklentide izin verilen kurulum alan adları, değilse `null`.
- **İmza:** pazar yeri `{ manifest, review }` nesnesinin kanonik JSON'unu Ed25519 ile imzalar. Kanonik JSON'da
  anahtarlar sıralıdır ve boşluk yoktur.
- **Kurulumda ve her güncellemede Crewhall şunları denetler:**
  - imza `MARKETPLACE_PUBLIC_KEYS` içindeki bir anahtarla doğrulanıyor;
  - manifest istenen kimlik ve sürüm;
  - `apiLevel` aralığı bizimkini kapsıyor;
  - `audience` varsa kendi alanımız içinde.

  Biri tutmazsa paket saklanmaz. İmzasız kurulum yoktur.

## Kurulum, güncelleme, kaldırma (Yönetim › Eklentiler)

1. **Katalog:** yönetici pazar yerinin katalogunu görür (`GET /v1/catalog?installation=<alan>`).
   - Katalogda yalnız herkese açık eklentiler ve kuruma özel olup izin listesinde bu kurulumun olduğu eklentiler
     görünür.
   - Listelenmemiş eklenti "ID ya da bağlantıyla kur" ile bulunur (API 30, `lookupPlugin`, `plugins.lookup`).
     Yönetici eklenti kimliğini ya da pazar yerinin kurulum bağlantısını (`https://<pazar yeri>/p/<id>`) yapıştırır.
   - Başka bir alan adındaki bağlantı `plugin_link_invalid` alır: paketler yalnız `MARKETPLACE_URL`'den gelir.
   - Kurulu eklentilerin güncellemesi katalogda yoksa ayrıntı ucundan tek tek sorulur.
2. **Onay:** kurulum ekranında izinler, giriş noktaları, eklentinin kökeni ve `unofficial` ise risk notu görünür.
   Her izin bir onay kutusudur, hepsi işaretli gelir. Yönetici istenenlerin **herhangi bir alt kümesini** verebilir
   (API 26, `plugins.partial`). İstenmeyen bir izin `plugin_permissions_mismatch` alır.
3. **Kayıt:** Crewhall paketi doğrular ve rastgele bir kurulum sırrı üretir. Sır `AUTH_SECRET`'tan türetilen
   anahtarla AES-GCM şifreli saklanır.
4. **Bildirim:** eklentiye `POST {origin}{lifecycle.url}` gider: `{ type: 'install', installationId, apiUrl, org,
   pluginVersion, permissions, secret }`. Bu istek de aynı sırla imzalıdır. Eklenti 2xx dönmezse kurulum geri alınır.
5. **Güncelleme:** yeni sürüm ek izin istiyorsa yönetici yalnız **yeni istenenler** için yeniden sorulur.
   `acceptPermissions` bunlardan hangilerinin verildiğini söyler; `[]` hiçbirini vermez. Alan yoksa
   `plugin_permissions_changed` döner ve eski sürüm kalır. Daha önce verilmeyen izinler verilmemiş kalır. Artık
   istenmeyen izinler düşer.
6. **İzinleri sonradan değiştirme:** kurulu satırdaki "İzinler" düğmesi.
   - `updatePluginInstallation { permissions }` verilen kümeyi kurulu sürümün istediklerinin bir alt kümesine
     çevirir.
   - Eklentiye `update` yaşam döngüsü isteği yeni `permissions` ile gider. Sonraki oturum tokenları yeni kapsamı
     taşır.
   - Denetim kaydı `plugin.permissions`.
   - `PluginInstallation.permissions` verilenleri, `requestedPermissions` istenenleri gösterir. Arayüz verilmeyenleri
     üstü çizili gösterir.
7. **Kapatma ve kaldırma:**
   - Kapatma: sekmeler, kartlar ve komutlar kaybolur; tokenlar `plugin_disabled` alır.
   - Kaldırma: eklentiye `uninstall` gider ve kayıt silinir.

Her adım denetim kaydına yazılır: `plugin.install`, `plugin.upgrade`, `plugin.permissions`, `plugin.enable`,
`plugin.disable`, `plugin.uninstall`, `plugin.command`.

**Eklenti neyin verildiğini nereden bilir:**

- kurulum ve güncelleme isteğindeki `permissions` alanından;
- oturum tokenının `scope` iddiasından;
- köprü bağlamındaki `permissions` alanından.

Verilmeyen bir izne dayanan özelliği gizlemeli. Crewhall o izni isteyen çağrıyı `403 token_scope` ile reddeder. Konuklar eklenti görmez.

## Köprü (iframe ↔ Crewhall)

- **iframe ayarları:** `sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-same-origin"`,
  `referrerpolicy="no-referrer"`. `allow-same-origin` eklentinin **kendi** kökeni içindir; Crewhall'ın kökenine
  erişim vermez.
- **İleti akışı:** iletiler `postMessage` ile gider. Crewhall yalnız manifestteki `origin`'den ve kendi iframe'inin
  `contentWindow`'undan gelen iletiyi işler. Eklenti de yalnız `init` gönderen pencereyle konuşur.
- **SDK:** eklenti sayfası `connect()` çağırır, Crewhall web'i `attachHost()` kullanır.
- **Açılan bağlantılar:** sandbox'ta `allow-popups-to-escape-sandbox` vardır. Eklentinin açtığı bağlantı (harita,
  paylaşılan sayfa) yeni sekmede normal açılır. Açılan sekmenin `opener`'ı eklenti çerçevesidir, Crewhall'ın
  penceresi değil; eklenti yine `noopener` kullanmalıdır.

### Tarayıcı yetenekleri (API 32, `plugins.browser`)

- **İstek:** manifestin `browser` listesi. Yönetici kurulumda ve güncellemede bunları izin gibi görür;
  kısmi onay geçerlidir.
- **Onay alanları:**
  - Kurulum: `InstallPlugin.browser`. Gönderilmezse hiçbiri verilmez.
  - Sonradan: `UpdatePluginInstallation.browser`.
  - Güncelleme: yeni istenenler için `UpgradePlugin.acceptBrowser`. Yoksa `plugin_permissions_changed`
    `{ addedBrowser }` döner.
- **Yetki devri:** yalnız verilenler çerçeveye devredilir, her biri yalnız kurulumun etkin kökenine (kendi
  sunucusundaki kopyada o kurumun adresi).
  - Web: iframe `allow="microphone <origin>; geolocation <origin>"` (SDK `frameAllow`).
  - Hiçbiri verilmemişse `allow` boştur. Önceden herkese açık olan `clipboard-write` artık yalnız istenip
    verilince gelir.
- **Kişinin onayı:** ayrıca istenir; tarayıcının kendi istemi her zamanki gibi çıkar.
- **Eklentinin öğrendiği:** verilenler yaşam döngüsü isteğinde (`browser`), köprü bağlamında (`browser`) ve
  `PluginSurface.browser`'da gelir. Verilmeyen bir özelliği gizlemelidir.
- **Mobil:** WebView, `PluginSurface.browser`'a göre mikrofon, kamera ve konum isteklerini yalnız kurulumun
  kökeni için kabul eder (mobil reposu).
- **Masaüstü:** Electron'un izin işleyicisi şimdilik yalnız sunucunun kendi kökenine izin veriyor. Eklenti
  çerçevesinin isteği orada reddedilir; masaüstü oturumunda ayrıca ele alınmalı.

| İleti | Yön | İçerik |
| --- | --- | --- |
| `ready` | eklenti → Crewhall | Sayfa hazır |
| `init` | Crewhall → eklenti | `BridgeContext`: eklenti, kurulum, yerleşim (`rail`, `chat`, `card`), kişi, kurum, dil, tema, `platform` (`web` \| `mobile`), verilen `permissions` |
| `request: token` | eklenti → Crewhall | 5 dakikalık oturum tokenı |
| `request: navigate` | eklenti → Crewhall | Crewhall içi yol, ör. `/chat/c/<id>` |
| `request: toast` | eklenti → Crewhall | Bildirim metni |
| `request: resize` | eklenti → Crewhall | Kart yüksekliği (sınırlanır) |
| `request: offlineAccess` | eklenti → Crewhall | `status`, `grant` (Crewhall'ın onay penceresi), `revoke`. Yanıt `{ granted }`. Yalnız web. |
| `theme` | Crewhall → eklenti | Açık/koyu, vurgu rengi |

### Mobil uygulamada (API 26, `plugins.mobile`)

Mobil uygulama sekmeleri ve kartları `react-native-webview` içinde açar. İleti biçimi web ile aynıdır, yalnız
taşıma farklıdır.

Uygulama tarafı için SDK `createNativeHost({ context, handlers, send })` verir (`@crewhall/plugin-sdk/bridge`,
DOM tipi istemez):

- `onMessage` içinde `host.receive(event.nativeEvent.data)` çağrılır;
- `send` kendisine verilen betiği `webview.injectJavaScript` ile çalıştırır;
- `host.setTheme` tema değişince çağrılır.

Doğrulama ve yanıtlar web'deki `attachHost` ile aynı koddan geçer.

- **Eklentiden uygulamaya:** SDK `window.ReactNativeWebView` varsa iletiyi
  `ReactNativeWebView.postMessage(JSON.stringify(ileti))` ile gönderir. Uygulama `onMessage` içinde
  `JSON.parse(event.nativeEvent.data)` yapar.
- **Uygulamadan eklentiye:**
  - Uygulama `webview.injectJavaScript` ile sayfada `window.dispatchEvent(new MessageEvent('message', { data:
    '<JSON metni>' }))` çalıştırır.
  - Android için aynı olay `document` üzerinde de dinlenir.
  - SDK kaynağı (`source`) olan iletileri yok sayar. Yalnız uygulamanın enjekte ettiği, kaynaksız iletiler geçer.
  - Metin gelen veri JSON olarak çözülür.
- **Köken denetimi:** uygulama yalnız manifestteki `origin` altındaki sayfayı yükler. Başka kökene gidişi
  `onShouldStartLoadWithRequest` ile tarayıcıya yollar. `onMessage`'da da `event.nativeEvent.url` kökenini
  denetler.
- **Bağlam ve yüzeyler:**
  - `init` bağlamında `platform: 'mobile'` vardır.
  - Token, `navigate`, `toast` ve `resize` istekleri aynıdır. `navigate` uygulama içi yola çevrilir.
  - Yalnız `mobile: true` olan sekme ve kartlar gösterilir.

## Kimlik ve API erişimi

- **Oturum tokenı:** EdDSA imzalı bir JWT, ömrü 5 dakika. Başlıkta `typ: crewhall-plugin+jwt` vardır. İddialar:
  - `iss`: kurulumun API kökeni;
  - `aud`: eklenti kimliği;
  - `sub`: kişi;
  - `org`, `inst`, `name`, `email`;
  - `scope`: kurulum izinleri.

  JWKS adresi `{apiUrl}/api/plugins/v1/jwks`.
- **Eklenti sunucusu tokenı doğrular:** `verifySessionToken(token, { issuer: installation.apiUrl, audience:
  manifest.id })`. Issuer, kurulum isteğindeki `apiUrl` olmalıdır. Başka kurulumdan ya da başka eklentiye kesilmiş
  token reddedilir.
- **Aynı token Crewhall REST API'sini açar:**
  - kapsam haritası kişisel tokenlarla aynıdır (`tokenScopeOf`), izinlerin dışı `403 token_scope` döner;
  - kişi kendi yetkisini aşamaz;
  - dakikada 120 istek sınırı vardır;
  - denetim kayıtları ve mesajlar `via: { kind: 'plugin' }` taşır, web'de "<eklenti> ile" rozeti çıkar;
  - token başka token üretemez; yönetim ve hesap uçları ona hiçbir zaman açık değildir.

## Crewhall'dan eklentiye imzalı istekler

Yaşam döngüsü, komut, araç ve olay isteklerinin hepsi `POST`'tur. Başlıklar:

- `crewhall-signature: t=<unix>,v1=<hex(HMAC-SHA256(secret, "<t>.<gövde>"))>`;
- `crewhall-installation: <kurulum kimliği>`.

Eklenti `verifyRequest({ secret, body, signature })` ile doğrular; ±5 dakikadan eski imza geçmez.

| İstek | Gövde (`@crewhall/plugin-sdk/server`) | Yanıt |
| --- | --- | --- |
| Yaşam döngüsü | `LifecycleRequest` (`install`, `update`, `uninstall`) | 2xx |
| Komut | `CommandRequest`: komut, argümanlar, sohbet, kişi, **kişinin tokenı**, dil | `{ reply?, post? }`. `reply` yalnız çağırana görünür, `post` kişinin adına "<eklenti> ile" mesajı olur. |
| Araç | `ToolRequest`: araç, girdi, kişi, kişinin tokenı | `{ content, summary? }` |
| Olay | `EventRequest`: `id`, `type`, `occurredAt`, `data` | 2xx |

- **Olay içeriği:**
  - Olaylar yalnız kimlik ve meta veri taşır, içerik taşımaz. Eklenti içeriği bir kişinin tokenıyla, o kişinin
    erişimi içinde okur.
  - `message.created` birebir sohbetler için gönderilmez.
  - `board.card.changed`: `{ cardId, boardId, change, activityId? }`. `change`: `created`, `updated`, `moved`, `deleted`, `restored`, `assignees`, `comment`. Açıklamanın ortak düzenleyicideki değişimi olay üretmez; kartın `updatedAt` değeri değişir, eklenti bunu taramayla görür.
  - Teslim `plugin.deliver` işiyle yapılır (5 deneme, üstel bekleme).
- **Asistan araçları:**
  - Okuyan araç bağlantıda `hub:read` varsa görünür.
  - Yazan araç, kurulumun bütün yazma izinleri bağlantıda da varsa görünür ve her çağrıda MCP onay kuyruğuna
    düşer (`plugin.tool`).
  - Token kurulum izinleri ile bağlantı kapsamlarının kesişimini alır.

## Arka planda çalışma (API 50, `plugins.offline`)

Başka bir sistemden gelen değişikliği kimse ekranda değilken Crewhall'a yazmak için. Üç kilit vardır:

1. **Yönetici:** kurulumda `offline:access` iznini verir. Sonradan geri alırsa hak hemen biter.
2. **Kişi:** eklenti köprüden `offlineAccess: grant` ister, onay Crewhall'ın kendi penceresinde verilir. Eklenti bu
   pencereyi atlayamaz. Kişi Bildirim ayarları › Eklentiler'den kapatır (`revokePluginOffline`). Onay sekmesi mobilde yoktur.
3. **Eklenti sunucusu:** `POST /api/plugins/v1/offline-token` (`OFFLINE_TOKEN_PATH`), kurulum sırrıyla imzalı, gövde `{ userId }`.

- **Yanıt:** `{ token, expiresAt }`, sıradan 5 dakikalık oturum tokenı. Kişinin yetkisini ve kurulum izinlerini aşamaz, denetim
  kayıtlarında `via: plugin` görünür. `offline:access` ve `notifications:write` tokenın kapsamına girmez.
- **Red:** onay yoksa, kişi kurumdan çıktıysa, pasif ya da konuksa `403 plugin_offline_not_granted`.
- **Sınır:** kurulum başına dakikada 120 token.
- **Denetim kaydı:** `plugin.offline_grant`, `plugin.offline_revoke`.
- **Uçlar:** `getPluginOfflineGrant`, `grantPluginOffline`, `revokePluginOffline`. Yalnız gerçek oturumla çalışır, tokenlara kapalıdır.
- **SDK:** `createServerClient(...).offlineToken(userId)`.

## Bildirimler (API 31, `notifications.plugin`)

Eklenti, kendisini açmış kişilere Crewhall bildirimi gönderebilir. İlk kullanıcı WhatsApp köprüsüdür: kişi
sekmeye bakmıyorken gelen yeni mesajları bildirir.

**İzin:**

- Manifestte `notifications:write` istenir. Bu kapsam token ve MCP kapsamlarıyla aynı kümededir; hiçbir REST
  ucu ona açılmaz.
- Kısmi onay geçerlidir: yönetici vermezse eklenti bildirim gönderemez.

**Kurulum düzeyinde kimlik:**

- İstekte kişi yoktur; eklenti sunucusu kurulum adına konuşur.
- İstek kurulum sırrıyla imzalanır. Sır, kurulumda yaşam döngüsü isteğiyle bir kez verilen sırdır.
- Başlıklar `crewhall-installation` ve `crewhall-signature: t=…,v1=HMAC(secret, "to-crewhall.<t>.<gövde>")`.
- `to-crewhall.` öneki yönü ayırır: Crewhall'ın eklentiye gönderdiği bir imza bu uçta geçmez, bu uçtaki imza
  da eklentide geçmez. İmza ±5 dakika geçerlidir.
- SDK: `signApiRequest` / `verifyApiRequest`.
- Kaldırmayla kurulum silinir ve sır geçersizleşir; kapatılan kurulum `plugin_disabled` alır.

**Bağlı kişiler:**

- Eklenti yalnız kendisini açmış kişilere bildirim gönderebilir. Bir kişi için oturum tokenı kesildiğinde
  (`createPluginSessionToken`, yani çerçeve açıldığında) kişi kuruluma bağlanır (`plugin_linked_users`,
  migration 0064).
- Bağlı olmayan, kurumdan çıkmış ya da pasif kişi `plugin_user_not_linked` alır. Böylece eklenti bütün kurumu
  bildirime boğamaz.

**Uç (`createPluginNotification`):** `POST /api/plugins/v1/notifications` (`NOTIFICATIONS_PATH`).

| Alan | Kural |
| --- | --- |
| `userId` | Bağlı kişi |
| `title` | Düz metin, en çok 120 karakter |
| `body` | Düz metin, en çok 500 karakter (isteğe bağlı) |
| `url` | Eklentinin kendi sekmesi: `/plugins/<kurulum>/<sekme>` (ray) ya da `/chat/plugins/<kurulum>/<sekme>` (sohbet); `?…` ve `#…` derin bağlantıdır. Yoksa ilk sekme. Başka bir yol `plugin_url_invalid`. |
| `threadKey` | Aynı anahtar ve aynı kişi için okunmamış bildirim tekrar yazılmaz: sayısı artar, metni ve bağlantısı yenilenir. |

- Yanıt: `201 { id, collapsed, delivered }`. Kişi bu eklentiyi kapattıysa `delivered: false` ve `id: null`.
- Gövde en çok 8 KB olabilir.
- Hız sınırı: kurulum başına dakikada 300, kurulum ve kişi başına dakikada 20 (`429 rate_limited`,
  `Retry-After`).
- Denetim kaydı `plugin.notify`: birleşmeyen her bildirim için kişi ve `threadKey`.

**Teslim:**

- Normal bir Crewhall bildirimi oluşur: tür `plugin.notification`, kategori `alert`, kaynak `alerts`, hedef
  `{ type: 'plugin', id: <kurulum> }`.
  - Kişinin `alert` satırındaki kanal tercihleri ("Alarm sohbetindeki kritik mesajlar"), sessiz saatler ve
    Rahatsız Etmeyin geçerlidir.
  - Ayrı bir "Eklentiler" kategorisi açılmadı; eklenti başına mod bunun yerine geçer (bkz. kararlar.md).
- `data`: `plugin` (kaynak adı), `pluginId`, `icon` (eklenti kökenindeki mutlak adres), `title`, `excerpt`.
  - Kaynak adı alıcının dilindedir ve bildirim oluşurken yazılır. Sıra: manifestteki `notificationName`;
    yoksa eklentinin tek sekmesi varsa onun başlığı; yoksa tam ad. Eski satırlar yazıldıkları adı korur.
  - Tam ad (ör. "WhatsApp Köprüsü (gayriresmî)") kurulum, pazar yeri ve yönetim listelerinde kalır; oradaki uyarı
    önemlidir.
- Zil satırında eklentinin simgesi görünür, başlık "<eklenti> · <başlık>" olur; push başlığı da aynıdır.
- Masaüstü ve mobil push mevcut boru hattından gider. Push `data.url`'si bildirimin `url`'sidir; mobil bunu
  açınca eklenti sekmesini derin bağlantıyla açar.
- Web eklenti sekmesi, Crewhall adresindeki `?…` ve `#…` kısmını eklenti sayfasının kendi adresine ekler
  (`/chat/plugins/<id>/inbox?chat=42` → `<origin>/inbox?chat=42`).

**Kişinin ayarı (Bildirim ayarları › Eklentiler; API 33, `plugins.userPrefs`):**

- Sunucuda saklanır, kişinin her cihazında geçerlidir. Eklentinin sekmesindeki "Bu eklentinin ayarları"
  düğmesi de aynı ayarı açar:
  - ray sekmesinde üst çubukta;
  - sohbet sekmesinde, kenar çubuğundaki satırın üstüne gelince;
  - masaüstünde başlık satırında.
- Listede kişinin gördüğü bütün etkin eklentiler vardır. `canNotify`, eklentinin `notifications:write` izni olduğunu
  ve kişinin onu açtığını söyler.
- **Kanallar** (`channels`), her biri açık ya da kapalı:
  - `bell`: bildirim merkezi;
  - `desktop`: masaüstü uygulamasının bildirimi; zilin canlı olayıdır, zil kapalıysa o da gelmez;
  - `push`: telefona push.

  Örnek: WhatsApp yalnız masaüstünde, telefona hiç gelmesin → `{ bell: true, desktop: true, push: false }`.
- **Teslim:**
  - `push` kapalıysa Expo/FCM gönderilmez.
  - `bell` kapalıysa bildirim merkezine satır düşmez; `push` açıksa yine de gider.
  - `desktop` kapalıysa bildirim `Notification.desktop: false` taşır: işletim sistemi bildirimi çıkmaz
    (masaüstü uygulaması, tarayıcı).
  - İkisi de (`bell` ve `push`) kapalıysa `delivered: false` döner.
- **`mode` (API 31) uyumluluğu:**
  - Eski istemciler için kanalların özetidir: `on` (push ya da masaüstü açık), `muted` (yalnız zil),
    `off` (hiçbiri).
  - `mode` ile güncelleme bütün kanalları birlikte ayarlar: `muted` yalnız zil demektir, `off` hiçbiri.
  - Eski `muted`/`off` satırları migration 0066'da kanallara çevrildi.
- **Mobilde göster** (`showOnMobile`, varsayılan açık):
  - Kapalıysa eklentinin sekme, kart ve komutları o kişinin mobil uygulamasında görünmez.
  - `listPluginSurfaces`, `X-Crewhall-Client: ios/…` ya da `android/…` başlığıyla gelen isteğe bu eklentileri hiç
    vermez. Böylece eski mobil sürümler de uyar.
  - Diğer istemciler `PluginSurface.hiddenOnMobile: true` görür.
  - Açıkken manifestteki sekme/kart `mobile` bayrakları geçerlidir.
  - Web ve masaüstü için ayrı bir görünürlük ayarı yok: eklenti zaten oradan kullanılıyor.
- **Uçlar:** `listPluginNotificationPrefs`, `updatePluginNotificationPref` (`{ mode? , channels?, showOnMobile? }`).

- **Sol menüye ekleme** (`pinnedTabs`, API 42, `plugins.railPin`, varsayılan kapalı):
  - Kişi, manifestin başka yere koyduğu bir sekmeyi (ör. sohbetteki WhatsApp) kendi sol menüsüne ekler. Sunucuda
    saklanır, web ve masaüstünde geçerlidir; mobil aynı alanı sonra kullanacak.
  - `PluginSurface.pinnedTabs` ve `updatePluginNotificationPref { pinnedTabs }`. Bilinmeyen sekme
    `validation_failed` alır.
  - Menü öğesinin kimliği her eklenti sekmesiyle aynıdır (`plugin:<pluginId>:<tabId>`), kişinin menü sıralamasına ve
    gizleme ayarına diğer öğeler gibi girer. `/plugins/<kurulum>/<sekme>` adresini açar; sohbet sekmesi sohbet kenar
    çubuğunda da kalır.

**Okunan bildirimi temizleme (`clearNotifications`, API 42):**

Bildirim Crewhall'a gelir, kişi mesajı eklentinin içinde okur, bildirim okunmamış kalır. Eklenti bunu kapatır.

- **Uç:** `POST /api/plugins/v1/notifications/clear` (`NOTIFICATIONS_CLEAR_PATH`). Gönderimle aynı kurulum imzası ve
  `notifications:write`.
- **Gövde:** `{ userId, threadKey, action? }`. `threadKey`, bildirim gönderilirken verilen anahtardır (ör. sohbet
  kimliği); anahtarsız gönderilen bildirim temizlenemez. `action`: `read` (varsayılan) ya da `dismiss`.
- **Yanıt:** `{ cleared }`. 0 hata değildir: zaten okunmuş ya da hiç gönderilmemiş olabilir.
- **Kapsam:** yalnız bu kurulumun, bu kişi ve anahtar için açık bildirimleri değişir. Zildeki sayı hemen güncellenir.
  Sonra aynı anahtarla gelen bildirim yeni ve okunmamış olur.
- **Sınır:** kurulum başına dakikada 600, kurulum ve kişi başına dakikada 60. Denetim kaydına yazılmaz.
- **SDK:** `crewhall.clearNotifications({ userId, threadKey })`.

**Telefondaki bildirimi kaldırma:**

- Henüz bildirim gönderilmemişse push hiç gitmez (`push.send` okunmuş satırı atlar).
- `threadKey`'li eklenti push'u bir etiket taşır: `PushData.tag`, Android `notification.tag`, iOS
  `apns-collapse-id`. Aynı etiketli yenisi tepsidekinin yerine geçer.
- Temizlenince (`push.clear`) telefonlara veri mesajı gider: `{ type: 'notification.clear', tag }`. Mobil
  `PUSH_CLEAR_MIN_VERSION` (0.3.0) altındaki sürümlere gönderilmez: eski Android uygulaması bilinmeyen veri
  mesajını expo-notifications'a verir.
- **Sınırlar (en iyi çaba):**
  - Android'de etikete göre silme yalnız doğrudan FCM yolunda çalışır; Notifike isteğinde etiket alanı yok.
  - iOS arka plan push'unu geciktirebilir ya da atlayabilir; uygulama `remote-notification` kipini
    açmalıdır.
  - Expo jetonlu eski iOS sürümlerine gitmez.
  - Masaüstü bildirimleri kapatılmaz; kendiliğinden kaybolur.

**SDK:**

```ts
import { createServerClient, pluginTabUrl } from '@crewhall/plugin-sdk/server';
const crewhall = createServerClient({ apiUrl, installationId, secret }); // kurulum isteğinden
await crewhall.notify({
  userId,
  title: 'Ayşe',
  body: 'Yarın görüşelim mi?',
  url: pluginTabUrl({ installationId, tab: 'inbox', placement: 'chat', search: { chat: '42' } }),
  threadKey: 'chat-42',
});
```

Hata `CrewhallApiError`'dur: `status`, `code`, `details`.

## Pazar yeri

### API

| Uç | Kim | Ne yapar |
| --- | --- | --- |
| `POST /v1/auth/signup`, `POST /v1/auth/login` | geliştirici | Hesap; 30 günlük `mkt_` oturum tokenı döner |
| `POST /v1/tokens` | geliştirici | CLI tokenı |
| `POST /v1/plugins/:id/versions` | geliştirici | `{ manifest, audience?, listing? }` incelemeye gider. İlk yükleme kimliği sahiplenir. `listing` yoksa görünürlük değişmez (yeni eklentide herkese açık). |
| `PUT /v1/plugins/:id/listing` | geliştirici (sahibi) | `{ visibility, allowlist? }`: görünürlüğü sonradan değiştirir |
| `GET /v1/me/plugins` | geliştirici | Sürümlerim: bekleyen, onaylanan (risk ve inceleyici notuyla), reddedilen (gerekçesiyle), geri çekilen |
| `DELETE /v1/plugins/:id/versions/:v` | geliştirici | Bekleyen sürümü geri çeker |
| `POST /v1/plugins/:id/versions/:v/yank` | sahibi ya da inceleyici | `{ reason }`: onaylı sürümü kaldırır (bkz. Kaldırma) |
| `POST /v1/plugins/:id/versions/:v/restore` | sahibi ya da inceleyici | Kaldırılan sürümü ilk imzasıyla geri koyar |
| `POST /v1/plugins/:id/delist` | sahibi ya da inceleyici | `{ reason }`: eklentiyi yayından kaldırır |
| `POST /v1/plugins/:id/relist` | sahibi ya da inceleyici | Yeniden yayınlar |
| `GET /v1/review/queue` | inceleyici | Bekleyen sürümler |
| `POST /v1/review/:id/:v/approve` | inceleyici | `{ risk, riskNote?, audience?, note? }` ile onaylar ve imzalar; `note` geliştiriciye görünür |
| `POST /v1/review/:id/:v/reject` | inceleyici | `{ reason }` ile reddeder |
| `GET /v1/catalog?q=&installation=` | herkes | Her eklentinin son onaylı sürümü: yalnız herkese açıklar ve izin listesinde bu kurulum olan özel eklentiler. Listelenmemişler aramada da çıkmaz. |
| `GET /v1/plugins/:id?installation=` | herkes | Ayrıntı ve onaylı sürümler; listelenmemiş de bulunur, özel olan izin listesi dışına 404 |
| `GET /v1/plugins/:id/versions/:v/package?installation=` | herkes | İmzalı paket; özel olan izin listesi dışına 404 |
| `GET /v1/keys` | herkes | Açık anahtarlar |

İnceleyici rolü, `MARKETPLACE_REVIEWERS` listesindeki e-postayla kaydolan hesaba verilir.

### Görünürlük

| Görünürlük | Katalog ve arama | Kimlik ya da bağlantıyla |
| --- | --- | --- |
| `public` | herkes | herkes |
| `unlisted` | hiç kimse | herkes |
| `private` | yalnız izin listesindeki kurulumlar | yalnız izin listesindeki kurulumlar |

- Görünürlük eklenti düzeyindedir. Geliştirici yüklerken seçer, sonra `/dev` ekranından ya da `PUT …/listing`
  ile değiştirir. İnceleyici kuyrukta ve inceleme sayfasında görür.
- İzin listesi kurulum alan adlarıdır; Crewhall `installation=<API_URL'nin host'u>` gönderir.
- Bu bir listeleme denetimidir; `installation` değeri kimlik doğrulaması değildir. Kurulumun asıl sınırı imzalı
  `audience`'tır. Paketlerde sır yoktur.
- Özel eklentinin ayrıntısı ve paketi `Cache-Control: private, no-store` ile döner.
- `/p/<id>` herkese açık bir yönlendirme sayfasıdır: nasıl kurulacağını anlatır, eklenti hakkında bilgi vermez.

### Kaldırma

Yayınlanmış iş silinmez, çünkü kurumlar ona bağlıdır. İki adımlı kaldırma vardır. Kurmuş kurumlar ikisinde de
kurdukları sürümü çalıştırmaya devam eder: paket kurulumda saklıdır.

| | Sürümü kaldırma (`yanked`) | Yayından kaldırma |
| --- | --- | --- |
| Katalog | Önceki onaylı sürüm görünür | Görünmez |
| Kimlikle ayrıntı | Sürüm listesinde yok | 404 |
| Paket | O sürüme 404 | Her sürüme 404 |
| Yeni kurulum ve güncelleme | O sürüm sunulmaz | Yok |
| Yeni yükleme | Kaldırılan sürümden büyük olmalı; aynı sürüm numarası tekrar kullanılmaz | İncelemeye gider, yayına çıkmaz |

- Gerekçe zorunludur (3-2000 karakter). Kim, ne zaman ve neden saklanır, sahibine gösterilir.
- Sahibi ve her inceleyici yapabilir; başkası `not_found` alır.
- İnceleyicinin kaldırdığını yalnız inceleyici geri alır; sahibi `taken_down_by_reviewer` alır.
- Hata kodları: `not_approved`, `not_yanked`, `already_delisted`, `not_delisted`, `taken_down_by_reviewer`.
- Crewhall tarafı değişmedi: yayından kaldırılan eklenti kurulu listede güncelleme göstermez, katalogda ve kimlikle
  aramada bulunmaz.

### Ekranlar

Pazar yeri API ile aynı servis katmanını kullanan, sunucuda üretilen sayfalar sunar. Sayfalarda betik yoktur. Dil
Türkçe ya da İngilizcedir: `?lang=`, sonra çerez, sonra `Accept-Language`.

| Yol | Kim | Ne |
| --- | --- | --- |
| `/login`, `/signup` | herkes | Giriş ve geliştirici hesabı |
| `/dev` | geliştirici | Eklentilerim: her sürümün durumu, risk düzeyi, inceleyici notu ya da red gerekçesi; bekleyen sürümü geri çekme; onaylı sürümü kaldırma ve geri yükleme; yayından kaldırma; CLI jetonu (bir kez gösterilir) |
| `/dev/upload` | geliştirici | Manifest dosyası ya da yapıştırılmış JSON ile sürüm yükleme. Geçersiz manifestte alan alan hata listesi gösterilir. |
| `/review` | inceleyici | Kuyruk: ilk sürüm, eklenen izin sayısı, köken değişikliği rozetleri |
| `/review/:id/:v` | inceleyici | Onaylı önceki sürümle karşılaştırma; onaylama ya da reddetme |
| `/review/plugins` | inceleyici | Tüm eklentiler, sahibiyle: sürüm kaldırma ve yayından kaldırma |

**Karşılaştırma (`/review/:id/:v`):**

- izinler: eklenen, kaldırılan, aynı kalan;
- köken değişikliği;
- giriş noktaları: yeni, kaldırılan, hangi alanı değişen;
- diğer bütün alanlar: önce ve sonra;
- tam manifest.

**Onaylama ve reddetme:**

- Onay formu: risk düzeyi, Türkçe ve İngilizce risk notu, kurulum kısıtı ve geliştiriciye not.
- Red formu: gerekçe.

**Güvenlik:**

- Oturum, `mkt_session` httpOnly çerezindeki `mkt_` tokenıdır (`SameSite=Lax`, üretimde `Secure`).
- Form gönderimleri iki kez denetlenir: `Origin` `PUBLIC_URL` olmalıdır (`hono/csrf`), ve oturuma bağlı `_csrf`
  alanı tutmalıdır.
- Sayfalar `Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors
  'none'` ve `Cache-Control: no-store` ile döner.
- Çıkış oturum tokenını siler.
- **Giriş sınırı** (`src/ratelimit.ts`, API ve ekran aynı):
  - Başarısız denemeler hesap (e-posta, hesap olsun olmasın) ve istemci IP'si başına sayılır. Sayım veritabanında
    tutulur (`login_attempts`), yeniden başlatmada ve birden çok örnekte ortaktır.
  - Hesap: 1 saatte 5 hata kilitler; kilit 30 sn ile başlar, her yeni hatada iki katına çıkar, en çok 15 dk.
  - IP: 15 dakikada 20 hata kilitler; kilit 60 sn ile başlar, en çok 1 saat.
  - Kilitliyken şifreye bakılmaz. Yanıt `429 too_many_attempts` ve `Retry-After` başlığıdır.
  - Bilinmeyen e-posta ile yanlış şifre aynı yanıtı alır (`401 invalid_credentials`). İkisi de aynı sürede döner:
    hesap yoksa sahte bir özetle karşılaştırılır.
  - Başarılı giriş hesabın sayımını sıfırlar, IP'ninkini sıfırlamaz.
  - IP, `TRUST_PROXY_HOPS` > 0 ise en yakın vekilin X-Forwarded-For'a eklediği adrestir. Dokploy'da bu değer `1`
    olmalıdır. 0 ise soket adresi kullanılır.

### Geliştirici akışı

```bash
pnpm --filter @crewhall/plugin-sdk plugin validate manifest.json
pnpm --filter @crewhall/plugin-sdk plugin publish manifest.json --market https://market.crewhall.dev --token mkt_…
```

İnceleyici onaylayınca sürüm katalogda görünür. Kurulumlar güncellemeyi Yönetim › Eklentiler'de görür.

### Dokploy'da çalıştırma

1. **Anahtar:** bir kez anahtar çifti üret: `pnpm --filter @crewhall/plugin-sdk plugin keygen`. Çıktının ilk satırı
   `MARKETPLACE_SIGNING_KEY` olur. Açık anahtar kurulumlara `MARKETPLACE_PUBLIC_KEYS=<keyId>:<açık anahtar>`
   olarak verilir.
2. **Veritabanı:** ayrı bir PostgreSQL 17 veritabanı aç (ör. `marketplace`). Migration'lar açılışta kendiliğinden
   çalışır.
3. **Uygulama:** Dockerfile `apps/marketplace/Dockerfile`, bağlam reponun kökü, port `4321`, sağlık denetimi
   `/healthz`. Dokploy'da alan adı örneği `market.crewhall.dev`, TLS Dokploy'dan.
   - İmajda geliştirme bağımlılıkları yoktur. Bu yüzden `tsconfig.json`'un `extends`'i (`@crewhall/config`)
     orada çözülmez.
   - JSX ayarı her `.tsx` dosyasının başındaki `@jsxRuntime automatic` / `@jsxImportSource hono/jsx`
     yorumlarından gelir.
   - İmaj derlenirken son adımda `scripts/smoke.ts` `/login` ve `/signup`'ı veritabanısız açar. Sayfa açılmazsa
     derleme düşer.
   - `test/smoke.test.ts` aynı betiği yalın bir tsconfig ile çalıştırır.
4. **Ortam değişkenleri:**

   | Değişken | Örnek | Sır mı |
   | --- | --- | --- |
   | `DATABASE_URL` | `postgres://marketplace:…@db:5432/marketplace` | evet |
   | `MARKETPLACE_SIGNING_KEY` | `keygen` çıktısı (PKCS#8, base64) | **evet**; kaybolursa yeni anahtar ve bütün kurulumlara yeni `MARKETPLACE_PUBLIC_KEYS` gerekir |
   | `MARKETPLACE_KEY_ID` | `crewhall-market-1` | hayır; anahtar dönerken artırılır |
   | `MARKETPLACE_REVIEWERS` | `inceleme@crewhall.dev` | hayır |
   | `PUBLIC_URL` | `https://market.crewhall.dev` | hayır |
   | `PORT` | `4321` | hayır |
   | `TRUST_PROXY_HOPS` | `1` (Dokploy/Traefik arkasında) | hayır; giriş sınırının IP'si buna göre okunur |
5. **Anahtar dönüşü:** yeni anahtarı yeni `MARKETPLACE_KEY_ID` ile ekle. Kurulumlar bir süre iki anahtarı birden
   taşır (`MARKETPLACE_PUBLIC_KEYS=eski:…,yeni:…`). Paketler yeniden imzalanınca eski anahtar çıkarılır.

### Crewhall kurulumunda

| Değişken | Varsayılan | Not |
| --- | --- | --- |
| `MARKETPLACE_URL` | `https://market.crewhall.dev` | Pazar yeri adresi |
| `MARKETPLACE_PUBLIC_KEYS` | boş | Boşken hiçbir eklenti kurulamaz |

## Örnek eklenti (`apps/plugin-hello`)

Bütün giriş noktalarını gösterir:

- `rail` sekmesi; sunucuya kim olduğunu doğrulatır ve Crewhall'ı geri çağırır;
- ana sayfa kartı;
- `/hello` komutu;
- `greet` aracı;
- `message.created` olayı.

Çalıştırma:

```bash
PORT=4331 PLUGIN_ORIGIN=http://localhost:4331 pnpm --filter @crewhall/plugin-hello dev
```

Gerçek bir eklentide kurulumlar ve sırları kendi veritabanında saklanmalı; örnek bellekte tutar.

## Azure DevOps ve Jira eklentileri (`apps/plugin-workitems`)

Aynı kod iki eklenti olarak çalışır (`PLUGIN_PRODUCT`). Panoları work item ya da Jira işleriyle iki yönlü eşitler. Arka planda çalışmanın ve kart olaylarının ilk kullanıcısıdır. Ayrıntılar
eklentinin `README.md` dosyasında.

## Kendi sunucusunda (API 30, `plugins.selfHosted`)

Bazı eklentiler her kurumun verisini yayıncının sunucusundan geçirmemelidir (ör. WhatsApp köprüsü). Manifest
`hosting: 'self'` der; her kurum kendi kopyasını çalıştırır.

1. **Kurulum:**
   - Yönetici kurulum penceresine kendi https adresini girer (`InstallPlugin.selfOrigin`). Yolsuz olmalıdır; düz
     `http` yalnız üretim dışında localhost'ta geçer. Yoksa `plugin_self_origin_required` ya da
     `plugin_self_origin_invalid` döner.
   - Crewhall `<adres>/.well-known/crewhall-plugin.json`'ı outboundFetch ile okur. Bu okumada özel ya da iç
     adresler, izinsiz portlar ve yönlendirmeler engellenir; yanıt en çok 256 KB olabilir. Engellenen adres
     `plugin_self_origin_invalid { reason: 'blocked' }`, ulaşılamayan sunucu `plugin_self_unreachable` alır.
2. **Denetim (`selfHostedMismatch`):** sunulan manifest geçerli olmalı.
   - `origin`'i tam olarak girilen adres olmalıdır.
   - Kimliği, sürümü ve izinleri imzalı manifestle aynı olmalıdır.
   - `origin` imzalı olanla değiştirildiğinde kanonik JSON'u (dolayısıyla özeti) birebir aynı olmalıdır.
   - Tutmazsa `plugin_self_manifest_mismatch { reason }` döner; `reason`: `shape`, `origin`, `id`, `version`,
     `permissions` ya da `manifest`.
3. **Kullanım:**
   - Kurulumun saklanan `manifest`'i yalnız `origin`'i değişmiş imzalı manifesttir. İmzalı paket olduğu gibi
     `package`'ta kalır, adres de `self_origin` kolonundadır (migration 0063).
   - Bu yüzden Crewhall'ın eklenti için kurduğu her adres o kuruma özgüdür: iframe, ikon, yaşam döngüsü, komut,
     araç ve olay istekleri.
   - İstekler outboundFetch ile gider, yönlendirme izlenmez.
   - Eklentiler için ayrı bir OAuth/OIDC istemcisi ya da CSP izin listesi yoktur. İleride eklenirse aynı etkin
     kökeni kullanır.
4. **Güncelleme:**
   - Her güncellemede kopya yeniden denetlenir. Kopya yeni imzalı sürümü sunmadan güncelleme yapılmaz.
   - Barındırma biçimini değiştiren sürüm (`hosted` ↔ `self`) `plugin_hosting_changed` alır; kaldırıp yeniden
     kurmak gerekir.
5. **Denetim kaydı:**
   - `plugin.install`: `hosting` ve `selfOrigin`.
   - `plugin.upgrade`: `selfOrigin` ve `recheck`.
6. **API ve görünüm:** `PluginInstallation.hosting` / `.selfOrigin`; `origin` her zaman etkin köken.
   `PluginCatalogItem.hosting` / `.visibility`.

Kopyanın yapacağı: imzalı manifesti, `origin`'i kendi adresi olarak, `/.well-known/crewhall-plugin.json`'da
sunmak. Başka hiçbir alanı değiştirmemelidir.

## Sınırlar

- Eklenti başına kurulum düzeyinde (kişisiz) API erişimi yok. Arka plan işi her zaman onay vermiş bir kişinin adına yapılır.
- Olaylar meta veri taşır, içerik taşımaz.
- Komut yanıtındaki `reply` yalnız çağırana görünen bildirimdir; sohbette kalıcı not olarak kalmaz.
- Mobil uygulamada sohbet `/komut`ları ve asistan araçları web'deki uçlarla çalışır. Mobilin kendi ekranları
  mobil reposundadır.
- Geliştiricinin kendi imzası yok. Sürümü pazar yeri onayla birlikte imzalar.
