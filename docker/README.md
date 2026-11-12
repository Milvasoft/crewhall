# Docker

Compose dosyaları ve Caddy yapılandırması. Kurulumun kendisi `docs/contracts/backend-calistirma.md`
ve `tools/crewhall` içindedir. Bu dosya şimdilik masaüstü uygulamasının dağıtımını anlatır.

## Masaüstü uygulaması güncellemeleri

Masaüstü uygulaması (`apps/desktop`) kurulum dosyasını ve güncellemelerini kurumun kendi Crewhall
sunucusundan alır. Ayrı bir güncelleme sunucusu yoktur.

- **Besleme:** backend `DESKTOP_UPDATES_DIR` klasörünü (orada olmayan dosyaları S3 deposundan, bkz.
  Seçenek 3) `/api/v1/desktop/updates/<win|mac>/<dosya>` adresinden sunar.
  - Oturum gerekmez.
  - IP başına hız sınırı vardır.
  - Range isteği desteklenir. Fark indirmesi bu sayede yalnız değişen blokları indirir.
- **Arayüz:** kurulum dosyası Hesabım › Güvenlik ve giriş sayfasında indirilebilir. Sunucudaki sürüm
  Yönetim › Genel'de görünür.
- **Klasör boşsa ya da yoksa:** uç 404 döner. Uygulama bunu "güncelleme yok" sayar. İndirme
  bağlantıları da görünmez.

Klasör düzeni (`pnpm --filter @crewhall/desktop publish:updates` üretir):

```
desktop-updates/
├─ win/
│  ├─ latest.yml
│  ├─ Crewhall-Setup-0.2.0.exe
│  ├─ Crewhall-Setup-0.2.0.exe.blockmap
│  └─ Crewhall-Setup-0.1.0.exe.blockmap   ← eski blockmap'ler fark indirmesi için kalır
└─ mac/
   ├─ latest-mac.yml
   ├─ Crewhall-0.2.0-mac.zip   (uygulamanın kendini güncellemesi için)
   └─ Crewhall-0.2.0-mac.dmg   (indirme bağlantısı için)
```

Yeni bir sürüm şöyle hazırlanır:

1. `apps/desktop/package.json` içindeki `version` artırılır.
2. Şu komutlar çalıştırılır:

```bash
pnpm --filter @crewhall/desktop dist:win
```

```bash
pnpm --filter @crewhall/desktop publish:updates
```

