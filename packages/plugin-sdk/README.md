# @crewhall/plugin-sdk

Crewhall'a eklenti yazmak için SDK (MIT). Crewhall eklenti kodu çalıştırmaz: eklentinin arayüzü ve
sunucusu eklentiyi yazanın kendi sunucusundadır; Crewhall pazar yerinin imzaladığı manifesti kurar, arayüzü
korumalı bir iframe'de açar ve istekleri imzalayarak eklenti sunucusuna gönderir. Ayrıntı:
`docs/contracts/eklentiler.md`.

| Giriş                         | İçerik                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@crewhall/plugin-sdk`        | Manifest şeması (`PluginManifest`), imzalı paket (`signPackage`, `verifyPackage`), `PLUGIN_API_LEVEL` |
| `@crewhall/plugin-sdk/bridge` | iframe köprüsü: eklenti sayfası için `connect()`, Crewhall için `attachHost()`                        |
| `@crewhall/plugin-sdk/server` | Eklenti sunucusu: `verifyRequest` (HMAC), `verifySessionToken` (EdDSA JWT), istek gövdeleri           |

## Hızlı başlangıç

```ts
// Eklenti sayfası (iframe içinde)
import { connect } from '@crewhall/plugin-sdk/bridge';

const bridge = await connect();
document.body.textContent = `Merhaba ${bridge.context.user.name}`;
const token = await bridge.getToken(); // eklenti sunucusuna gönder
```

```ts
// Eklenti sunucusu
import { verifyRequest, verifySessionToken } from '@crewhall/plugin-sdk/server';

const ok = await verifyRequest({ secret, body, signature: req.headers['crewhall-signature'] });
const who = await verifySessionToken(token, {
  issuer: installation.apiUrl,
  audience: 'com.acme.hello',
});
```

## CLI

```bash
pnpm --filter @crewhall/plugin-sdk plugin validate manifest.json
```

`publish <manifest.json> --market <url> --token <geliştirici tokenı>` sürümü pazar yerine incelemeye gönderir.
`keygen` pazar yeri işletmecisi için Ed25519 anahtar çifti üretir.
