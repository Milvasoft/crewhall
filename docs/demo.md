# Saatlik sıfırlanan canlı demo

Crewhall'ı denemek isteyenler için açık bir demo ortamı. Veriler her saat başı kurgusal örnek şirkete (Nova Teknoloji A.Ş.)
geri döner; giriş sayfası örnek hesapları listeler.

**Gerçek bir kurulumda açmayın.** Sıfırlama veritabanını ve dosya deposunu tamamen boşaltır.

## Kurulum

Normal kurulumdaki gibi `docker/.env` hazırlanır ([kurulum.md](kurulum.md)), sonra demo katmanıyla
başlatılır:

```bash
docker compose -f docker/compose.yml -f docker/compose.demo.yml --env-file docker/.env up -d
```

`compose.demo.yml` backend'de `DEMO_MODE=true` açar ve e-postayı kapatır. İlk açılışta veritabanı boşsa
örnek veri hemen yüklenir; sonra her saat başı (UTC) yeniden yüklenir.

## Demoda ne farklı

- Giriş sayfasında her rol için bir örnek hesap görünür (sahip, yönetici, üye, misafir). Birine tıklayınca
  e-posta ve şifre dolar.
- Uygulamanın altında "Canlı demo · veriler N dk sonra sıfırlanır" yazısı durur.
- İki adımlı doğrulama istenmez; ziyaretçiler hesapları paylaşır.
- Başkalarını dışarıda bırakabilecek işlemler kapalıdır:
  - şifre, e-posta ve iki adımlı doğrulama değişikliği, hesabı silme, profil güncelleme,
  - güvenlik politikası, kimlik sağlayıcıları (SSO), üye rolü ve durumu,
  - yedek ayarları ve elle yedek.
- Kurum ayarları her sıfırlamada şöyle gelir:
  - herkese açık linkler kapalı,
  - depolama kotası 1 GB,
  - tek dosya en çok 25 MB.

## Nasıl çalışır

- Sıfırlama API sürecinde çalışır (`services/demo.ts`), çünkü örnek veri gerçek kurulum ve davet
  servisleriyle oluşturulur.
- Birden çok API kopyası varsa Postgres kilidi sayesinde yalnız biri sıfırlar. Demo için tek kopya yeterlidir.
- Uygulama tabloları boşaltılır; migration ve iş kuyruğu tabloları kalır. Bucket'taki bütün dosyalar
  silinir. Sonra demoya özel, tamamen kurgusal örnek veri (`services/demo-seed.ts`, `services/demo-data.ts`) yüklenir: Drive, hızlı erişim, sohbet, sayfalar, pano ve çizim. Geliştirme seed'i (`pnpm seed`) demoda hiç kullanılmaz.
