/**
 * Generated stand-ins for blob derivatives (thumb_256, thumb_1024, pdf pages, video posters)
 * so the mock shows previews without binary fixtures. SVG data URLs, deterministic per name.
 */

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function url(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Screenshot-like picture: soft gradient, a window and a few blocks. */
export function imageArt(name: string, width: number, height: number): string {
  const h = hash(name);
  const hue = h % 360;
  const w = 320;
  const ht = Math.round((w * height) / Math.max(width, 1));
  const blocks = Array.from({ length: 4 }, (_, i) => {
    const y = Math.round(ht * 0.28 + i * ht * 0.14);
    const bw = 60 + ((h >> (i * 3)) % 140);
    return `<rect x="${w * 0.12}" y="${y}" width="${bw}" height="${Math.max(6, ht * 0.06)}" rx="4" fill="hsl(${hue} 30% 92% / .9)"/>`;
  }).join('');
  return url(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 58%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 70% 42%)"/></linearGradient></defs>` +
      `<rect width="${w}" height="${ht}" fill="url(#g)"/>` +
      `<rect x="${w * 0.08}" y="${ht * 0.12}" width="${w * 0.84}" height="${ht * 0.76}" rx="10" fill="hsl(${hue} 40% 20% / .35)"/>` +
      blocks +
      `<circle cx="${w * 0.8}" cy="${ht * 0.3}" r="${Math.min(w, ht) * 0.09}" fill="hsl(${(hue + 180) % 360} 80% 70%)"/>` +
      `</svg>`,
  );
}

/** Logo-like vector art for svg files. */
export function logoArt(name: string, dark: boolean): string {
  const bg = dark ? '#141516' : '#ffffff';
  const fg = dark ? '#FBC419' : '#141516';
  return url(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200" width="320" height="200">` +
      `<rect width="320" height="200" fill="${bg}"/>` +
      `<rect x="118" y="58" width="84" height="84" rx="22" fill="${fg}"/>` +
      `<text x="160" y="114" font-family="Nunito, sans-serif" font-size="40" font-weight="800" text-anchor="middle" fill="${bg}">${esc(name.charAt(0).toUpperCase())}</text>` +
      `</svg>`,
  );
}

/** A4 page with a title, a chart band and text lines. */
export function pdfPage(title: string, lines: string[], page: number): string {
  const h = hash(`${title}${page}`);
  const hue = h % 360;
  const text = lines
    .map(
      (l, i) =>
        `<text x="56" y="${250 + i * 34}" font-family="Nunito, sans-serif" font-size="17" fill="#3a3b3c">${esc(l)}</text>`,
    )
    .join('');
  const bars = Array.from({ length: 4 }, (_, i) => {
    const bh = 40 + ((h >> (i * 4)) % 70);
    return `<rect x="${360 + i * 44}" y="${200 - bh}" width="28" height="${bh}" rx="4" fill="hsl(${hue} 70% ${45 + i * 8}%)"/>`;
  }).join('');
  return url(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595 842" width="595" height="842">` +
      `<rect width="595" height="842" fill="#ffffff"/>` +
      `<text x="56" y="96" font-family="Nunito, sans-serif" font-size="30" font-weight="800" fill="#141516">${esc(title)}</text>` +
      `<rect x="56" y="118" width="64" height="5" rx="2" fill="#FBC419"/>` +
      bars +
      text +
      `<text x="539" y="806" font-family="Nunito, sans-serif" font-size="13" text-anchor="end" fill="#8a8a88">${page}</text>` +
      `</svg>`,
  );
}

/** Dark video frame with a play mark. */
export function videoPoster(name: string): string {
  const hue = hash(name) % 360;
  return url(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 35% 22%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 45% 12%)"/></linearGradient></defs>` +
      `<rect width="320" height="180" fill="url(#g)"/>` +
      `<rect x="24" y="22" width="150" height="10" rx="5" fill="hsl(${hue} 30% 70% / .5)"/>` +
      `<rect x="24" y="42" width="100" height="8" rx="4" fill="hsl(${hue} 30% 70% / .35)"/>` +
      `<circle cx="160" cy="96" r="26" fill="rgba(255,255,255,.88)"/>` +
      `<path d="M152 82 L174 96 L152 110 Z" fill="#141516"/>` +
      `</svg>`,
  );
}
