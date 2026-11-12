# Microsoft 365 entegrasyonları: kurulum

Yönetim › Entegrasyonlar › Microsoft 365 ekranı adımları sırayla gösterir. Bu belge aynı adımları ve
gereken izinleri yöneticiler için toplar. Her entegrasyon ayrı açılır ve **varsayılan olarak kapalıdır**
(`OrgSettings.integrations`).

Test kiracısı (tenant) olmadan geliştirildi. Kod sahte Microsoft sunucularıyla test edildi. Gerçek bir
Microsoft 365 kiracısında doğrulama kullanıcıya kalmıştır (bkz. "Doğrulanmamış olanlar").

## 1. Microsoft uygulama kaydı

SharePoint, OneDrive ve Entra grup bilgisi bu kayıtla okunur. Outlook eklentisi ve Teams uygulaması bu
kayda ihtiyaç duymaz; onlar Crewhall'ın kendi OIDC sağlayıcısıyla giriş yapar.

1. Entra yönetim merkezi › Uygulama kayıtları › Yeni kayıt. Tek kiracılı ("Yalnız bu kuruluş") seç.
2. Sertifikalar ve gizli anahtarlar › Yeni istemci gizli anahtarı. Değeri kopyala.
3. API izinleri › Microsoft Graph › **Uygulama izinleri** (Application). Kullanacağın entegrasyona göre:

   | İzin                                                                      | Ne için                                                                  |
   | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
   | `Sites.ReadWrite.All` (ya da yalnız seçili siteler için `Sites.Selected`) | SharePoint kitaplıklarını bağlama                                        |
   | `Files.ReadWrite.All`                                                     | OneDrive bağlama ve OneDrive'dan toplu taşıma                            |
   | `GroupMember.Read.All`                                                    | 200'den fazla grubu olan kişilerin grupları (Entra girişinde grup aşımı) |

4. "Yönetici onayı ver" düğmesine bas.
5. Crewhall'da tenant kimliği, uygulama (istemci) kimliği ve gizli anahtarı kaydet, **Bağlantıyı dene**.
   Ekran verilen izinleri listeler. Gizli anahtar AES-256-GCM ile şifreli saklanır, geri gösterilmez.

Salt okunur kullanım istenirse `Sites.Read.All` / `Files.Read.All` de yeter. O zaman bağlantıları
"salt okunur" işaretle.

## 2. Entra ID: giriş, grup eşleme ve SCIM

**Giriş (SSO):** Yönetim › Entegrasyonlar › Kimlik sağlayıcı ekle › Entra ID (OIDC). Entra'da ayrı bir
uygulama kaydı (ya da yukarıdaki kayıt) açılır:

- Yönlendirme URI'si (Web): Crewhall ekranındaki "Geri dönüş adresi" (`<API>/api/identity/sso/<id>/callback`).
- Belirteç yapılandırması › Grup talebi ekle (güvenlik grupları). Talep `groups` olarak gelir, değerler
  grup nesne kimlikleridir (GUID).
- Kimlik: Crewhall Entra'da kişinin **nesne kimliğini (`oid`)** kullanır. Bu kimlik kiracının bütün
  uygulamalarında aynıdır ve SCIM'in `externalId` değeriyle eşleşir. Daha önce `sub` ile bağlanmış
  hesaplar ilk girişte kendiliğinden yeni kimliğe geçer.
- Grup aşımı: 200'den fazla grubu olan kişide Entra grupları belirtece koymaz. Crewhall o zaman grupları
  Graph'tan (`getMemberObjects`) okur. Bunun için uygulama kaydı ve `GroupMember.Read.All` gerekir.
- Grup eşleme: eşlemede grup adı ya da Entra nesne kimliği yazılabilir. SCIM grupları gönderdiyse
  Crewhall nesne kimliğini adla da eşler.

**Kullanıcı açma ve kapatma (SCIM 2.0):**

