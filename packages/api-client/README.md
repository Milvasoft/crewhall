# @crewhall/api-client

Crewhall REST API'si için tipli istemci. Uç adları, yol parametreleri, gövdeler, sorgular ve yanıtlar
sunucunun doğrulama için kullandığı sözleşme tablosundan (`@crewhall/shared`) gelir; yanlış bir uç adı ya da
eksik bir alan derleme anında yakalanır.

Aynı sözleşmeden üretilen OpenAPI 3.1 belgesi `/api/openapi.json` adresindedir. Etkileşimli başvuru
Hesabım › MCP ve API › REST API ekranındadır (`/api/docs` oraya yönlendirir).

## Kurulum

```bash
pnpm add @crewhall/api-client zod
```

Paket yalnız ESM'dir ve Node 20+ ya da güncel tarayıcılarla çalışır. Sözleşme pakete gömülüdür; tek çalışma
zamanı bağımlılığı `zod`'dur.

## Kişisel token ile kullanım

Hesabım › MCP ve API ekranından bir kişisel erişim token'ı (`mhp_…`) oluştur ve kodda değil ortam
değişkeninde tut.

```ts
import { ApiError, createApiClient } from '@crewhall/api-client';

const api = createApiClient({
  baseUrl: 'https://hub.example.com',
  getToken: () => process.env.CREWHALL_TOKEN ?? null,
});

const { items } = await api.call('listSpaces');

try {
  await api.call('createFolder', {
    params: { spaceId: items[0]!.id },
    body: { parentId: null, name: 'CI çıktıları' },
    // Tekrarlanan istek aynı yanıtı döndürür (24 saat).
    idempotencyKey: crypto.randomUUID(),
  });
} catch (err) {
  if (err instanceof ApiError && err.code === 'token_scope') {
    // Token'da bu işlem için kapsam yok (ör. drive:write).
  }
}
```

Token sahibinin yetkileriyle çalışır ve oluştururken seçilen kapsam ve space'lerle sınırlıdır. Hesap,
güvenlik, oturum, token yönetimi ve kasa uçları token'a hiçbir zaman açık değildir. Her ucun gerektirdiği
kapsam OpenAPI belgesinde `x-crewhall-token-scope` alanında ve açıklamasında yazar.

## Seçenekler

| Seçenek             | Açıklama                                                                   |
| ------------------- | -------------------------------------------------------------------------- |
| `baseUrl`           | Kurulumun adresi (ör. `https://hub.example.com`).                          |
| `getToken`          | `Authorization: Bearer` başlığına giden token; kişisel ya da mobil oturum. |
| `credentials`       | Tarayıcıda çerezle oturum için `'include'`.                                |
| `fetch`             | Özel `fetch` (test, vekil).                                                |
| `validateResponses` | Yanıtları sözleşme şemasıyla doğrula (geliştirme ve testte önerilir).      |
| `locale`            | `Accept-Language`; hata iletileri bu dilde gelir (`tr`, `en`).             |

Hatalar `ApiError` olarak fırlatılır: `status`, `code` (`errors.<code>` i18n anahtarı), `message`,
`details`. Listeler imleçlidir: `query: { cursor, limit }` gönderilir, yanıt `{ items, nextCursor }`
biçimindedir.

## Monorepo içinde ve yayın

Monorepo'da (web, backend) ve mobil uygulamada (`link:`) paket kaynak koddan (`src/`) kullanılır; derleme
gerekmez. Yayın için `pnpm pack` ya da `pnpm publish` `prepack` adımında `tsup` ile `dist/` üretir:
sözleşme JS'e ve tiplere gömülür, `publishConfig` paketin girişlerini `dist/`'e çevirir.

Paket şimdilik `"private": true`: kazara yayını engeller. Özel registry hazır olduğunda `private` kaldırılır,
`publishConfig.registry` ayarlanır ve sürüm sözleşme değişikliğine göre artırılır (uç eklemek minor, uç ya da
alan değiştirmek major). Lisans (`license`) ürün kararı verilince güncellenecek.
