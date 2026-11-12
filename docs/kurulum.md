# Kurulum (temiz sunucu)

Bu belge Crewhall'ı tek bir Linux sunucuya Docker Compose ile kurmayı anlatır. Yığın
`docker/compose.yml` dosyasıdır.

Her zaman çalışan servisler:

| Servis | Görevi |
| --- | --- |
| caddy | TLS ve yönlendirme: `/api`, `/ws`, `/mcp` ve OAuth yolları backend'e, `/collab` collab'a, gerisi web'e |
| web | Arayüz (statik SPA) |
| backend | API, better-auth, `/ws` (chat, presence, bildirim) ve `/mcp` |
| worker | Arka plan işleri: önizleme, link kontrolü, push, e-posta özeti, gece temizliği |
| collab | Sayfa ve pano kartlarında ortak düzenleme (Hocuspocus) |
| postgres | Veritabanı (Postgres 17) |
| seaweedfs | S3 uyumlu dosya deposu |

backend, worker ve collab aynı imajdır, yalnız komutları farklıdır.

İsteğe bağlı profiller:

| Profil | Servisler | Ne zaman açılır |
| --- | --- | --- |
| `portal` | portal (Next.js belge sitesi) | Hub'da bir portal sitesi oluşturulunca (§ 6) |
| `meet` | livekit, egress, coturn, valkey | Toplantı kullanılacaksa (§ 7) |

Dokploy kullanıyorsan aynı compose dosyasını "Compose" uygulaması olarak ekleyip `docker/.env`
değişkenlerini arayüzden girebilirsin.

## 1. Gereksinimler

- Linux sunucu: en az 2 vCPU, 4 GB RAM ve dosyalar için yeterli disk.
- Docker Engine 24+ ve Compose v2 (`docker compose version`).
- Alan adları, hepsi sunucunun IP'sine yönlenmiş A/AAAA kayıtlarıyla:
  - `hub.ornek.com`: uygulama ve API.
  - `s3.ornek.com`: dosya yükleme ve indirme. Tarayıcı bu adrese doğrudan bağlanır.
  - İsteğe bağlı: `docs.ornek.com` (portal sitesi) ve `lk.ornek.com` (toplantı sinyali).
- Dışarıya açık 80 ve 443 portları. Caddy sertifikaları Let's Encrypt'ten kendisi alır.
- Giden e-posta için bir SMTP hesabı (önerilir). SMTP olmadan davetler bağlantı olarak paylaşılır,
  şifre sıfırlama ve bildirim e-postaları gitmez.

## 2. Kodu al ve ortam dosyasını hazırla

```bash
git clone <repo-adresi> crewhall && cd crewhall
cp docker/.env.example docker/.env
```

`docker/.env` içinde değiştirilmesi gerekenler:

| Değişken | Ne yazılır |
| --- | --- |
| `HUB_DOMAIN`, `S3_DOMAIN` | Yukarıdaki iki alan adı |
| `ACME_EMAIL` | Sertifika uyarıları için e-posta |
| `POSTGRES_PASSWORD` | Uzun rastgele parola |
| `AUTH_SECRET` | `openssl rand -base64 32` çıktısı |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Rastgele anahtar ve parola (SeaweedFS bunlarla açılır) |
| `SMTP_URL`, `MAIL_FROM` | `smtp://kullanici:parola@smtp.ornek.com:587` ve gönderen adresi |
| `SETUP_TOKEN` | Boş bırakılabilir; boşsa ilk açılışta rastgele üretilip loga yazılır |

`AUTH_SECRET` sonradan değişirse bütün oturumlar düşer ve kayıtlı 2FA sırları okunamaz.
Bu dosyayı yedekle ve git'e koyma (zaten `.gitignore`'da).

Sunucuda 80/443 başka bir yazılımdaysa ya da önünde başka bir ters vekil varsa portları ve genel
adresleri değiştirebilirsin:

- `HTTP_PORT`, `HTTPS_PORT`: Caddy'nin sunucuda dinlediği portlar (varsayılan 80 ve 443).
- `HUB_URL`, `S3_PUBLIC_URL`, `COLLAB_PUBLIC_URL`, `PORTAL_PUBLIC_URL`: tarayıcının gördüğü tam
  adresler. Port 443 değilse portu da içermeleri gerekir, örneğin `https://hub.ornek.com:8443`.

## 3. Başlat