1. Microsoft 365 ekranında Entra ID'yi aç, eşlemeleri kullanılacak sağlayıcıyı seç ve **SCIM anahtarı
   oluştur**. Anahtar yalnız bir kez gösterilir.
2. Entra › Kurumsal uygulamalar › (SSO uygulaman) › Sağlama › Otomatik:
   - Kiracı URL'si: `<API>/api/scim/v2`
   - Gizli belirteç: SCIM anahtarı
   - Bağlantıyı test et, kaydet.
3. Eşlemeler varsayılan kalabilir: `userPrincipalName → userName`, `objectId → externalId`,
   `mail → emails[type eq "work"].value`, `displayName`, `Switch([IsSoftDeleted]…) → active`.
4. Kapsama kişileri ve grupları ekle, sağlamayı başlat.

Davranış:

- Yeni kişi ilk SSO girişindeki gibi açılır (kişisel alan, varsayılan alanlar, eşlenen rol).
- Kurumda aynı e-postayla bir üye varsa yeni hesap açılmaz; o üye SCIM'e bağlanır.
- `active: false` ve DELETE üyeliği askıya alır ve kişinin oturumlarını kapatır. Kişi silinmez.
  `active: true` yalnız SCIM'in askıya aldığı üyeliği geri açar; yöneticinin askıya aldığı üye askıda kalır.
- Kurum sahibi hiçbir zaman askıya alınmaz (acil durum girişi).
- Grup üyeliği değişince sağlayıcının eşlemeleri yeniden uygulanır (rol ve alan üyelikleri).

**Koşullu erişime uyum:**

- Koşullu erişim kuralları (MFA, uyumlu cihaz, konum, uygulama ataması) Entra'daki girişte uygulanır;
  Crewhall'a ek bir ayar gerekmez. Kurala takılan giriş, giriş sayfasında "Kurumunun erişim kuralları bu
  girişi engelledi" olarak gösterilir (AADSTS 53xxx, 50076, 50079, 50105, 50158, 50097,
  `interaction_required`).
- Entra'daki MFA'yı Crewhall'ın iki adımlı doğrulama politikası yerine saymak için sağlayıcıda "IdP'nin
  MFA'sına güven" açılır.
- Sürekli erişim değerlendirmesi (CAE) ve Entra'nın "oturum sıklığı" denetimi Crewhall oturumlarına
  yansımaz. Oturum süresi Yönetim › Güvenlik'ten kısaltılır. Kişi Entra'da kapatılınca SCIM oturumları
  hemen kapatır.

## 3. Outlook eklentisi

1. Microsoft 365 ekranında Outlook eklentisini aç. Crewhall eklenti için yerleşik bir OIDC istemcisi
   açar (Yönetim › Güvenlik › OIDC listesinde görünmez, yalnız bu ekrandan yönetilir).
2. **Manifesti indir** (`<API>/api/integrations/outlook/manifest.xml`, kuruma özel).
3. Microsoft 365 yönetim merkezi › Ayarlar › Tümleşik uygulamalar › Özel uygulamaları karşıya yükle ›
   Office Eklentisi › manifest dosyası. Kişilere ya da gruplara ata. Yayılması 24 saate kadar sürebilir.

Kullanım:

- E-posta okurken **Crewhall'a kaydet**: sayfa, pano kartı ya da sohbet mesajı. Gönderen, tarih ve
  özgün iletiye bağlantı eklenir. Hedefin yetkileri ve DLP kuralları uygulanır.
- E-posta yazarken **Crewhall linki**: seçilen ekler kişisel alanın "Outlook ekleri" klasörüne yüklenir,
  e-postaya Drive linki konur (şifre ve son kullanma isteğe bağlı), ek e-postadan çıkarılır.
- **Bana dosya yüklet**: kişinin Drive'ında bir klasör açılır ve e-postaya herkese açık yükleme linki
  (`<WEB>/u/<anahtar>`) eklenir. Link en çok 30 gün açıktır, şifre konabilir, dosya başına 100 MB.
  Yükleyen klasörün içini göremez. Açık linkler bölmeden kapatılabilir.

