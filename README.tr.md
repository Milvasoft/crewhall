# Crewhall

[English](README.md)

Crewhall, ekipler için kendi sunucunda çalışan bir çalışma alanıdır: hızlı erişim, Drive, sohbet,
sayfalar, panolar, çizimler, toplantılar, sıfır bilgili kasa ve belge portalı tek yerde. Kurumunun
adı, logosu ve renkleri yönetim panelinden gelir.

## Özellikler

- **Ana sayfa:** hızlı erişim kartları, bağlantılar, notlar ve duyurular.
- **Drive:** klasörler, paylaşım, sürümler, çöp kutusu, önizleme ve isteğe bağlı ayrı bir servisle
  Office düzenleme.
- **Sohbet:** kanallar, özel mesajlar, yanıt dizileri, tepkiler, aramalar ve botlar.
- **Sayfalar ve panolar:** gerçek zamanlı ortak düzenlemeli wiki ve görev panoları.
- **Çizimler:** ortak beyaz tahta.
- **Toplantılar:** LiveKit üzerinde görüntülü toplantı.
- **Kasa:** sıfır bilgili parola paylaşımı. Sunucu çözülmüş veriyi hiç görmez.
- **Portal:** çalışma alanından yönetilen herkese açık belge ve blog sitesi.
- **Kimlik:** e-posta ve şifre, TOTP, passkey, OIDC ve dizin girişi.
- **Eklentiler:** sekme, kart, komut ve araç eklemek için SDK. Bkz. [packages/plugin-sdk](packages/plugin-sdk).
- **MCP:** yapay zekâ asistanlarını bağlantı başına yetkiyle çalışma alanına bağlama.
- **İstemciler:** web ile Windows ve macOS masaüstü uygulaması. Arayüz Türkçe ve İngilizce.

## Sunucuya kurulum

Crewhall tek bir Linux sunucuda Docker Compose ile çalışır. Adım adım anlatım
[docs/kurulum.md](docs/kurulum.md) dosyasındadır.

```bash
git clone <repo-adresi> crewhall && cd crewhall
cp docker/.env.example docker/.env
```

`docker/.env` dosyasını belgedeki gibi doldurup yığını `docker/compose.yml` ile başlat.

## Geliştirme

Node 22, Docker ve pnpm (`corepack enable`) gerekir.

```bash
tools/dev-up/dev-up.sh
```

Bu komut Postgres, S3 deposu ve e-posta yakalayıcıyı başlatır, yerel `.env` dosyalarını oluşturur,
örnek bir kurum yükler; API, ortak düzenleme sunucusu ve web uygulamasını çalıştırır. Windows'ta
`tools/dev-up/dev-up.ps1` aynı işi yapar.

Değişiklik göndermeden önce şunun geçmesi gerekir:

```bash
pnpm turbo run typecheck lint test
```

## Bu depoda olmayanlar

Merkezî eklenti pazar yeri servisi ve mobil uygulama bu depoda değildir. Eklentiler yine kendi
sunucundan kurulabilir. Backend'in hangi pazar yeriyle konuşacağını `MARKETPLACE_URL` belirler.

## Lisans

Crewhall **kaynağı açık** bir yazılımdır: kod herkese açıktır ve ücretsiz kullanılır, ama satılamaz.
Lisansı Apache License 2.0 ile [Commons Clause](https://commonsclause.com) koşuludur. Bu koşul
nedeniyle Open Source Initiative'in tanımıyla "açık kaynak" sayılmaz. Bağlayıcı olan
[LICENSE](LICENSE) dosyasıdır, bu tablo yalnız özettir.

| Yapabilirsin                                                    | Yapamazsın                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------- |
| Tek başına veya her büyüklükte şirket içinde ücretsiz kullanmak | Crewhall'ı ya da büyük ölçüde ona dayanan bir ürünü satmak |
| Kendi sunucunda kendi insanların için çalıştırmak               | Başkalarına ücretli barındırma hizmeti olarak sunmak       |
| Kodu okumak, değiştirmek, fork etmek                            | Crewhall ile ilgili ücretli danışmanlık veya destek vermek |
| Lisans bildirimlerini koruyarak başkalarıyla paylaşmak          |                                                            |

`packages/plugin-sdk` ve `apps/plugin-hello` MIT lisanslıdır, eklenti yapıp satabilirsin. Crewhall
ve Milvasoft adları ile logoları lisansa dahil değildir; dağıtılan bir fork kendi adını ve logosunu
kullanmalıdır.

Ticari lisans için [Milvasoft](https://www.milvasoft.com) ile iletişime geç.

## Katkı ve güvenlik

Bkz. [CONTRIBUTING.md](CONTRIBUTING.md) ve [SECURITY.md](SECURITY.md).