```bash
docker compose -f docker/compose.yml --env-file docker/.env up -d --build
docker compose -f docker/compose.yml --env-file docker/.env ps
```

- İlk açılışta imajlar derlenir. Bu birkaç dakika sürer.
- Backend açılırken migration'ları kendisi çalıştırır. `backend` servisi `healthy` olunca worker başlar.
- Hazır imaj kullanıyorsan `CREWHALL_REGISTRY` ve `CREWHALL_VERSION` değişkenlerini ayarla,
  `--build` yerine `pull` ile çalıştır.

Kontrol:

```bash
curl -s https://hub.ornek.com/readyz
```

Komut `{"status":"ready"}` döndürmelidir.

## 4. İlk kurulum sihirbazı

1. Kurulum anahtarını loglardan al:

   ```bash
   docker compose -f docker/compose.yml --env-file docker/.env logs backend | grep -i "setup"
   ```

2. Tarayıcıda `https://hub.ornek.com` adresini aç. Sihirbaz önce kurulum anahtarını ister, ardından
   şunları sorar:
   - Kurum adı ve adresi.
   - Sahip hesabı (e-posta ve şifre).
   - İlk space'ler.
   - SMTP testi.
3. Sahip ilk girişte iki adımlı doğrulamayı (TOTP ya da passkey) açmak zorundadır.
4. Kurum adı, logo ve renkler sonradan "Yönetim › Marka" ekranından değiştirilebilir.
5. Kişileri "Yönetim › Kişiler › Davet et" ekranından çağır.

Kurulum bitince anahtar bir daha işe yaramaz.

## 5. Kurulumu doğrula (isteğe bağlı, otomatik)

Sihirbazı elle yapmak yerine, **yeni** bir kurulumu tek betikle uçtan uca deneyebilirsin. Betik
tarayıcının izlediği yolu Caddy üzerinden izler:

1. Sihirbaz, sahip girişi ve TOTP.
2. S3 alan adı üzerinden dosya yükleme ve indirme.
3. Bir sayfayı iki ortak düzenleme istemcisiyle aynı anda düzenleme (`/collab`).
4. Chat mesajının WebSocket'ten (`/ws`) gelmesi.
5. Bir portal sitesi ve onun içerik anahtarı.

Betik geliştirme makinesinde, repo kökünde çalışır (`pnpm install` yapılmış olmalı):

```bash
STACK_URL=https://hub.ornek.com STACK_SETUP_TOKEN=<kurulum anahtarı> \
  pnpm --filter @crewhall/backend accept:stack
```

- Betik çalışırken "Kurulum Deneme" kurumunu ve bir sahip hesabı oluşturur.
- Gerçek kurulumu sihirbazla yapacaksan betiği yalnız deneme kurulumunda çalıştır, ardından
  `down -v` ile sıfırla.
- `*.localhost` adlarıyla yapılan yerel denemede `STACK_INSECURE=1` ekle; Caddy'nin yerel
  sertifikası kabul edilir.

## 6. Portal sitesi (profil `portal`)

1. Hub'da "Portal › Siteler"den siteyi oluştur. "Ayarlar"da içerik anahtarını üret.
2. `docker/.env` dosyasına şunları yaz:
   - `PORTAL_DOMAIN=docs.ornek.com`
   - `PORTAL_CONTENT_TOKEN=<anahtar>`
   - `PORTAL_REVALIDATE_SECRET`: `openssl rand -base64 32` çıktısı.
3. Başlat:

   ```bash
   docker compose -f docker/compose.yml --env-file docker/.env --profile portal up -d --build
   ```

   Siteyi `https://docs.ornek.com` adresinden kontrol et.
4. Yayınlanan değişiklikler, Hub'ın imzalı `/api/revalidate` çağrısıyla birkaç saniye içinde sitede
   görünür. Sayfa önbelleği `portal-cache` hacmindedir.

## 7. Toplantılar (profil `meet`)

LiveKit, egress ve coturn ağırlıklı UDP trafiği yüzünden sunucunun ağında (host network) çalışır.

1. `docker/.env` dosyasına şunları yaz:
   - `LK_DOMAIN=lk.ornek.com`
   - `LIVEKIT_API_KEY` ve `LIVEKIT_API_SECRET` (rastgele).
   - `TURN_USER`, `TURN_PASSWORD`; gerekirse `TURN_DOMAIN`.
   - Kayıt için egress de çalışacaksa `MEET_EGRESS_ENABLED=true`. Egress 2-4 GB RAM ister.