Kimlik: bölme Crewhall OIDC (yetkilendirme kodu + PKCE) ile giriş yapar; erişim belirteci yalnız
eklentinin ihtiyaç duyduğu uçlarda geçerlidir ve eklenti kapatılınca çalışmaz. Gereksinim: Mailbox 1.8
(Outlook web, Windows yeni/klasik, Mac).

## 4. Teams uygulaması

1. Azure portalı › Azure Bot kaynağı oluştur (fiyat katmanı F0 yeter). Tür: tek kiracılı ya da çok
   kiracılı.
2. Bot › Yapılandırma › Mesajlaşma uç noktası: `<API>/api/integrations/teams/messages`.
3. Bot › Kanallar › Microsoft Teams ekle.
4. Botun **Microsoft App ID** değerini Crewhall'a yaz, Teams'i aç. Bot gizli anahtarı Crewhall'a
   gerekmez: Crewhall yalnız eşzamanlı yanıt verir ve gelen isteğin Bot Framework (ya da Entra) imzasını
   doğrular.
5. **Uygulama paketini indir** (`<API>/api/integrations/teams/app.zip`). Teams yönetim merkezi › Teams
   uygulamaları › Uygulamaları yönet › Yükle.

Kullanım:

- Mesaj yazma kutusunda Crewhall araması: dosya, sayfa ve pano adına göre arar, sonuç kartı Crewhall
  bağlantısıyla sohbete eklenir. Alıcının o öğeyi görme yetkisi olmalıdır.
- İlk aramada kişi "Crewhall hesabını bağla" der, açılan pencerede Crewhall'a girer. Teams kişisi
  (kiracı + nesne kimliği) Crewhall hesabına bağlanır.
- Mesajın "…" menüsü › **Crewhall'a kaydet**: sayfa, pano kartı ya da sohbet. Mesaj 15 dakika saklanır.
- Kanal ya da sohbete **sekme**: bir sayfa ya da pano seçilir; sekme okunur görünüm ve "Crewhall'da aç"
  gösterir.

## 5. Dış depolama: SharePoint, OneDrive ve SMB

1. Microsoft 365 ekranında dış depolamayı aç.
2. **Bağlantı ekle**: tür, görünen ad, alan.
   - SharePoint: site adresi (`https://contoso.sharepoint.com/sites/Finans`), kitaplık adı (boşsa
     varsayılan "Belgeler"), isteğe bağlı başlangıç klasörü.
   - OneDrive: sahibinin e-postası (UPN), isteğe bağlı klasör.
   - SMB: `\\sunucu\paylasim`, etki alanı, hizmet hesabı ve şifresi (SMB 2, NTLMv2).
3. Bağlantı seçilen alanın Drive'ında, kök klasörün üstünde görünür.

Davranış:

- Dosyalar kopyalanmaz; listeleme, indirme ve yükleme kaynağa canlı gider.
- Görme yetkisi Crewhall alanından gelir: alanın üyeleri görür, düzenleyiciler yükler ve klasör açar
  (bağlantı salt okunur değilse). SharePoint'teki kişi bazlı izinler Crewhall'a yansımaz; hassas
  kitaplıklar yalnız ilgili kişilerin üye olduğu alana bağlanmalı ya da `Sites.Selected` ile
  sınırlanmalıdır.
- Aynı adlı dosya yüklenince üzerine yazılmaz, yeni ad verilir.
- **Drive'a kopyala**: açık klasör, klasör yapısıyla alanın Drive'ına arka planda kopyalanır. Kurumun tek
  dosya sınırını aşan dosyalar atlanır ve sayılır.
- **OneDrive'dan toplu taşıma** (yönetici): her kişinin OneDrive'ı kendi kişisel alanındaki bir klasöre
  kopyalanır. OneDrive'da hiçbir şey silinmez. Kişinin Crewhall'da etkin üye olması gerekir.

