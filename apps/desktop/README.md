# Crewhall masaüstü (Windows, macOS)

Electron kabuğu. Kurumun sunucusundaki web uygulamasını açar. Bunun yanında yerel bildirim, tepsi,
okunmamış rozeti, otomatik başlatma, `crewhall://` linkleri, ekran paylaşımı seçicisi ve iki yönlü Drive
klasör senkronu ve Windows'ta sanal sürücü sağlar.

## Komutlar

```bash
pnpm --filter @crewhall/desktop build      # dist/: esbuild paketleri (main, preload, sayfalar)
pnpm --filter @crewhall/desktop dev        # derle ve Electron'u aç
pnpm --filter @crewhall/desktop test       # Vitest: senkron mantığı, yardımcılar
pnpm --filter @crewhall/desktop dist:win   # release/Crewhall-Setup-<sürüm>.exe (NSIS)
pnpm --filter @crewhall/desktop dist:mac   # macOS üzerinde: dmg + zip (universal)
pnpm --filter @crewhall/desktop publish:updates  # updates/{win,mac}: sunucunun DESKTOP_UPDATES_DIR'i
pnpm --filter @crewhall/desktop build:native     # yalnız Windows: sanal sürücü eklentisi (native/cloudfiles)
```

Electron ikilisi ilk `dev` çalıştırmasında indirilir. Paketleme için gereken ikililer de electron-builder
tarafından indirilir. Pakete `node_modules` girmez; her şey `dist/` içine paketlenir.

`build:native`, Visual Studio'nun C++ araçlarını ister ve `dist:win` tarafından çalıştırılır. Eklenti yoksa
uygulama yine çalışır, yalnız sanal sürücü sunulmaz. `test/cloud-native.test.ts` gerçek Cloud Files API'sine
karşı çalışır ve eklenti derlenmemişse atlanır. Testler geçici bir klasör kaydeder, kayıt defterine yazmaz.

Geliştirme ortam değişkenleri:

- `CREWHALL_USER_DATA=<klasör>`: ayrı profil (ayarlar, oturum çerezi, senkron durumu).
- `CREWHALL_REGISTER_PROTOCOL=1`: geliştirmede `crewhall://` bu makinede `electron .`'a bağlanır.
  Varsayılan kapalıdır.
- Ayarlar dosyasında `updateUrl`: güncelleme beslemesini geliştirme için başka bir adrese çevirir.
  Normalde besleme kurum sunucusudur.

Geliştirme çalıştırması otomatik başlatmaya kaydolmaz. Bu kayıt yalnız paketlenmiş uygulamada, ilk
bağlanışta yapılır.

## Yapı

| Klasör                | İçerik                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main`            | Ana süreç: pencere, tepsi, menü, bildirim, rozet, IPC, güncelleme, marka simgesi                                                                        |
| `src/preload`         | Tek sandbox preload. Uygulamanın kendi `file://` sayfalarına `desktop` API'sini verir. Sunucunun sayfalarına yalnız `crewhallDesktop.isDesktop` görünür |
| `src/renderer`        | Kurulum, ayarlar (senkron sihirbazı), ekran seçici, çevrimdışı sayfası (bağımlılıksız TS)                                                               |
| `src/common`          | Saf yardımcılar: sunucu denetimi, derin link, rozet, i18n, bildirim metni, WebSocket istemcisi                                                          |
| `src/sync`            | Senkron: `reconcile` (saf, üç yönlü), `pass` (tek geçiş), `engine` (zamanlama), `remote` (Drive API)                                                    |
| `assets`, `resources` | Tepsi/pencere simgeleri, ürün logosu; paket simgesi ve macOS yetkileri                                                                                  |

Metinler `packages/i18n/src/locales/{tr,en}/web/desktop.json` içindedir (`web.desktop.*`). Bildirim
başlıkları web'in zil metinlerini (`web.chat.notifications.*`) kullanır. Dil sırası şöyledir:
kişinin web'deki dili, işletim sistemi dili, kurumun varsayılanı.

## Nasıl çalışır

- **Sunucu:** ilk açılışta adres sorulur. `GET /api/v1/bootstrap` doğrulanır, kurum adı ve logo gösterilir.
  Sonra ana pencere `https://<sunucu>/` adresini açar. Oturum web'deki gibi httpOnly çerezdir. Ana süreç
  API'yi aynı Electron oturumunun `fetch`'iyle çağırır.