2. Güvenlik duvarında şu portları aç:
   - 7881/tcp
   - 50000-60000/udp
   - 3478/udp ve 3478/tcp
   - 49160-49200/udp
3. Başlat:

   ```bash
   docker compose -f docker/compose.yml --env-file docker/.env --profile meet up -d
   ```

Anahtarlar boş kaldığı sürece toplantı uçları `503 meet_unavailable` döner; geri kalan her şey
çalışır.

### Medya bağlanmıyorsa (sinyal var, ses/görüntü yok)

Belirti: toplantıya girilir ama mikrofon ve kamera açılmaz, tarayıcı konsolunda
`NegotiationError: negotiation timed out` ve sürekli yeniden bağlanma görünür. Odada
"Ses ve görüntü sunucuya ulaşamıyor" uyarısı çıkar; uyarıdaki "Yayın / Alış" satırı ICE durumunu
gösterir (`checking` ya da `failed` kalıyorsa medya yolu kapalıdır). Sinyal (WebSocket, 443) ile medya
(WebRTC) ayrı yollardır; ikincisi doğrudan sunucuya ulaşmalıdır.

- **DNS:** `lk.ornek.com` kaydı doğrudan sunucunun IP'sine gitmeli. Cloudflare kullanılıyorsa bu kayıtta
  proxy **kapalı** olmalı (gri bulut). Cloudflare yalnız HTTP/WebSocket taşır; UDP'yi ve 7881/TCP'yi geçirmez.
- **Güvenlik duvarı ve bulut sağlayıcının ağ kuralları:** 7881/tcp, 50000-60000/udp, 3478/udp+tcp ve
  49160-49200/udp sunucuya açık olmalı (hem işletim sisteminin duvarı hem sağlayıcının güvenlik grubu).
- **Duyurulan adres:** LiveKit istemcilere kendi IP'sini bildirir. Compose'taki yapılandırma
  `rtc.use_external_ip: true` ile dış IP'yi STUN üzerinden bulur. Sunucu NAT arkasındaysa ve bu çalışmıyorsa
  `rtc.node_ip: <dış IP>` verilmelidir; iç IP duyurulursa dışarıdan kimse bağlanamaz.
- **Kısıtlı ağlar (yalnız 443 açık kurum ağları):** coturn 3478'de TLS'siz çalışır. Bu ağlardan katılım
  gerekiyorsa TURN'ü 443/TLS'ten sunun: coturn'e sertifika ve `--tls-listening-port=443`, ya da LiveKit'in
  yerleşik TURN'ü (`turn.enabled: true`, `turn.tls_port: 443`, `turn.domain`). 443 başka bir hizmetteyse ayrı
  bir IP ya da alan adı gerekir.
- **Kontrol:** başka bir ağdan (ör. telefonun mobil verisi) `nc -vz lk.ornek.com 7881` başarılı olmalı;
  LiveKit günlüğünde katılımcı için ICE bağlantısının kurulduğu görünmeli.
- **`rtc/v1 … 404` / `v1 RTC path not found` uyarısı zararsızdır:** web istemcisi (livekit-client 2.23) önce
  yeni sinyal yolunu dener, 1.9.x sunucuda bulamayınca eskisine düşer. Sunucuyu güncel LiveKit sürümüne
  yükseltmek uyarıyı kaldırır; medya sorununun sebebi bu değildir.

## 8. Mobil uygulama

Uygulamada "Sunucu adresi" alanına `https://hub.ornek.com` yaz. QR ile bağlanmak için web'de
"Hesabım › Mobil" ekranı kullanılır.

`MIN_MOBILE_VERSION` değişkeni, sunucunun kabul ettiği en eski uygulama sürümünü belirler.

Mobil bildirimler (push) Firebase Cloud Messaging üzerinden gider. Firebase konsolundan servis hesabı
anahtarını (JSON) indir, tek satıra çevirip `docker/.env` dosyasına yaz:

```bash
echo "FIREBASE_SERVICE_ACCOUNT_JSON=$(jq -c . firebase-admin.json)" >> docker/.env
```

Bu değişken boşken FCM'e kayıtlı cihazlara push gitmez; uygulama içi bildirimler çalışmaya devam eder.
iPhone'lara push için APNs anahtarı Firebase projesine ayrıca yüklenmelidir.