Kimlik doğrulama: Graph için uygulama kaydı (uygulama izinleri). SMB için hizmet hesabı (NTLMv2).
Kerberos ile kişi bazlı SMB erişimi sunucu tarafında yoktur; Windows'ta masaüstü uygulamasının sanal
sürücüsüyle gelecek (aşağıda).

## 6. Masaüstü oturumu için notlar (Windows sanal sürücü, Kerberos girişi)

Kerberos girişi bu iş paketinde yapılmadı; masaüstü oturumu yapacak. Sanal sürücü masaüstü uygulamasına
eklendi (aşağıda). Gereken backend:

- **Sanal sürücü (Cloud Files API):** bugünkü WebDAV (`/dav`, kişisel token ile) ve Drive REST uçları
  yeterli: `listNodes`, `nodeDetail`, indirme (`downloadUrl`), yükleme (`createUpload` / `partUrls` /
  `completeUpload`), hızlı haber için WebSocket olayları ve **değişiklik akışı** (`listDriveChanges`,
  `GET /api/v1/drive/changes?cursor=&types=folder,file`): oluşan, değişen, taşınan ve silinen düğümler ile
  yetki kaybı ve kazancı, kişinin gördüğü kadarıyla. Kullanımı sözleşmede (`DriveChangesPage`) yazılı. Dış
  depolama bağlantıları akışta yoktur; aynı ağaçta gösterilecekse `listSpaceMounts` + `listMountItems` +
  `mountDownload` / `mountUpload` kullanılır.
- **Kerberos ile parolasız giriş:** önerilen yol, masaüstü uygulamasının Windows oturumunun Kerberos
  biletini (SPNEGO, `Negotiate`) yeni bir uca göndermesi: `POST /api/auth/sign-in/kerberos`
  (better-auth eklentisi; sunucuda keytab ile `HTTP/<api-host>` SPN'i doğrulanır, kişi AD/LDAP
  sağlayıcısındaki `userPrincipalName` ile eşlenir, yanıt `/sign-in/email` ile aynı). Sunucu tarafında
  GSSAPI gerekir; MIT/BSD lisanslı bir Node bağlaması seçilmeli (ör. `kerberos` paketi, Apache-2.0).
  Entra'ya katılmış cihazlarda alternatif: masaüstünden Entra SSO (WAM) ile alınan belirteç Entra OIDC
  sağlayıcısı üzerinden kullanılır; bu yol bugünkü SSO koduyla çalışır.
- **"Gönder → Crewhall" ve sağ tık menüsü:** yeni uç gerekmez; yükleme uçları yeterli.

### Sanal sürücünün sınırları

İlk sürümde bilerek böyle:

- **Dosyanın tamamı iner.** Bir program dosyanın küçük bir parçasını okusa da ilk okuma tüm dosyayı indirir.
  Program kapansa da indirme biter. Ayarlar › Eşitleme 20 MB üstü dosyalarda ilerlemeyi gösterir, Gezgin de
  kendi ilerlemesini gösterir. Aynı anda en çok dört dosya iner, diğerleri sırada bekler.
- **Ağ kesilirse okuma hata verir.** Sunucu 30 saniye yanıt vermezse program okuma hatası alır. Daha önce inmiş
  dosyalar çevrimdışı da açılır.
- **Uygulama kapalıyken** klasör ve dosya adları görünür, inmiş dosyalar açılır, inmemiş dosyalar açılamaz.
  Yapılan değişiklikler uygulama açılınca yüklenir.
- **Eşitlenen klasörlerle kesişemez.** Sanal sürücü klasörü bir eşleşmenin içinde olamaz, onu içeremez ve boş
  olmalıdır. Arayüz ve ana süreç bunu engeller.
- **Kök klasöre konan dosyalar eşitlenmez.** Dosyalar bir alan klasörünün içinde olmalıdır.
- **Alan klasörü silinirse geri gelir.** Gezgin'de bir alan klasörünü silmek sunucudaki dosyaları silmez, klasör
  sunucudan yeniden kurulur. Alan klasörünün içindeki öğeleri silmek sunucuda çöp kutusuna taşır.
