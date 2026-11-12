# Crewhall tarayıcı eklentisi

Chrome ve Edge için Manifest V3 eklentisi. Kasadan sitelere şifre doldurur, giriş sonrası kaydetmeyi sorar ve
sayfaları, görselleri, seçili metni tek tıkla Crewhall'a gönderir.

## Özellikler

| Modül | Eklentide |
|---|---|
| Kasa | Sitenin kayıtları, tıklayınca doldurma, TOTP, güçlü şifre üretme, giriş sonrası kaydet / güncelle sorusu |
| Drive | Sağ tık: resmi ya da bağlantıdaki dosyayı kaydet. Ekran görüntüsü. Açık dosyayı kaydet |
| Sayfalar | Seçimi ya da sayfayı Markdown olarak yeni sayfaya veya mevcut sayfaya ekle |
| Chat | Sayfayı, seçimi, resmi ya da ekran görüntüsünü kişiye veya kanala gönder |
| Hızlı erişim | Siteyi ya da bağlantıyı karta ekle. Adres çubuğunda `ch` ve boşluk ile arama |
| Panolar, Takvim | Seçimden kart, seçimdeki tarihten etkinlik |
| Genel | Okunmamış bildirim rozeti, yan panelde asistan (asistan kapalıysa arama) |

Chrome, eklentilerin kayıtlı şifreleri okumasına izin vermez. Toplu taşıma için Chrome'un dışa aktardığı CSV,
Crewhall'ın Kasa › İçe aktar ekranına yüklenir; dosya tarayıcıda okunur.

## Komutlar

```bash
pnpm --filter @crewhall/extension build     # dist/: yüklenebilir eklenti
pnpm --filter @crewhall/extension test      # Vitest
pnpm --filter @crewhall/extension package   # release/crewhall-extension-<sürüm>.zip (önce build)
```

**Denemek için:** `chrome://extensions` › Geliştirici modu › Paketlenmemiş öğe yükle › `apps/extension/dist`. Ayarlar
sayfasından Crewhall adresini girip bağlan.

## Mimari

- **Service worker (`src/background`):** kasa, doldurma, kaydetme sorusu, sağ tık menüsü, rozet, adres çubuğu.
- **Sayfalar (`src/ui`):** açılır pencere, ayarlar, gönderme penceresi, yan panel ve kaydetme sorusu.
- **İçerik betiği (`src/content/capture.ts`):** yalnız kasa özelliği açıkken kaydedilir, giriş formlarını izler.
- **Sunucu:** web ve mobilin kullandığı `/api/v1` sözleşmesi (`@crewhall/api-client`), bearer oturumla.

**Oturum açma:** eklenti Crewhall'ın `/mobile-login` sayfasını PKCE ile açar. Şifre, 2FA ve passkey o sayfada kalır,
kullanıcı onaylayınca bu tarayıcı için ayrı bir oturum açılır. Sunucu kodu yalnız `BROWSER_EXTENSION_IDS` listesindeki
eklentiye gönderir.

**İzinler:** kurulumda hiçbir site istenmez. Crewhall adresi bağlanırken, bütün siteler kasa özelliği açılırken, başka
bir sitenin dosyası da ilk indirmede istenir.

## Kasa güvenliği

- Zero-knowledge web ve mobildeki gibidir. Kasa şifresi eklentiden çıkmaz, Argon2id ve şifre çözme service worker'da
  çalışır (`wasm-unsafe-eval` bunun içindir).
- Özel anahtar yalnız `chrome.storage.session` içindedir: bellekte durur, tarayıcıyla gider, içerik betikleri okuyamaz.
  Kasa ayarlardaki süre (varsayılan 10 dakika) boşta kalınca ve bilgisayar kilitlenince kapanır.
- Doldurma yalnız kullanıcı tıklayınca olur. Sayfa açılınca kendiliğinden doldurma yoktur.
- Şifre yalnız adresi kayıtla birebir eşleşen çerçeveye gider: aynı alan adı ve port (`www` hariç), alt alan adları
  sayılmaz. `https` kaydı `http` sayfasında sunulmaz, şifreli olmayan sayfalarda doldurma kapalıdır (yerel adresler
  hariç).
- Kaydetme sorusu sayfanın okuyamadığı bir eklenti çerçevesindedir ve şifreyi hiç almaz. Düğmeleri, tarayıcı çerçevenin
  gerçekten göründüğünü bildirmeden açılmaz; böylece sayfa tıklamayı çalamaz. Yalnız kullanıcının kendi gönderdiği formlar
  yakalanır, Crewhall'ın kendi sayfalarında betik çalışmaz.
- İçerik betikleri service worker'dan yalnız `capture.submitted` ve `capture.check` isteyebilir.

## Mağazaya yükleme

1. `build` ve `package` komutlarını çalıştır, `release/` altındaki zip'i Chrome Web Store geliştirici panosuna yükle.
2. Görünürlüğü **Liste dışı** seç. Gizlilik politikası adresi ve izin gerekçeleri istenir; gerekçeler bu dosyadaki
   İzinler bölümünden yazılabilir.
3. Mağaza manifestte `key` alanını kabul etmez, `package` komutu onu zip'ten çıkarır ve mağaza öğeye kendi kimliğini verir.
   Panodaki kimliği `packages/shared/src/schemas/auth.ts › BROWSER_EXTENSION_IDS` listesine ekle ve sunucuyu yayınla, yoksa
   mağazadan kurulan eklenti oturum açamaz. `dist/` klasöründen yüklenen yerel derleme `key` ile sabit kimliğini korur.

Özel imzalama anahtarı depoda tutulmaz. Kendi kopyanı dağıtacaksan yeni bir anahtar üret, açık anahtarı manifeste,
kimliği listeye yaz.