- **Açılış:** ana pencere sayfası yüklenene kadar gizli kalır. Bu sırada Crewhall yükleyicisi görünür
  (`crewhall-brand/lottie`, `lottie-web` light, pakete gömülü; `src/main/loading.ts`).
  - En az 0,8 sn görünür; sayfa daha geç yüklenirse hemen kapanır, 15 sn'den uzun beklemez.
  - Tema açık/koyuya göre seçilir. "Hareketi azalt" açıksa durağan amblem gösterilir.
- **Başlık çubuğu:** ana ve toplantı penceresinde sistem başlık çubuğu yoktur. Web'in üst çubuğu
  (`data-titlebar`) başlık çubuğu olur; pencere düğmeleri onun içinde, sağdadır. Kendi çubuğu olmayan
  sayfaların üstünde 32 px'lik sürüklenebilir bir şerit kalır (`src/common/titlebar.ts`,
  `src/main/titlebar.ts`).
- **Yenileme kısayolları:** Windows'ta uygulama menüsü yoktur, bu yüzden menü kısayolları çalışmaz.
  Ana ve toplantı penceresi kısayolları kendisi yakalar (`src/common/shortcuts.ts`):
  - Ctrl+R / F5 yeniler.
  - Ctrl+Shift+R / Ctrl+F5 önbelleği yok sayarak yeniler.
  - macOS'ta Ctrl yerine Cmd kullanılır.
  - Çevrimdışı sayfasında sunucu yeniden denenir.
  - Web'in yeni sürümü yayınlanınca sayfa kendisi "Yeni sürüm hazır · Yenile" der
    (`apps/web/src/lib/newVersion.ts`).
- **Dosya görüntüleyici:** sayfanın satır içi açtığı kendi dosyalarımız tarayıcıya gitmez; tek bir
  görüntüleyici penceresinde açılır. Bunlar kurum depolamasının imzalı bağlantıları ile `disposition=inline`
  API dosyalarıdır. Pencerede resim, PDF ve video için Chromium'un kendi görüntüleyicisi çalışır; Esc
  kapatır. Gerçek dış siteler tarayıcıda açılır (`src/common/window-policy.ts`, `src/main/viewer.ts`).
- **Bilgisayarın durumu (`powerMonitor`, `src/main/system.ts`):**
  - Windows kilitlenince ya da bilgisayar uyuyunca sayfalara `onSystemLock` gider; kasa hemen kilitlenir.
  - Küçültme ve tepsiye inme gizlenme sayılmaz.
  - Çevrimiçi durumu için kalp atışı bilgisayarın boşta kalma süresini ve kilit durumunu taşır
    (`active`, `idleSeconds`, `locked`, `client: 'desktop'`). Son 15 dk içinde kullanılmışsa ve kilitli
    değilse aktif sayılır.
- **Sürüm uyumu:** köprü `version` ve `features` taşır; web yalnız özellik sorar. Kurum sunucusuna
  giden her istekte `X-Crewhall-Client: desktop/<sürüm>` başlığı vardır. Sunucu 426 dönerse uygulama
  kendi güncelleme ekranını açar (`src/common/client.ts`).
- **Web yolları:** yollar İngilizcedir (`docs/contracts/ingilizce-url.md`).
  - Uygulama gelen yolu önce güncel biçime çevirir (`toCurrentPath`); toplantı ve giriş sayfalarını iki
    biçimde de tanır.
  - Bildirim, `crewhall://` bağlantısı ve açılır pencereyle gelen yolu sunucunun sunduğu biçimde açar.
    Bootstrap `paths.english` diyorsa İngilizce, demiyorsa eski Türkçe biçim kullanılır
    (`src/common/paths.ts`).
  - Toplantı yolu toplantı penceresinde açılır.
- **Tepsi simgesi** görev çubuğunun temasına göre seçilir. Koyu görev çubuğunda beyaz amblem ve açık yeşil
  nokta, açık görev çubuğunda renkli amblem kullanılır; Linux'ta beyaz. Tema değişince simge de değişir.
  macOS'ta şablon görseldir. Boyutlar: 16, 20, 24, 32 px.
- **Bildirim ve arama:** ana süreç kendi `/ws` bağlantısını açar (`createWsTicket`). Heartbeat'te
  `focused:false` gönderir; böylece sunucunun bildirim kuralları değişmez.
  - `notification` olayı yerel bildirime çevrilir; pencere öndeyse gösterilmez.
  - `call.ringing` gelince pencere öne gelir, Windows'ta görev çubuğu yanıp söner.
  - Web'in HTML bildirim izni reddedilir. Böylece aynı bildirim iki kez çıkmaz.
