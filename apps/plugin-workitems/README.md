# Azure DevOps ve Jira eklentileri

Aynı kod iki ayrı eklenti olarak çalışır. Hangisi olacağını `PLUGIN_PRODUCT` belirler.

| `PLUGIN_PRODUCT`     | Eklenti      | Kimlik                    | Manifest             | Sürüm |
| -------------------- | ------------ | ------------------------- | -------------------- | ----- |
| `azure` (varsayılan) | Azure DevOps | `com.milvasoft.workitems` | `manifest.json`      | 0.3.1 |
| `jira`               | Jira         | `com.milvasoft.jira`      | `manifest.jira.json` | 0.1.0 |

Azure DevOps eklentisinin kimliği eski adıyla kalır, kurulum ve bağlantılar kaybolmasın diye. Her ikisi de kendi sunucusunda
çalışır (`hosting: self`): her kurum kendi kopyasını çalıştırır, token'lar o kurumun sunucusundan çıkmaz. Her ürünün
kendi adresi, veritabanı ve `PLUGIN_SECRET`'i olur.

Azure DevOps eklentisinde Pipeline ve Library ana sekmenin yanında kendi sol menü öğeleri olarak da gelir. Kişi bunları
sol menüden gizleyebilir ve sıralayabilir. Azure DevOps eklentisine daha önce eklenmiş Jira bağlantıları ve eşitlemeleri
çalışmaya devam eder, ama oraya yeni Jira bağlantısı eklenemez. Jira'ya geçmek için Jira eklentisini kurup bağlantıyı ve
eşitlemeyi orada yeniden kurmak gerekir; eskisini kaldırmadan yenisini aynı panoya bağlama.

## Neler yapar

| Özellik           | Ayrıntı                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Eşitlenen alanlar | Başlık, açıklama, durum ↔ sütun, atanan, öncelik, bitiş ve başlangıç tarihi, etiketler, puan, yorumlar                        |
| Yön               | İki yönlü, yalnız Crewhall'a ya da yalnız dış servise                                                                         |
| Çakışma           | Alan alan birleştirir. İki taraf aynı alanı değiştirdiyse: son değişiklik, dış servis ya da Crewhall kazanır; geçmişe yazılır |
| Tetikleyici       | Kart olayları ve servis webhook'ları anlık, 2 dakikada bir tarama yedek                                                       |
| Bana atananlar    | Sekme ve ana sayfa kartı                                                                                                      |
| Sohbet            | Azure DevOps: `/is 123`, `/is ara <metin>`. Jira: `/jira ABC-12`, `/jira ara <metin>`                                         |
| Pipeline (Azure)  | Çalışan ve sıradaki koşular, başlatma, iptal, başarısız aşamayı yeniden çalıştırma, onaylar, loglar. `/pipeline <proje>`      |
| Library (Azure)   | Değişken gruplarını görme, değişken ekleme, düzenleme ve silme; onay penceresi ve işlem kaydı                                 |
| Asistan (Azure)   | `search_work_items`, `my_work_items`, `list_pipelines`; onaylı yazma: `add_work_item_comment`, `run_pipeline`                 |
| Asistan (Jira)    | `search_issues`, `my_issues`; onaylı yazma: `add_issue_comment`                                                               |

## Sınırlar

- **Eşlenemeyen alanlar:** Panoda karşılığı olmayan alanlar (özel alanlar, Azure alan yolu, iterasyon, ek dosyalar, üst-alt
  ilişkiler) eşitlenmez ve karşı tarafta silinmez.
- **Açıklama:** Crewhall açıklamaları düz metindir; biçim yalnız paragraf ve madde işareti olarak korunur.
- **Atanan:** İki serviste de tek kişidir. Karttaki diğer atananlar korunur. Eşleşme e-postayla yapılır; panoda
  olmayan kişi ya da e-postasını gizleyen Jira Cloud hesabı atlanır.