- **Silinenler Geri Dönüşüm Kutusu'na gitmez.** Silinen dosyalar Drive'ın çöp kutusundan geri alınır. Gezgin'in
  çöp kutusu her dosyayı önce indirirdi.
- **Görüntüleyici olunan alanlar** da görünür, değişiklikler yüklenemez ve Ayarlar › Eşitleme'de hata olarak
  listelenir.
- **Gezgin'in "Her zaman bu cihazda tut" ve "Yer aç" komutları** çalışır; klasörde içindeki her şeye uygulanır.
  Tutulan dosya kimse okumadan iner, sunucuda yeni sürümü çıkınca o da iner, tutulan klasöre sonradan eklenenler de
  iner. Aynı anda en çok iki dosya bu yolla iner. Uygulama kapalıyken verilen komutlar açılışta yerine getirilir.
  Yer açma yalnız sunucuda olan içeriği siler: yüklenmemiş bir değişiklik varsa dosya yüklenene kadar yerinde kalır,
  programda açık bir dosya kapanınca serbest kalır. Yer açılan dosya okununca iner ve işareti kalkar.
- **Durum simgeleri** Gezgin'in kendi simgeleridir: bulut (inmedi), boş tik (indi), dolu tik (hep tutulan), oklar
  (henüz eşitlenmedi). Eşitlenemeyen dosyanın yanına bir uyarı simgesi eklenir, üzerine gelince nedeni görünür: yetki
  ya da ağ hatası, sunucunun kabul etmediği ad, alan klasörlerinin dışına konmuş dosya. En çok 500 dosyada gösterilir.
  Sorun bitince kalkar. Uyarı dosyaya dokunmaz, indirme başlatmaz. Klasörler içlerindeki dosyaların durumunu almaz.
- **Dış depolama bağlantıları** sanal sürücüde görünmez, çünkü değişiklik akışında yoktur.
- **Yalnız Windows.** Eklenti Windows içindir, macOS sürümünde bu ayar görünmez.

Sıradan eşitleme klasörlerinde başka bir sağlayıcının (OneDrive gibi) yalnız bulutta duran dosyaları eşitlenmez:
kişinin bulutu sorulmadan bu diske ve Crewhall'a inmesin diye atlanır, sayıları ve nedeni eşleşmenin durumunda
görünür. Dosya bu bilgisayara indirilince eşitlenir. Daha önce eşitlenmiş bir dosyada OneDrive'ın "yer aç" komutu
kullanılırsa dosya silinmiş sayılmaz, sunucudaki hali yerinde kalır. Dosyaya hiç dokunulmadan yalnız Windows'un
öznitelikleri okunur. Bunu eklenti okur: eklenti yüklenemezse bu ayrım da yapılamaz.

Kaldırıcı yalnız onu çalıştıran kişinin sürücüsünü temizler. Uygulama "tüm kullanıcılar için" kurulu ve bilgisayarda
başka hesaplar da sanal sürücü kullanıyorsa, o hesapların Gezgin'deki girdisi ve klasörü kalır, klasör elle silinir.
Yönetici parolasını başka bir hesap girerek kaldırmak da aynı sonucu verir.

Kapatınca, sunucu değişince, başka biri oturum açınca ya da uygulama kaldırılınca sunucuda olan dosyalar bu
bilgisayardan silinir. Henüz yüklenmemiş değişiklikler sıradan dosya olarak klasörde kalır. Oturum yalnız sona
ererse hiçbir şey silinmez, inmiş dosyalar diskte kalır ve yeniden oturum açılınca eşitleme sürer.

## 7. Outlook kişileri (takvim hesabıyla, çift yönlü)

Kişiler ayrı bağlanmaz; Yönetim › Takvim › Microsoft'taki hesap ve uygulama kaydı kullanılır.

