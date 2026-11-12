# Sürüm uyumluluğu

Karar tarihi: 2026-10-23. Her kurum kendi Crewhall sunucusunu kendi takviminde günceller. Mobil, masaüstü ve web
istemcileri bağlandıkları sunucunun sürümüne uyum sağlar.

## İlkeler

1. **Sürüme değil yeteneğe bakılır.** İstemci "sunucu 1.5 mi" diye bakmaz, "sunucu `mail.bulk` destekliyor mu" diye
   bakar. Desteklenmeyen özellik gizlenir ya da kapalı gösterilir.
2. **API yalnız eklenerek değişir.** `/api/v1` altında uç, alan ya da tip silinmez, daraltılmaz. Yeni uç ve isteğe
   bağlı alan serbesttir. Kaldırılacak bir şey önce `deprecated: { since, removeAfter }` ile işaretlenir, yanıtta
   `Deprecation` / `Sunset` başlığı gider, en az iki sunucu sürümü boyunca kalır.
3. **İki yönlü kapı.**
   - İstemci çok eskiyse: sunucu `426 client_outdated` döner, istemci "Güncelle" ekranı gösterir.
   - Sunucu çok eskiyse: istemci "Sunucunuz eski, bazı özellikler kapalı" bandı gösterir ve desteklenen kısımla
     çalışır.

## Sunucunun bildirdikleri

`bootstrap` yanıtında:

- `server.version`: sunucunun semver sürümü.
- `server.apiLevel`: tam sayı, her sözleşme eklemesinde artar.
- `server.capabilities`: yetenek listesi (`packages/shared` içinde merkezi liste; sunucuda açık modüllere ve kurum
  ayarlarına göre süzülür).
- `minClientVersion`: `{ ios, android, desktop }` (env ile ayarlanır).
- `clientStatus`: `ok` ya da `outdated` (istek başlığına göre).

`GET /api/v1/meta/compat` (herkese açık): sunucu sürümü, apiLevel, desteklenen istemci aralıkları ve kaldırılacaklar
listesi.

## İstemcinin bildirdiği

Her istekte `X-Crewhall-Client: <platform>/<semver>` (`ios`, `android`, `desktop`, `web`). Başlık yoksa (web, eski
uygulama) engelleme yapılmaz.

## Platformlara göre

| Platform | Arayüz nereden gelir | Uyum yolu |
|---|---|---|
| Web | Kurumun sunucusundan | Her zaman sunucuyla aynı sürüm |
| Masaüstü | Kurumun sunucusundan (kabuk `loadURL` ile yükler) | Kabuk güncellemesini kurumun sunucusundan alır. Köprü özellikleri `crewhallDesktop.features` ile sorulur, web sürüme değil özelliğe bakar |
| Mobil | Uygulamanın içinde (mağazadaki tek sürüm) | `capabilities` ile özellik açma, `426` ile güncelleme ekranı, eski sunucu bandı |

## Destek aralığı ve test

- Her mobil sürüm en az son **3 sunucu minor sürümü** (ya da 6 ay) ile çalışacak şekilde tutulur.
- `packages/shared/contract-snapshot.json`, son yayımlanan sürümün sözleşmesidir. CI'daki kontrol, uç ya da alan
  silinmesini, tip daraltılmasını yakalar ve derlemeyi düşürür.
- Sunucu sürümleri semver ve sürüm notlarıyla yayımlanır. Notlarda yeni yetenekler ve kaldırılacaklar yazar.

## İş dağılımı

- Backend: bootstrap alanları, istemci başlığı ve 426, `meta/compat`, sözleşme anlık görüntüsü ve CI kontrolü,
  deprecation başlıkları.
- Mobil: istemci başlığı, `useCapability`, "Güncelle" ekranı, eski sunucu bandı.
- Masaüstü: `crewhallDesktop.version` / `features`, istemci başlığı, 426'da kendi güncelleme ekranı.
- Web: `desktopHas(...)` yardımcısı; köprü çağrıları bunun üzerinden.
