# Üçüncü taraf bildirimleri

Crewhall'ın bağımlılıklarının neredeyse tamamı MIT, Apache-2.0, BSD, ISC veya PostgreSQL lisanslıdır;
her paketin lisans metni kendi paketiyle (`node_modules/<paket>/LICENSE`) gelir. Aşağıdakiler ürünle
birlikte dağıtılan ve atıf isteyen içerik ile verilerdir. Uygulama içinde **Hesabım › Hakkında**
sayfasında da listelenir.

## Başka lisanslı bileşenler

Bunlar değiştirilmeden kullanılır ve Crewhall'ın lisansına değil kendi lisanslarına tabidir.

| Bileşen                                   | Lisans                        | Kullanım                              | Kaynak                                         |
| ----------------------------------------- | ----------------------------- | ------------------------------------- | ---------------------------------------------- |
| sharp ikilileri (`@img/sharp-*`), libvips | Apache-2.0, LGPL-3.0-or-later | Sunucuda görsel işleme, dinamik bağlı | https://github.com/lovell/sharp-libvips        |
| lightningcss                              | MPL-2.0                       | CSS derleme                           | https://github.com/parcel-bundler/lightningcss |
| elkjs                                     | EPL-2.0                       | Mermaid diyagramlarının yerleşimi     | https://github.com/kieler/elkjs                |
| Nunito, Geist Mono yazı tipleri           | OFL-1.1                       | Arayüz yazı tipleri                   | https://fontsource.org                         |
| caniuse-lite                              | CC-BY-4.0                     | Derleme sırasında tarayıcı verisi     | https://github.com/browserslist/caniuse-lite   |

## Noto Animated Emoji

- Sahibi: Google LLC
- Kaynak: https://googlefonts.github.io/noto-emoji-animation/
- Lisans: Creative Commons Attribution 4.0 International (CC BY 4.0),
  https://creativecommons.org/licenses/by/4.0/
- Kullanım: sohbette yalnız emojiden oluşan mesajlardaki hareketli emojiler
  (`apps/web/public/emoji/anim/*.json`, Lottie). Dosyalar değiştirilmeden kullanılır.

## Emojibase (emojibase-data)

- Sahibi: Miles Johnson
- Kaynak: https://emojibase.dev
- Lisans: MIT
- Kullanım: emoji listesi, grupları, ten rengi çeşitleri ve İngilizce anahtar kelimeler
  (`apps/web/src/lib/emoji/emoji-data.json`, `apps/web/scripts/build-emoji-data.mjs` ile üretilir).

## Unicode CLDR (annotations, annotationsDerived · tr)

- Sahibi: Unicode, Inc.
- Kaynak: https://cldr.unicode.org (cldr-json 48.0.0)
- Lisans: Unicode License v3, https://www.unicode.org/license.txt
- Kullanım: emojilerin Türkçe adları ve anahtar kelimeleri (`emoji-data.json` içinde).

```
UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2025 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY DOWNLOADING, INSTALLING,
COPYING OR OTHERWISE USING DATA FILES, AND/OR SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO
BE BOUND BY, ALL OF THE TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a copy of data files and
any associated documentation (the "Data Files") or software and any associated documentation
(the "Software") to deal in the Data Files or Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute, and/or sell copies of
the Data Files or Software, and to permit persons to whom the Data Files or Software are
furnished to do so, provided that either (a) this copyright and permission notice appear with
all copies of the Data Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT OF THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE BE LIABLE FOR ANY
CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES, OR ANY DAMAGES WHATSOEVER RESULTING
FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA FILES
OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall not be used in
advertising or otherwise to promote the sale, use or other dealings in these Data Files or
Software without prior written authorization of the copyright holder.
```

## lottie-web

- Sahibi: Airbnb
- Kaynak: https://github.com/airbnb/lottie-web
- Lisans: MIT
- Kullanım: hareketli emojileri oynatan kitaplık (`lottie_light`, `eval` kullanmaz).