1. Entra uygulamasına Microsoft Graph izni ekle:
   - Herkes kendi hesabını bağlayacaksa **Delegated** `Contacts.ReadWrite`. Kullanıcı onayı kapalıysa
     "Grant admin consent" ile onayla.
   - "Kurum genelinde eşitle" açıksa **Application** `Contacts.ReadWrite` ve yönetici onayı.
2. Yönetim › Takvim › Microsoft'ta **Outlook kişilerini de eşitle** anahtarını aç. Sıra önemli: anahtar açıkken
   yeni bağlantılar bu izni ister, izin uygulamada yoksa ve kullanıcı onayı kapalıysa bağlanamazlar.
3. Daha önce bağlanmış kişi Takvim ayarları › Bağlı hesaplar'da "Yeniden bağla" der. Takvimi o zamana kadar
   çalışmaya devam eder.

Davranış: varsayılan Kişiler klasörü kişinin özel kişileri olarak gelir, en geç beş dakikada bir eşitlenir.
Crewhall'daki düzenleme ve silme Outlook'a gider. Yeni kişi yalnız diyalogda hesap seçilirse gider.

Doğrulama (gerçek kiracıda):

- Outlook'ta bir kişi ekle, değiştir, sil; beş dakika içinde Crewhall'da görün (ya da hesapta Eşitle).
- Crewhall'da düzenle ve sil; Outlook'ta görün. Doğum günü aynı gün kalmalı, adres iş adresine düşmeli.
- İki tarafta aynı anda değiştir; kişi panelinde "Önceki sürümler" çıkmalı.
- Hiç kişisi olmayan bir posta kutusunda hata çıkmamalı, Crewhall'dan eklenen kişi Outlook'a gitmeli.

## 8. Şirket içi Exchange (EWS): takvim ve kişiler