- **Öncelik:** İki serviste "öncelik yok" çoğu zaman yazılamaz. Kartta temizlenen öncelik karşıdaki değerle geri gelir.
- **Yorumlar:** Eklenenler kopyalanır, silme ve düzenleme kopyalanmaz.
- **Silme:** Work item silinirse kart arşivlenir. Kart silinirse work item kalır, yalnız bağlantı kopar.
- **Jira durumu:** İş akışı izin vermiyorsa kart taşınır ama Jira'da durum değişmez, geçmişe yazılır.
- **Library:** Gizli değerler Azure'dan okunamaz, yalnız yenisi yazılır. Gizli değer düz metne çevrilemez. Key Vault'a bağlı gruplar salt okunur; grup silme ve secure file yönetimi yok.
- **Yetki:** Pipeline ve Library işlemleri kişinin kendi bağlantısının Azure yetkisiyle yapılır.
- **Tek örnek:** Eşitlemeler süreç içinde sıraya girer; aynı veritabanıyla iki kopya çalıştırılmamalıdır.

## Adres değişince

Crewhall, kopyanın sunduğu manifestin `origin` değerinin kurulumdaki adresle birebir aynı olmasını ister. Kurulu bir
eklentinin adresi değiştirilemez. Bu yüzden `PLUGIN_ORIGIN` değişince:

1. **Kaldırma:** Eski kurulumu eski adres hâlâ açıkken kaldır. Kaldırma isteği eşitlemeleri ve Azure'daki service hook'ları
   siler. Adres önce kapanırsa bu istek eklentiye ulaşmaz: hook'lar Azure'da ölü adresle kalır, Azure'dan elle silinmeleri gerekir.
2. **Yeniden kurulum:** Eklentiyi yeni adresle yeniden kur. Bağlantılar ve eşitlemeler yeni kurulumda baştan eklenir.
   Eşitleme kurulunca Azure webhook'ları yeni adresle yeniden oluşur.
3. **Entra:** Entra uygulamasına yeni yönlendirme adresini ekle: `https://<yeni adres>/oauth/entra/callback`.

## Kimlik doğrulama

**Azure DevOps PAT:** Work Items (Read & Write), Project and Team (Read). Anlık bildirim için Service Hooks (Read & Write). Pipeline için Build (Read & execute), onaylar için Pipeline Resources (Use & manage), Library için Variable Groups (Read, create & manage).

**Azure DevOps Entra ID:** Entra'da bir uygulama kaydet.

1. Yönlendirme adresi (Web): `https://<eklenti adresi>/oauth/entra/callback`.
2. API izinleri: Azure DevOps › `user_impersonation` (Delegated).
3. Bir istemci sırrı oluştur.
4. Değerleri `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_TENANT` olarak ver ya da bağlantı formuna yaz.

**Jira Cloud:** E-posta ve [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
**Jira Data Center:** Kişisel erişim token'ı. Webhook'u yalnız Jira yöneticisinin token'ı kurabilir; diğerleri taramayla çalışır.

## Çalıştırma

| Değişken                                                 | Zorunlu | Açıklama                                                                                                              |
| -------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `PLUGIN_PRODUCT`                                         | hayır   | `azure` (varsayılan) ya da `jira`                                                                                     |
| `PLUGIN_ORIGIN`                                          | evet    | Crewhall'ın eriştiği https adresi; manifestteki `origin` bununla değişir                                              |
| `PLUGIN_SECRET`                                          | evet    | 32+ karakter. Token'ları şifreler; kaybolursa bağlantılar yeniden kurulur                                             |
| `DATABASE_URL`                                           | evet    | PostgreSQL. Tabloyu kendisi açar. Yoksa veri bellekte kalır (yalnız geliştirme)                                       |
| `PORT`                                                   | hayır   | Varsayılan `4341`                                                                                                     |
| `POLL_SECONDS`                                           | hayır   | Tarama aralığı, varsayılan `120`, en az `30`                                                                          |
| `ALLOW_PRIVATE_HOSTS`                                    | hayır   | `true`: kurum içi Jira ya da Azure DevOps Server'a bağlanır, `http` adresi de kabul edilir. Herkese açık kopyada açma |
| `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_TENANT` | hayır   | Yalnız Azure DevOps. Formda uygulama bilgisi sormamak için                                                            |

```bash
docker build -f apps/plugin-workitems/Dockerfile -t crewhall/plugin-workitems .
```

```bash
pnpm --filter @crewhall/plugin-workitems validate
```

İki eklenti de Crewhall API düzeyi 50 ve eklenti API düzeyi 2 ister. Kurulumda yönetici `offline:access` iznini vermeli, eşitlemeyi kuran
kişi de Crewhall'ın açtığı pencereden arka plan iznini onaylamalıdır. Eşitleme o kişinin yetkileriyle çalışır.