- **Rozet:** okunmamış sohbet sayısı ile sohbet dışı okunmamış bildirimler toplanır. Windows'ta görev
  çubuğu katmanında sayı, tepside nokta gösterilir. macOS'ta Dock rozeti ve menü çubuğunda sayı görünür.
- **Senkron:** her eşleşme için ayrı bir taban (son eşitlenen durum) tutulur:
  `userData/sync/<id>.json`. Senkronu şunlar tetikler: açılış, yerel değişiklik (`fs.watch`, 2 sn
  bekleme), `node.updated` olayı ve 5 dakikada bir tam geçiş.
  - Çakışmada iki kopya tutulur.
  - Silinen öğe sunucuda çöpe, yerelde çöp kutusuna gider.
  - 50'den fazla öğe ve tabanın %30'undan fazlası silinecekse geçiş durur, onay beklenir.
  - Okunamayan klasöre dokunulmaz.
  - Uzak listeleme hatası hiçbir zaman "silindi" diye yorumlanmaz.
- **Güncelleme:** electron-updater, kurumun kendi sunucusundan çalışır:
  `<sunucu>/api/v1/desktop/updates/<win|mac>/`.
  - Sunucu değişince besleme de değişir.
  - 404 "güncelleme yok" sayılır.
  - Yalnız daha yeni sürüm kurulur.
  - Yeni sürüm şöyle yayımlanır: `dist:win`, sonra `publish:updates`. Bu adımlar
    `apps/desktop/updates/{win,mac}` klasörünü üretir; klasör sunucunun `DESKTOP_UPDATES_DIR`
    yoluna konur (`docker/README.md`).