Exchange 2013 ve sonrası içindir. Microsoft 365 için bu bölümü değil, Graph bağlantısını kullan (Basic ve bu akış
Exchange Online'da çalışmaz).

**Sunucu tarafı (Exchange yöneticisi):**

1. EWS'in dışarıdan değil, Crewhall sunucusundan erişilebilir olması yeter. Crewhall sunucusundan dene:

   ```bash
   curl -I https://mail.ornek.com/EWS/Exchange.asmx
   ```

   `401` dönmesi beklenen sonuçtur: sunucu ulaşılabilir ve giriş istiyor.

2. Kimlik doğrulamayı kontrol et. Exchange Yönetim Kabuğu'nda:

   ```powershell
   Get-WebServicesVirtualDirectory | Format-List Server,InternalUrl,ExternalUrl,WindowsAuthentication,BasicAuthentication
   ```

   Crewhall'da **NTLM** seçeceksen `WindowsAuthentication` açık olmalı (varsayılan). **Basic** seçeceksen şunu çalıştır
   ve IIS'i yeniden başlat; Basic'i yalnız https üzerinden kullan:

   ```powershell
   Set-WebServicesVirtualDirectory -Identity "SUNUCU\EWS (Default Web Site)" -BasicAuthentication $true
   ```

3. EWS erişimi kısıtlıysa kişilere izin ver:

   ```powershell
   Get-OrganizationConfig | Format-List EwsApplicationAccessPolicy,EwsAllowList,EwsBlockList
   Set-CASMailbox -Identity kisi@ornek.com -EwsEnabled $true
   ```

**Sertifika:** Adres https olmak zorunda. Sertifika kurum içi bir CA'dan geliyorsa Crewhall API ve worker süreçlerine
kök sertifikayı `NODE_EXTRA_CA_CERTS=/yol/kurum-ca.pem` ile ver. Sertifika denetimini kapatan bir ayar yok.

**Crewhall tarafı:**

1. Yönetim › Takvim › **Exchange (şirket içi)**: EWS adresini (`https://mail.ornek.com/EWS/Exchange.asmx`) ve kimlik
   doğrulamayı gir, "Kişiler bağlayabilsin"i aç. Kişiler de eşitlenecekse **Exchange kişilerini de eşitle**'yi aç.
2. Her kişi Takvim ayarları › Bağlı hesaplar › **Exchange hesabı bağla** der; e-postasını ve şifresini girer. Kullanıcı
   adı e-postadan farklıysa `ALANADI\kullanici` biçiminde yazar.

**Bilinmesi gerekenler:**

- Şifre şifrelenmiş olarak saklanır ama Crewhall onu geri açabilir; `AUTH_SECRET` bu yüzden önemlidir. Şifre
  değişince hesap "Erişim geri alındı" olur, eşitleme durur (AD kilitlenmesin diye) ve kişi yeniden bağlar.
- Değişiklikler en geç beş dakikada gelir; anlık bildirim yok.
- Crewhall'dan seriyi taşımak olmaz, Outlook'tan yapılır. Başlık ve benzeri değişiklikler seriye gider.
- Toplantı katılma linki ve "Outlook'ta aç" düğmesi Exchange etkinliklerinde çıkmaz.
- Kerberos (yalnız Negotiate) ve kurum geneli erişim (impersonation) desteklenmiyor.

**Doğrulama (gerçek sunucuda, hiçbiri henüz denenmedi):**

- [ ] Yanlış şifreyle bağlanmak "Exchange girişi reddetti" der, doğru şifreyle hesap ve takvimler görünür.
- [ ] NTLM ile bağlantı. El sıkışma yalnız yerel sunucuda denendi; https ve gerçek Windows kimlik doğrulaması denenmedi.
- [ ] Outlook'ta tek, tüm gün ve tekrarlı etkinlik oluştur; beş dakika içinde doğru gün ve saatte görün. Tüm gün
      etkinliği bir gün kaymamalı.
- [ ] Crewhall'dan oluştur, düzenle, sil; Outlook'ta görün. Katılımcılı etkinlikte davet ve iptal e-postası gitmeli.
- [ ] Tekrarlı etkinlik oluştur (haftalık, ayın ikinci salısı); Outlook'ta kural doğru olmalı.
- [ ] Bir tekrarı değiştir, "tüm etkinlikler"le başlığı değiştir; doğru kayda gitmeli.
- [ ] Gelen davete Crewhall'dan yanıt ver; düzenleyene yanıt gitmeli.
- [ ] İki yerde aynı anda değiştir; "Önceki sürümler" çıkmalı.
- [ ] Kişi ekle, değiştir, sil (iki yönde). Telefon, e-posta, adres ve doğum günü doğru alanlara düşmeli.
- [ ] Şifreyi değiştir; hesap "Erişim geri alındı" olmalı, AD hesabı kilitlenmemeli.

## Doğrulanmamış olanlar (gerçek kiracıda denenmeli)

- Outlook kişileri (bölüm 7). Özellikle varsayılan klasörün bulunması: önce `/contactFolders/contacts`, olmazsa
  bir kişinin `parentFolderId`'si kullanılıyor; Graph belgeleri varsayılan klasör için delta yolu tanımlamıyor.

- Entra SCIM'in gerçek istek sırası ve özel alan eşlemeleri (testler Entra'nın belgelenen biçimleriyle
  yazıldı).
- Grup aşımında Graph çağrısı ve koşullu erişim hata kodlarının giriş ekranına yansıması.
- Outlook eklentisinin Outlook web, yeni Outlook ve Mac'te yüklenmesi; ek içeriğinin alınması
  (Mailbox 1.8), diyalogla giriş.
- Teams paketinin yönetim merkezinde doğrulanması, Bot Framework belirteç doğrulaması, arama ve kaydet
  akışları, sekmenin Teams içinde açılması (üçüncü taraf çerez yok, belirteçle çalışır).
- SharePoint ve OneDrive Graph çağrıları (site çözümleme, büyük dosya yükleme oturumu).
- SMB kütüphanesinin (v9u-smb2) gerçek bir Windows sunucusunda NTLMv2 ile çalışması.