## 9. Yedekleme

Yedek ve geri yükleme için `tools/crewhall/crewhall` komutunu kullan. Veritabanını, dosya deposunu ve
istersen şifreli `docker/.env` dosyasını tek yedekte toplar. Ayrıntılar:
[tools/crewhall/README.md](../tools/crewhall/README.md).

```bash
tools/crewhall/crewhall backup                 # veritabanı + dosyalar
tools/crewhall/crewhall list
tools/crewhall/crewhall restore <kimlik>       # servisleri durdurur, geri yükler, açar
tools/crewhall/crewhall export <kimlik> > crewhall-yedek.tar   # sunucu dışına kopya
```

- Yedekler `backups` Docker hacminde durur. Sunucu dışına düzenli kopya al (`export`, sonra `rclone`,
  `restic` vb.).
- Gece yedeğini Yönetim › Yedekler ekranından açabilirsin (kurulumu yapan kurumun sahibi).
- `.env` varsayılan olarak yedeğe girmez. `--with-config` ile şifreli eklenir; parola
  `CREWHALL_BACKUP_PASSPHRASE` ortam değişkeninden okunur.
- Kasa verisi veritabanında şifreli durur; çözmek için kişilerin kendi kasa şifresi ya da kurtarma
  anahtarı gerekir.
- Geri yüklemede yedeğin alındığı kurulumun `AUTH_SECRET` değeri kullanılmalıdır.

Elle yedek gerekirse: `docker compose ... exec -T postgres pg_dump -U crewhall -Fc crewhall > yedek.dump`
ve `crewhall_seaweedfs-data` hacminin arşivi (SeaweedFS durdurulmuşken).

## 10. Güncelleme

```bash
tools/crewhall/crewhall update 1.5.0   # imajlar kayıt defterinden
git pull && tools/crewhall/crewhall update --build   # kaynaktan kurulum
```