Çıktı `apps/desktop/updates/` altına düşer (git'e girmez). Uygulama yalnız sunucudaki sürüm kendi
sürümünden yeniyse güncellenir; sürüm düşürme yapılmaz.

### Seçenek 1: imajın içinde

`apps/backend/Dockerfile` derlerken `apps/desktop/updates/` klasörü varsa onu
`/app/desktop-updates` içine kopyalar. İmajda `DESKTOP_UPDATES_DIR=/app/desktop-updates` zaten
tanımlıdır.

```bash
docker build -f apps/backend/Dockerfile -t crewhall/backend .
```

- **Artısı:** sürüm ve imaj birlikte gider; ek ayar yoktur.
- **Eksisi:** imaj kurulum dosyası kadar büyür (Windows ~110 MB). Masaüstü sürümü değişince imaj
  yeniden derlenir.

### Seçenek 2: volume

İmajdaki klasör boş kalır. Sunucudaki bir klasör onun üzerine bağlanır, `compose.yml` içinde
`backend` servisine:

```yaml
volumes:
  - ./desktop-updates:/app/desktop-updates:ro
```

Yeni sürüm yayımlamak için `apps/desktop/updates/` içeriği sunucudaki `./desktop-updates/` klasörüne
kopyalanır (`rsync`, `scp`). Yeniden başlatma gerekmez; sunucu bootstrap bilgisini 30 saniyede bir
yeniden okur.

- **Artısı:** imaj küçük kalır. Masaüstü sürümü backend'den bağımsız yayımlanır.
- **Eksisi:** sunucuya dosya kopyalama adımı gerekir.

Kurum içi kurulumlar için önerilen yol **volume**'dür: masaüstü sürümleri backend'den daha seyrek ve
ayrı bir takvimle çıkar.

### Seçenek 3: S3

Dosyalar uygulamanın kullandığı S3 deposuna (`S3_BUCKET`) elle yüklenir, örneğin SeaweedFS ya da S3
konsolundan sürükle-bırak ile. Ek ayar gerekmez.

En kolay yol **Yönetim › Masaüstü sürümleri** sayfasıdır (kurulum kurumunun sahibi, yedeklerdeki gibi). Dosyalar sürükle-bırak
ile bu öneke yüklenir, "Yayınla" `latest.yml`ı sunucunun kendisi yazar (sha512 ve boyut hesaplanır), eski bir
sürümü yayınlamak geri almadır. Aşağıdaki elle yükleme yolu da çalışmaya devam eder.

- **Sıra:** backend bir dosyayı önce `DESKTOP_UPDATES_DIR` klasöründe arar, orada yoksa S3'te arar.
  İmajdaki klasör boşsa her şey S3'ten gelir. Klasörde dosya olan bir kurulum bugünkü gibi çalışır.
- **Önek:** `desktop-updates/<win|mac>/<dosya>`. `DESKTOP_UPDATES_S3_PREFIX` ile değişir (varsayılan
  `desktop-updates/`).
- **Sunum:** dosyalar yine `/api/v1/desktop/updates/<win|mac>/<dosya>` adresinden sunulur. Backend
  S3'ten okuyup aktarır (yönlendirme yok). Range istekleri S3'e aynen geçer, fark indirmesi çalışır.
  Aynı anda birden çok aralık isteyen istekte bütün dosya döner (klasörle aynı davranış).
- **Bilgi:** sürüm bilgisi (Yönetim › Genel, Hesabım indirme bağlantısı) `latest.yml`'dan okunur ve 30
  saniye önbelleklenir. Dosya yoksa uç 404 döner; uygulama bunu "güncelleme yok" sayar.

Yüklenecek dosyalar:

```
desktop-updates/
├─ win/
│  ├─ latest.yml
│  ├─ Crewhall-Setup-0.2.0.exe
│  └─ Crewhall-Setup-0.2.0.exe.blockmap   (eski sürümlerin blockmap'leri de kalabilir)
└─ mac/
   ├─ latest-mac.yml
   ├─ Crewhall-0.2.0-mac.zip
   └─ Crewhall-0.2.0-mac.dmg
```

`latest.yml` electron-builder'ın ürettiği dosyadır. Elle düzeltmek gerekirse içeriği şöyledir:

```yaml
version: 0.2.0
files:
  - url: Crewhall-Setup-0.2.0.exe
    sha512: <base64 SHA-512>
    size: 114857600
path: Crewhall-Setup-0.2.0.exe
sha512: <base64 SHA-512>
releaseDate: '2026-10-23T08:00:00.000Z'
```

- `version` uygulamanın `package.json` sürümüdür. Uygulama yalnız kendi sürümünden yenisine güncellenir.
- `files[].url` ve `path` aynı klasördeki dosyanın adıdır, birebir aynı yazılmalıdır (büyük-küçük harf
  dahil, klasör yolu yok).
- `sha512` dosyanın SHA-512 özetidir, **base64** olarak (hex değil):
  `openssl dgst -sha512 -binary Crewhall-Setup-0.2.0.exe | openssl base64 -A`. Yanlışsa uygulama indirdiği
  dosyayı reddeder.
- `size` bayt cinsinden dosya boyutudur. İndirme bağlantısının gösterdiği boyut buradan gelir.
- macOS'ta `latest-mac.yml` zip ve dmg'yi ayrı `files` girdileri olarak listeler. Güncelleme zip'i,
  indirme bağlantısı dmg'yi kullanır.
- `releaseDate` ISO tarihtir ve bilgi amaçlıdır.

### İmza

Kod imzalama sertifikası henüz yok.

- **Windows:** SmartScreen ilk kurulumda uyarır ("Ek bilgi" › "Yine de çalıştır"). Güncellemeler yine
  de kendiliğinden kurulur.
- **macOS:** uygulama ilk açılışta sağ tık › Aç ile açılır. Squirrel.Mac imzasız uygulamayı
  güncellemez, kullanıcı yeni sürümü indirme bağlantısından elle kurar.
