# İngilizce URL'ler (2026-10-23)

Kullanıcı kararı: uygulamanın hiçbir yerinde Türkçe URL olmayacak. Arayüz metinleri Türkçe kalır, adres
çubuğundaki yollar İngilizcedir.

## Kurallar

- Tek kaynak `packages/shared/src/paths.ts`: yol üreticileri (ör. `paths.invite(token)`) ve eski → yeni
  eşleme tablosu (`LEGACY_PATH_RULES`). Backend, web, mobil ve masaüstü yolları buradan alır, elle yol
  yazmaz.
- Eski Türkçe yollar kırılmaz:
  - **Web:** eski yola gelen istek yeni yola `replace` ile yönlenir; sorgu ve hash korunur.
  - **Mobil ve masaüstü:** bildirim `url`'si ve derin linkler eski biçimde de gelebilir (veritabanındaki
    eski bildirimler, gönderilmiş e-postalar); ikisini de tanırlar.
- **Çakışma:** backend yolları `/api /ws /mcp /dav /caldav /carddav /collab /healthz /readyz /.well-known
  /oauth/authorize|register|token|revoke` Traefik'te önek olarak eşleşir. Hiçbir web yolu bunlarla
  başlayamaz.
  - Bugünkü hata: `/davet/...` `/dav` önekine takılıp backend'e gidiyor, davet linki 404 veriyor.
  - Backend, eski e-postalardaki `/davet/:token` isteklerini `/invite/:token`'a 301 ile yönlendirir.
- Kullanıcıya görünen slug'lar (space, site) zaten kullanıcının verdiği addır; bu karar onlara dokunmaz.

## Eşleme

| Eski | Yeni |
| --- | --- |
| `/bildirimler` | `/notifications` |
| `/chat/ara`, `/chat/yeni` | `/chat/search`, `/chat/new` |
| `/chat/c/:id/dosyalar`, `/sabitlenenler` | `/chat/c/:id/files`, `/pinned` |
| `/cizimler/:space` | `/drawings/:space` |
| `/drive/:space/cop-kutusu`, `/drive/:space/k/:folder` | `/drive/:space/trash`, `/drive/:space/folder/:folder` |
| `/drive/ara`, `/drive/son` | `/drive/search`, `/drive/recent` |
| `/duyurular[/:id]` | `/announcements[/:id]` |
| `/formlar/:space`, `/formlar/f/:id/sonuclar`, `/formlar/y/:id` | `/forms/:space`, `/forms/f/:id/results`, `/forms/edit/:id` |
| `/hesap` | `/account` |
| `/hesap/gorunum`, `/guvenlik`, `/profil`, `/webdav` | `/account/appearance`, `/security`, `/profile`, `/webdav` |
| `/hesap/mcp`, `/mcp/api`, `/mcp/belgeler`, `/mcp/etkinlik`, `/mcp/istemci/:id` | `/account/mcp`, `/mcp/api`, `/mcp/docs`, `/mcp/activity`, `/mcp/client/:id` |
| `/hesap/onaylar[/:id]` | `/account/approvals[/:id]` |
| `/kasa` | `/vault` |
| `/kasa/:v/erisim`, `/kasa/ayarlar`, `/gunluk`, `/ice-aktar`, `/saglik` | `/vault/:v/access`, `/vault/settings`, `/log`, `/import`, `/health` |
| `/kisiler/:id` | `/people/:id` |
| `/otomasyonlar/:space[/yeni]`, `/otomasyonlar/k/:id` | `/automations/:space[/new]`, `/automations/rule/:id` |
| `/panolar/:space`, `/b/:id/ayarlar` | `/boards/:space`, `/b/:id/settings` |
| `/posta[/ayarlar]` | `/mail[/settings]` |
| `/rehber`, `/kisiler`, `/sema`, `/sirketler` | `/contacts`, `/people`, `/org-chart`, `/companies` |
| `/sayfalar/:space`, `/sayfalar/ara` | `/pages/:space`, `/pages/search` |
| `/spaces/:s/ayarlar` | `/spaces/:s/settings` |
| `/takvim` | `/calendar` |
| `/toplantilar`, `/oda/:slug`, `/ozet/:id` | `/meetings`, `/meetings/room/:slug`, `/meetings/summary/:id` |
| `/yonetim` | `/admin` |
| `/yonetim/...` | `bildirim-gonderimi`→`delivery`, `entegrasyonlar[/kimlik/:id\|yeni]`→`integrations[/identity/:id\|new]`, `federasyon`→`federation`, `genel`→`general`, `guvenlik`→`security`, `istatistikler`→`stats`, `marka`→`brand`, `masaustu`→`desktop`, `posta`→`mail`, `spaceler`→`spaces`, `tema`→`theme`, `uyeler[/:id]`→`members[/:id]`, `uyumluluk`→`compliance`, `yapay-zeka`→`ai`, `yedekler`→`backups` (`mcp`, `sso` aynı) |
| `/davet/:token` | `/invite/:token` |
| `/guvenlik/2fa-kur` | `/security/2fa-setup` |
| `/kasa-paylasim/:token` | `/vault-share/:token` |
| `/kurulum` | `/setup` |
| `/login/2fa/yedek` | `/login/2fa/backup` |
| `/mobil-giris` | `/mobile-login` |
| `/oauth/onay`, `/oauth/tamam` | `/oauth/consent`, `/oauth/done` |
| `/sifre-yenile`, `/sifremi-unuttum` | `/reset-password`, `/forgot-password` |
| `/sso/onay` | `/sso/consent` |
| `/$module/...` modül slug'ları | Türkçe olanlar İngilizce modül adına (ör. `sayfalar`→`pages`) |

`/m/:slug`, `/f/:token`, `/s/:token`, `/p/:ref`, `/d/:id`, `/b/:id`, `/chat`, `/drive`, `/portal/...`
aynı kalır. Tabloda olmayan Türkçe bir yol bulunursa aynı mantıkla çevrilip tabloya eklenir.

## Sorgu parametreleri ve slug'lar

Sorgu anahtarları ve değerleri de İngilizcedir; tam liste `paths.ts` içindedir:

- `LEGACY_QUERY_KEYS`: örneğin `etkinlik`→`event`, `tarih`→`date`, `gorunum`→`view`, `klasor`→`folder`,
  `filtre`→`filter`, `sekme`→`tab`, `yorum`→`comment`, `aktarim`→`export`.
- `LEGACY_QUERY_VALUES` ve `LEGACY_QUERY_VALUES_BY_ROOT`: örneğin `view` için `gun/hafta/ay/ajanda`→
  `day/week/month/agenda`. Drive'a özel olarak `g=izgara`→`view=grid`.
- `VAULT_CATEGORY_SLUGS`: `tumu/favoriler/girisler/notlar/kartlar/api-anahtarlari/ssh-anahtarlari/
  kimlikler/cop` → `all/favorites/logins/notes/cards/api-keys/ssh-keys/identities/trash`.

`toCurrentPath` bunları da çevirir. Kayıtlı bildirimlerin `url`'si okunurken çevrilir; veritabanında göç yoktur.
Sunucu `paths.english` yeteneğini (API_LEVEL 8) bildirir: masaüstü ve mobil bu yetenek yoksa eski yolları
kullanır.