- Komut önce yedek alır, sonra yeni sürümü açar. Yeni sürümün migration'ları backend açılırken çalışır.
- Backend sağlıklı açılmazsa eski imajlar, eski `.env` ve güncelleme öncesi yedek geri gelir.
- Dokploy'da sürümü Dokploy'dan değiştir; öncesinde `backup` al (README'de anlatılıyor).

## 11. Sorun giderme

- **Sertifika alınamıyor:** DNS kayıtlarının sunucuyu gösterdiğini ve 80/443'ün açık olduğunu kontrol
  et. Ayrıntı için: `$C logs caddy`.
- **Dosya yükleme takılıyor:** `S3_DOMAIN` tarayıcıdan erişilebilir olmalı, çünkü yüklemeler doğrudan
  S3'e gider. `https://s3.ornek.com` açılınca bir XML hata sayfası görünmesi normaldir.
- **E-posta gitmiyor:** sihirbazdaki SMTP testini "Yönetim › Entegrasyonlar" ekranından tekrarla;
  hata ayrıntısı için `$C logs backend`.
- **Chat anlık güncellenmiyor:** ters vekil `/ws` yolunu WebSocket olarak geçirmeli. Paketle gelen
  Caddyfile bunu yapar; önüne başka bir proxy koyduysan `Upgrade` başlığını iletmesini sağla.
- **Log ve izleme:** `OTEL_EXPORTER_OTLP_ENDPOINT` ile loglar ve izler bir OTLP alıcısına (ör. Seq)
  gönderilir. Yoksa `$C logs -f backend worker` yeterlidir.

## 12. Posta: Microsoft 365 ile giriş

Posta modülü kurumun kendi posta sunucusuna IMAP/SMTP ile bağlanır. Microsoft 365'te (Exchange Online)
temel kimlik doğrulama (şifreyle IMAP) kapalı olduğu için giriş OAuth2 ile yapılır: kişi Microsoft
hesabıyla oturum açar, Crewhall aldığı jetonla IMAP ve SMTP'ye XOAUTH2 ile bağlanır. Jetonlar şifreli
saklanır, süresi dolunca yenileme jetonuyla kendiliğinden yenilenir.

> Bu akış kodda hazır ve testlerde sahte bir Entra ile denendi. Gerçek bir Microsoft 365 kiracısında
> henüz denenmedi; aşağıdaki adımlarla kurduktan sonra "Doğrulama" listesini izleyin.

### 12.1 Entra'da uygulama kaydı (kurum başına bir kez)

1. [Microsoft Entra yönetim merkezi](https://entra.microsoft.com) › **Uygulamalar › Uygulama kayıtları ›
   Yeni kayıt**.
   - Ad: `Crewhall Posta` (kullanıcılar onay ekranında bu adı görür).
   - Desteklenen hesap türleri: **Yalnızca bu kuruluş dizinindeki hesaplar** (tek kiracı).
   - Yönlendirme URI'si: **Web**, değeri Crewhall'da *Yönetim › Posta*'da yazan adres
     (`https://<api adresi>/api/mail/oauth/callback`). Ortak kutular da aynı adresi kullanır.
2. **Sertifikalar ve gizli diziler › Yeni istemci gizli dizisi**. Değeri hemen kopyalayın (bir daha
   gösterilmez). Süresi dolmadan yenisini girmeyi takvime yazın.
3. **API izinleri › İzin ekle › Kuruluşumun kullandığı API'ler › Office 365 Exchange Online** ›
   **Temsilci izinleri**:
   - `IMAP.AccessAsUser.All`
   - `SMTP.Send`

   Microsoft Graph'tan (temsilci) `openid`, `email`, `offline_access` zaten listede değilse ekleyin.
4. **<Kiracı> için yönetici onayı ver**'e basın. Böylece kişiler tek tek onay ekranı görmez.
5. **Genel bakış**'tan *Uygulama (istemci) kimliği*ni ve *Dizin (kiracı) kimliği*ni kopyalayın.

### 12.2 Exchange ayarları

- **Giden posta (SMTP AUTH):** Exchange Online'da kiracı genelinde kapalı olabilir. Posta gönderecek
  her kutu için açın (PowerShell, `ExchangeOnlineManagement` modülü):

  ```powershell
  Connect-ExchangeOnline
  Set-CASMailbox -Identity ayse@sirket.com -SmtpClientAuthenticationDisabled $false
  ```

- **IMAP:** kutularda IMAP açık olmalı (`Set-CASMailbox -Identity ... -ImapEnabled $true`).
- **Ortak kutu (paylaşılan posta kutusu):** kutuyu Crewhall'a bağlayacak yöneticiye tam erişim ve
  "farklı gönder" izni verin:

  ```powershell
  Add-MailboxPermission -Identity destek@sirket.com -User yonetici@sirket.com -AccessRights FullAccess -AutoMapping $false
  Add-RecipientPermission -Identity destek@sirket.com -Trustee yonetici@sirket.com -AccessRights SendAs -Confirm:$false
  Set-CASMailbox -Identity destek@sirket.com -SmtpClientAuthenticationDisabled $false
  ```

  Paylaşılan kutunun kendi şifresi ve lisansı gerekmez. Crewhall IMAP'a kutunun adresiyle, yöneticinin
  jetonuyla bağlanır.

### 12.3 Crewhall ayarları

1. *Yönetim › Posta*:
   - Giriş yöntemi: **Microsoft 365 (OAuth2)**.
   - IMAP `outlook.office365.com`, port 993, TLS.
   - SMTP `smtp.office365.com`, port 587, STARTTLS.
   - İstemci kimliği, istemci gizli dizisi, kiracı kimliği (ya da `sirket.onmicrosoft.com`).
2. Kişiler *Posta*'da **Microsoft 365 ile bağlan**'a basar ve kendi hesaplarıyla oturum açar.
3. **Ortak kutu:** space yöneticisi *Posta › Ortak kutular › +* ile kutuyu ekler.
   - Şifre alanını boş bırakır; ekleyince Microsoft girişine yönlenir.
   - Paylaşılan kutuya tam erişimi olan kendi hesabıyla oturum açar.
   - Jeton reddedilirse (izin kaldırıldı, şifre değişti) kutuda "bağlı değil" şeridi çıkar. Yönetici
     **Microsoft 365 ile bağla** ile yeniden bağlar.

### 12.4 Doğrulama

- [ ] Bir kişi *Posta*'da bağlanabiliyor, gelen kutusu listeleniyor, bir ileti açılıyor.
- [ ] Gönderilen ileti alıcıya ulaşıyor ve *Gönderilmiş*'te görünüyor. 535 hatası SMTP AUTH'un
      kapalı olduğunu gösterir (12.2).
- [ ] Ortak kutu bağlanıyor; konuşmalar görünüyor. Yanıt kutunun adresinden gidiyor. Gitmiyorsa
      SendAs iznini kontrol edin.
- [ ] Bir saat sonra (erişim jetonunun süresi) posta hâlâ açılıyor. Bu, yenileme jetonunun
      çalıştığını gösterir.
- [ ] Sunucu logunda `mail oauth callback failed` yok. Varsa yanındaki `reason`, Entra'nın hata
      kodudur (ör. `invalid_client`: gizli dizi yanlış ya da süresi dolmuş).

Google Workspace aynı ekrandan **Google (OAuth2)** seçilerek kurulur:
- Google Cloud'da "dahili" OAuth istemcisi açılır.
- Kapsam olarak `https://mail.google.com/` eklenir.
- Yönlendirme URI'si yukarıdakiyle aynıdır.

Google'da paylaşılan kutu karşılığı yoktur; ortak kutu kendi Google hesabıyla bağlanır.

## 13. Office belgeleri (profil `office`, isteğe bağlı)

Drive'daki Word, Excel ve PowerPoint dosyaları (docx, xlsx, pptx ve odt, ods, odp) Crewhall içinde
açılır ve birlikte düzenlenir. Düzenleyici ayrı bir **belge sunucusudur**. Varsayılan Euro-Office
(ONLYOFFICE Docs çatalı); Crewhall onunla Document Server API'siyle konuşur (imzalı editör
yapılandırması, sunucunun dosyayı indirmesi ve kaydetme geri çağrısı). Aynı bağlayıcı ONLYOFFICE Docs
Community ile de çalışır. WOPI destekli başka bir sunucu da "WOPI sunucusu" türüyle bağlanabilir.

**Lisans:** Euro-Office AGPLv3 lisanslıdır. Crewhall'a gömülmez ve değiştirilmez; ayrı bir
konteynerde çalışır ve Crewhall onunla yalnız ağ üzerinden konuşur. Bu yüzden Crewhall'ın kodu
AGPL kapsamına girmez. Kurulumu dağıtırken belge sunucusunun lisans bilgisi ayrıca verilir.

1. `docker/.env` dosyasına `OFFICE_DOMAIN` (ör. `office.ornek.com`, DNS kaydı Caddy'ye) ve
   `OFFICE_JWT_SECRET` (32+ rastgele karakter) yaz. İmaj etiketi `OFFICE_IMAGE_TAG` ile sabitlenir
   (varsayılan `v9.3.7`; güncel etiket github.com/Euro-Office/DocumentServer).
2. Profille başlat: `docker compose -f docker/compose.yml --env-file docker/.env --profile office up -d`.
   İlk açılış birkaç dakika sürer; `https://$OFFICE_DOMAIN/healthcheck` `true` dönünce hazırdır.
   En az 4 GB bellek ister.
3. Yönetim › Entegrasyonlar › **Office** kartında:
   - Sunucu türü: **Euro-Office / ONLYOFFICE**
   - Sunucu adresi: `https://$OFFICE_DOMAIN`
   - İç adres: `http://office` (Crewhall sunucusu belge sunucusuna Docker ağından ulaşır)
   - JWT sırrı: `OFFICE_JWT_SECRET` ile aynı değer
   **Bağlantıyı dene** ile denetle, sonra "Office düzenlemeyi aç" anahtarını aç. Modül, Yönetim ›
   Genel'deki **Office** anahtarıyla da kapatılabilir.
4. Belge sunucusu dosyaları api'den `OFFICE_HOST_URL` adresiyle indirir ve oraya kaydeder (compose'da
   `http://backend:3000`). Docker dışında çalışıyorsan bu değişkeni sunucunun ulaşabildiği api
   adresine ayarla.

Her kayıt (Ctrl S ya da herkes belgeden çıkınca) Drive'da yeni bir sürüm olur. Yetki her istekte
yeniden denetlenir; izleyiciler belgeyi salt okunur açar. Editöre verilen jetonlar dosyaya ve kişiye
özeldir ve 8 saat geçerlidir.

**WOPI sunucusu kullanılıyorsa** (ör. Collabora Online): sunucuya Crewhall'ın `/wopi` adresini izinli
ana makine olarak ve Crewhall alan adını `frame-ancestors` olarak tanıt. Caddy `/wopi/*` yolunu api'ye
yönlendirir.