- **Genel kısayol:** `Ctrl+Shift+Y` (macOS'ta `Cmd+Shift+Y`) Crewhall'ı öne getirir. Ayarlar > Genel'den
  değişir ya da kapanır. Sistemin ve uygulamanın kullandığı kısayollar reddedilir; başka bir programın
  tuttuğu kısayolda eski kısayol korunur ve ekranda yazar.
- **Bildirim eylemleri:** mesajda yanıtla ve okundu, toplantıda katıl, aramada yanıtla ve reddet.
  Windows ve macOS'ta çalışır, Linux'ta düğme çıkmaz. Yanıt gönderilemezse metni yeni bildirimde gösterilir.
- **Yeni pencere:** orta tık, Ctrl ile tıklama, bağlantıların yerel menüsü ve
  `crewhallDesktop.openWindow` öğeyi yeni bir uygulama penceresinde açar (`src/main/extra-windows.ts`,
  en çok 8 pencere). Kapatmak uygulamayı kapatmaz.
- **Toplantı penceresi:** web `crewhallDesktop.openMeeting(url)` ile toplantıyı ayrı pencerede açar
  (`src/main/meeting-windows.ts`). Aynı oturum kullanılır; her toplantı için tek pencere açılır ve
  konumu hatırlanır. Toplantıdan çıkınca pencere kapanır ve ana sayfaya `onMeetingClosed` ile haber
  gider.
- **Ekranın uzaktan kontrolü:** toplantıda bütün ekran paylaşılırken izleyen kişi kontrol isteyebilir.
  - Web odası `meet.control` mesajlarını preload köprüsüyle (`crewhallDesktop.remoteControl`) ana
    sürece iletir.
  - Karar `src/common/remote-control.ts` içinde verilir (saf, testli). Uygulama
    `src/main/remote-control.ts` ve `input-driver.ts` içindedir (robotjs).

- **Passkey (kasa):** Windows'ta ayar gerekmez; Windows Hello ve güvenlik anahtarları Chromium
  üzerinden çalışır. macOS'ta Touch ID için imzalı paket gerekir. Gereksinimler:
  - Apple Developer ID ile imza.
  - `entitlements.mac.plist` içinde `keychain-access-groups`: `<TEAM_ID>.com.crewhall.desktop.webauthn`.
  - Derlemede `CREWHALL_MAC_KEYCHAIN_GROUP` aynı değerle verilir (`src/common/webauthn.ts`).
- **Windows Hello ile kasa:** mobildeki biyometrik kilidin karşılığıdır (`device` yöntemi).
  - Cihaz sırrı `safeStorage` ile şifreli olarak `userData/vault-device.json` içinde durur.
  - Ana süreç sırrı, ancak kendi doğruladığı bir Windows Hello imzasından sonra kasa sayfasına verir.
    Doğrulama bir WebAuthn platform kimlik bilgisi üzerinden yapılır (`src/common/vault-device.ts`,
    `src/main/vault-device.ts`).
  - 14 günde bir ve ana şifre değişince ana şifre istenir.

## Sanal sürücü (Windows)

Ayarlar › Eşitleme'den açılır. Alanlar tek bir klasörde (varsayılan `%USERPROFILE%\Crewhall`) birer klasör
olarak görünür, dosyalar açılana kadar yer kaplamaz. Windows Cloud Files API'sini `native/cloudfiles` eklentisi
sarar, gerisi TypeScript'tir:

- `src/cloud/drive.ts`: kök klasör ve alan klasörleri. Eşitlemeyi sıradan `SyncEngine` yapar; geçiş dosyaları
  indirmek yerine yer tutucu olarak koyar (`Materializer`, `src/cloud/materializer.ts`).
- `src/cloud/mirror.ts`: sunucunun ağacı, bir ilk listeleme ve `drive.changes` akışıyla güncel kalır. Bu
  bilgisayarın yaptığı değişiklikler ağaca hemen yazılır, çünkü akış birkaç saniye geriden gelir ve geçiş
  ağaçta olmayan öğeyi sunucuda silinmiş sayar.
- `src/cloud/fetch-server.ts`: bir program dosyayı okuyunca içeriği sunucudan akıtır.
- `src/cloud/controller.ts`: ayar, sunucu bağlantısı ve oturum açan kişiye göre açar, kapatır.

Yerel değişiklikler klasör izlemeyle ve boyut ile tarih karşılaştırmasıyla bulunur. Windows bir düzenleme için
sağlayıcıyı çağırmaz. Geliştirme çalıştırması Gezgin'e kaydolmaz ve `CrewhallDev` adını kullanır.

Sunucu `drive.changes` yeteneğini sunmuyorsa ya da eklenti yoksa ayar görünmez.

## Bilinen sınırlar

- **Sanal sürücü:** Sınırların tamamı `docs/microsoft.md` §6'da yazılıdır.

- **Kod imzası yok.** Windows'ta SmartScreen ilk kurulumda uyarır. macOS'ta notarize edilemez ve
  Squirrel.Mac imzasız uygulamayı güncellemez; mac kullanıcıları yeni sürümü elle kurar. Sertifika
  gelince `CSC_LINK`/`CSC_KEY_PASSWORD` (Windows) ya da Apple Developer ID değişkenleri verilir
  (`electron-builder.config.cjs`).
- **macOS paketi** yalnız macOS üzerinde üretilebilir. Mac yoksa aynı komut bir CI'ın barındırdığı macOS
  makinesinde çalıştırılır (ör. Azure Pipelines `macos-15` imajı). Çıkan dmg ve zip, Yönetim › Masaüstü
  sürümleri › macOS'a yüklenir.
- **Senkron:**
  - Taşıma ve yeniden adlandırma iki yönde de aynı düğümü korur (kimlik, sürüm geçmişi, paylaşımlar).
    İki taraf aynı öğeye farklı ad verdiyse sunucudaki ad geçerli olur. Yerel adı dosya kimliğinden
    tanımak için disk kimliği gerekir; kimliği olmayan disklerde yalnız boyut ve tarihi birebir tutan
    tek aday eşleşir, gerisi "sil + oluştur" olarak işlenir.
  - Sayfa, pano ve çizim düğümleri eşitlenmez.
  - Büyük klasörlerde her geçiş tüm ağacı listeler. Sunucuda değişiklik akışı (delta) ucu gelince
    hızlanır.
  - Yerelde geçersiz adlar ve yalnız harf büyüklüğüyle ayrılan adlar atlanır, ayarlarda listelenir.
- Kurumun simgesi SVG ise (nativeImage çizemez) tepside ve pencerede Crewhall simgesi kalır.
- Ekran paylaşımında sistem sesi yalnız Windows'ta tüm ekran paylaşılırken gider.
- Uzaktan kontrolde yerel klavye kullanımı kontrolü kendiliğinden geri almaz; yerel fare hareketi,
  Durdur düğmesi ve Ctrl+Alt+Shift+X geri alır.
