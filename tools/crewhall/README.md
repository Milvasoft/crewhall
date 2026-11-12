# crewhall: yedekleme, geri yükleme ve güncelleme

Kendi sunucusuna Crewhall kuran kurum için tek komut: veritabanı ve dosyaların yedeğini alır, yedeği geri
yükler, yeni sürüme geçer ve geçiş başarısız olursa eski hâline döner. Docker Compose kurulumu
(`docker/compose.yml`) ve Dokploy için yazıldı.

```bash
# Sunucuda, depo kökünde (docker/ klasörünün olduğu yerde)
tools/crewhall/crewhall backup
tools/crewhall/crewhall list
tools/crewhall/crewhall update 1.5.0
```

Bash 4 veya üstü ve Docker Compose v2 gerekir (Linux sunucularda hazır gelir).

## Nasıl çalışır

Asıl iş backend imajının içinde yapılır (`node dist/crewhall.js`). İmajda `pg_dump`, `pg_restore`, S3
erişim bilgileri ve iç ağ zaten var; betik yalnız Docker Compose'u yönetir ve tek seferlik bir backend
konteyneri açar. Bu yüzden sunucuya ayrıca PostgreSQL istemcisi kurmak gerekmez.

Yedekler `backups` Docker volume'ünde durur (konteynerde `/backups`):

```
snapshots/<kimlik>/manifest.json   yedeğin içeriği, sürüm, migration düzeyi, sağlama toplamları
snapshots/<kimlik>/db.dump         PostgreSQL dökümü (pg_dump custom biçimi)
snapshots/<kimlik>/config.enc      isteğe bağlı: .env dosyası, şifreli
objects/<ab>/<sha256>              S3'teki dosyalar; içeriğe göre bir kez saklanır
```

Dosyalar içeriklerine göre saklandığı için her yedek yalnız değişen dosyaları ekler; yüz gecelik yedek
yüz kat yer kaplamaz. Yedek önce geçici bir klasöre yazılır, bitince görünür olur; yarıda kalan yedek
listede çıkmaz.

## Komutlar

| Komut                              | Ne yapar                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `backup [--with-config]`           | Veritabanı + dosyalar (+ şifreli `.env`) yedeği alır, kimliğini yazar                               |
| `list`                             | Yedekleri en yeniden eskiye listeler                                                                |
| `restore <kimlik> [--with-config]` | Uygulama servislerini durdurur, veritabanını ve dosyaları yedekteki hâline getirir, servisleri açar |
| `export <kimlik> > yedek.tar`      | Bir yedeği ihtiyaç duyduğu dosyalarla tek dosya olarak verir                                        |
| `import < yedek.tar`               | Başka sunucudan gelen yedeği içeri alır                                                             |
| `prune --keep <n>`                 | Elle ve gece alınan yedeklerden en yeni `n` tanesini tutar; artık kullanılmayan dosyaları siler     |
| `voip-test --email <e-posta>`      | Kişinin iPhone'larına APNs üzerinden deneme araması gönderir (CallKit); çıktıdaki kimlikle `--end <id>` bitirir |
| `update [sürüm] [--build]`         | Önce yedek alır, yeni sürüme geçer, sağlık kontrolü başarısız olursa geri döner                     |

Ortak seçenekler: `--compose-file` (varsayılan `docker/compose.yml`), `--env-file` (varsayılan
`docker/.env`), `--project` (Compose proje adı), `--profile portal` / `--profile meet` (kullandığınız
profiller), `--yes` (onay sormadan).

### Geri yükleme

```bash
tools/crewhall/crewhall list
tools/crewhall/crewhall restore 2026-10-22T03-00-00-000Z
```

Geri yükleme veritabanındaki her şeyi yedekteki hâliyle değiştirir; yedekten sonra eklenen tablolar ve
dosyalar da gider. Yedek önce denetlenir: döküm bozuksa ya da yedek daha yeni bir sürümden alınmışsa
(daha çok migration içeriyorsa) hiçbir şeye dokunulmaz. Daha yeni sürümün yedeği o sürümle geri yüklenir.

### Güncelleme

```bash
tools/crewhall/crewhall update 1.5.0      # imajları kayıt defterinden çeker
tools/crewhall/crewhall update --build    # kaynaktan kuranlar: önce git pull, sonra bu
```

Sırası:

1. Çalışan imajlar `crewhall-rollback` etiketiyle saklanır (`latest` çekince yer değiştirdiği için).
2. Mevcut sürümle yedek alınır (`list` içinde `update` olarak görünür). Yedek alınamazsa güncelleme
   başlamaz.
3. Yeni imajlar çekilir, `.env` içindeki `CREWHALL_VERSION` güncellenir, servisler açılır. Migration'lar
   backend açılırken çalışır.
4. Backend `CREWHALL_HEALTH_TIMEOUT` (varsayılan 300 sn) içinde sağlıklı olmazsa: eski imajlar eski
   etiketlerine döner, eski `.env` geri konur, 2. adımdaki yedek geri yüklenir ve servisler açılır.
   Komut hata koduyla biter ve backend günlüğünün sonunu gösterir.

`update` yedekleri `prune` ile silinmez; gerektiğinde `prune --keep <n> --all` kullanın.

### Başka sunucuya taşıma ya da sunucu dışına kopya

Yedekler sunucunun diskindedir; disk giderse yedek de gider. Düzenli olarak dışarı alın:

```bash
tools/crewhall/crewhall export 2026-10-22T03-00-00-000Z > crewhall-yedek.tar
# yeni sunucuda, kurulumdan sonra:
tools/crewhall/crewhall import < crewhall-yedek.tar
tools/crewhall/crewhall restore 2026-10-22T03-00-00-000Z
```

## Yapılandırma ve sırlar (karar)

`.env` dosyası varsayılan olarak yedeğe **girmez**. Nedeni: veritabanı ve dosyalarla aynı yerde duran
düz metin sırlar (AUTH_SECRET, veritabanı ve S3 parolaları, LiveKit anahtarları), yedeği ele geçiren
birine kurulumun tamamını verir.

İsterseniz `--with-config` ile `.env` şifreli olarak eklenir: AES-256-GCM, anahtar
`CREWHALL_BACKUP_PASSPHRASE` parolasından scrypt ile türetilir (en az 12 karakter). Parola komut satırına
yazılmaz, yalnız ortam değişkeni olarak verilir ve hiçbir yerde saklanmaz; unutulursa `.env` yedekten
çıkarılamaz.

```bash
export CREWHALL_BACKUP_PASSPHRASE='uzun ve başka yerde saklanan bir parola'
tools/crewhall/crewhall backup --with-config
tools/crewhall/crewhall restore <kimlik> --with-config   # docker/.env.restored dosyasına yazar
```

Geri yüklenen yapılandırma `docker/.env` üzerine yazılmaz; `docker/.env.restored` dosyasına çıkar,
kontrol edip yerine koyarsınız.

**Önemli:** Veritabanındaki bazı alanlar (iki adımlı doğrulama sırları, kimlik sağlayıcı sırları, paylaşım
bağlantıları) `AUTH_SECRET` ile şifrelidir. Yedeği başka bir sunucuya yüklerken aynı `AUTH_SECRET`
kullanılmalıdır. `.env`'i yedeğe eklemiyorsanız onu ayrı ve güvenli bir yerde saklayın.

## Dokploy

Dokploy da Docker Compose kullanır; komutlara Dokploy'un dosya yollarını ve proje adını verin:

```bash
tools/crewhall/crewhall \
  --compose-file /etc/dokploy/compose/<appName>/code/docker/compose.yml \
  --env-file /etc/dokploy/compose/<appName>/code/.env \
  --project <appName> backup
```

`backup`, `list`, `restore`, `export`, `import` ve `prune` aynı çalışır. Sürümü Dokploy yönettiği için
güncellemeyi orada yapın: önce `backup`, sonra Dokploy'da `CREWHALL_VERSION` değerini değiştirip yeniden
dağıtın; başarısız olursa eski sürümü Dokploy'da geri seçip `restore <kimlik>` çalıştırın.

## Sınırlar

- Yedek alınırken uygulama çalışmaya devam eder. Veritabanı dökümü tutarlıdır; dosyalar dökümden hemen
  sonra kopyalanır, arada yüklenen bir dosya yedekte fazladan bulunabilir (zararsız).
- Aynı anda tek yedek ya da geri yükleme çalışır (`/backups/.lock`; 6 saatten eski kilit sayılmaz).
- Harici bir S3 kullanıyorsanız dosyalar da bu yedeğe girer; çok büyük depolarda S3 sağlayıcısının kendi
  sürümleme ve çoğaltma özelliğini de düşünün.
