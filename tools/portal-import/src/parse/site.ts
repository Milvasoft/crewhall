import type { PortalHome, PortalNavigation, PortalSiteSettings } from '@crewhall/shared';
import { arr, isObject, obj, str, YEAR_TOKEN, type JsObject, type JsValue } from './config';
import type { ParseContext } from './context';

type LocalizedText = Record<string, string>;
type NavItem = PortalNavigation['navbar']['items'][number];
type FooterColumn = PortalNavigation['footer']['columns'][number];
type HomeSection = PortalHome['sections'][number];

/** Maps a site asset path (`img/logo.svg`, `/img/x.png`) to `/media/...`; null when missing. */
export type MediaLookup = (assetPath: string, source: string) => string | null;

const CONFIG = 'docusaurus.config.js';

/** `i18n/<locale>/<plugin>/<file>.json` → key → message. */
function readMessages(ctx: ParseContext, file: string): Map<string, string> {
  const out = new Map<string, string>();
  const data = ctx.readJson(file);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const message = (value as { message?: unknown } | null)?.message;
      if (typeof message === 'string') out.set(key, message);
    }
  }
  return out;
}

/** Unique short ids for menu items / sections. */
function idMaker() {
  const used = new Set<string>();
  return (hint: string) => {
    const slug = hint
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const base = (slug || 'item').slice(0, 36);
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
    used.add(id);
    return id;
  };
}

// ---------------------------------------------------------------------------
// Site settings and unsupported config

export function readSettings(
  ctx: ParseContext,
  config: JsObject,
  media: MediaLookup,
): Partial<PortalSiteSettings> {
  const themeConfig = obj(config.themeConfig);
  const navbar = obj(themeConfig.navbar);
  const logo = obj(navbar.logo);
  const prism = obj(themeConfig.prism);
  const settings: Partial<PortalSiteSettings> = {};
  const title = str(config.title);
  if (title) settings.title = title;
  settings.tagline = str(config.tagline);
  const url = str(config.url);
  settings.url = url && /^https?:\/\//.test(url) ? url.replace(/\/+$/, '') : null;
  const favicon = str(config.favicon);
  settings.favicon = favicon ? media(favicon, `${CONFIG} › favicon`) : null;
  const image = str(themeConfig.image);
  settings.socialImage = image ? media(image, `${CONFIG} › themeConfig.image`) : null;
  settings.logo = {
    src: str(logo.src) ? media(str(logo.src) ?? '', `${CONFIG} › navbar.logo.src`) : null,
    srcDark: str(logo.srcDark)
      ? media(str(logo.srcDark) ?? '', `${CONFIG} › navbar.logo.srcDark`)
      : null,
    alt: str(logo.alt) ?? '',
  };
  settings.prism = { light: str(prism.theme) ?? 'github', dark: str(prism.darkTheme) ?? 'dracula' };
  return settings;
}

/** Report rows for config parts the portal does not carry over. */
export function reportConfig(ctx: ParseContext, config: JsObject, classic: JsObject): void {
  const baseUrl = str(config.baseUrl);
  if (baseUrl && baseUrl !== '/') {
    ctx.report({
      type: 'setting',
      source: `${CONFIG} › baseUrl`,
      action: `Site ${baseUrl} altında yayındaydı; portal kök adreste yayınlar, yönlendirme gerekir`,
      target: null,
    });
  }
  for (const plugin of ['docs', 'blog'] as const) {
    const editUrl = obj(classic[plugin]).editUrl;
    if (editUrl === undefined || editUrl === null || editUrl === false) continue;
    const template = typeof editUrl === 'string' && /facebook\/docusaurus/.test(editUrl);
    ctx.report({
      type: template ? 'setting' : 'unsupported',
      source: `${CONFIG} › ${plugin}.editUrl`,
      action: template
        ? 'Şablon deposuna gidiyordu; "Bu sayfayı düzenle" linki kapatıldı'
        : '"Bu sayfayı düzenle" linki desteklenmiyor; kapatıldı',
      target: null,
    });
  }
  const theme = obj(classic.theme);
  if (theme.customCss !== undefined) {
    ctx.report({
      type: 'unsupported',
      source: `${CONFIG} › theme.customCss`,
      action: 'Özel CSS taşınmadı; görünüm portal sitesinin kodunda',
      target: null,
    });
  }
  const themeConfig = obj(config.themeConfig);
  for (const [where, value] of [
    ['scripts', config.scripts],
    ['themeConfig.scripts', themeConfig.scripts],
    ['stylesheets', config.stylesheets],
    ['clientModules', config.clientModules],
  ] as const) {
    const list = arr(value ?? null);
    if (list.length === 0) continue;
    const names = list
      .map((v) => (isObject(v) ? (str(v.src) ?? str(v.href)) : str(v)))
      .filter(Boolean);
    ctx.report({
      type: 'unsupported',
      source: `${CONFIG} › ${where}`,
      action: `Özel betik/stil (${names.join(', ')}) taşınmadı; gerekiyorsa site kodunda karşılanır`,
      target: null,
    });
  }
  for (const [kind, value] of [
    ['themes', config.themes],
    ['plugins', config.plugins],
  ] as const) {
    for (const entry of arr(value ?? null)) {
      const name = Array.isArray(entry) ? str(entry[0] ?? null) : str(entry);
      if (!name) continue;
      if (/theme-mermaid/.test(name)) continue;
      ctx.report(
        /search/i.test(name)
          ? {
              type: 'setting',
              source: `${CONFIG} › ${kind}`,
              action: `${name} kaldırıldı; site araması Hub arama API'siyle yapılır`,
              target: null,
            }
          : {
              type: 'unsupported',
              source: `${CONFIG} › ${kind}`,
              action: `${name} eklentisi taşınmadı`,
              target: null,
            },
      );
    }
  }
  // Swizzled theme components.
  const themeDir = 'src/theme';
  if (ctx.isDir(themeDir)) {
    const names = new Set(
      ctx.files(themeDir).map(
        (f) =>
          f
            .slice(themeDir.length + 1)
            .split('/')[0]
            ?.replace(/\.[jt]sx?$/, '') ?? '',
      ),
    );
    for (const name of [...names].filter(Boolean)) {
      ctx.report({
        type: 'unsupported',
        source: `${themeDir}/${name}`,
        action: 'Özelleştirilmiş tema bileşeni; portal sitesinin kodunda karşılanır',
        target: null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Navbar and footer

export function readNavigation(
  ctx: ParseContext,
  config: JsObject,
  locales: string[],
  defaultLocale: string,
  media: MediaLookup,
  docUrl: (docId: string) => string | null,
  blogBase: string,
): PortalNavigation | null {
  const themeConfig = obj(config.themeConfig);
  if (!isObject(themeConfig.navbar) && !isObject(themeConfig.footer)) return null;
  const navbar = obj(themeConfig.navbar);
  const footer = obj(themeConfig.footer);
  const others = locales.filter((l) => l !== defaultLocale);
  const navMessages = new Map(
    others.map((l) => [l, readMessages(ctx, `i18n/${l}/docusaurus-theme-classic/navbar.json`)]),
  );
  const footerMessages = new Map(
    others.map((l) => [l, readMessages(ctx, `i18n/${l}/docusaurus-theme-classic/footer.json`)]),
  );
  const localized = (
    text: string | null,
    messages: Map<string, Map<string, string>>,
    key: string,
  ): LocalizedText => {
    const out: LocalizedText = {};
    if (text) out[defaultLocale] = text;
    for (const l of others) {
      const m = messages.get(l)?.get(key);
      if (m) out[l] = m;
    }
    return out;
  };

  const navId = idMaker();
  const items: NavItem[] = [];
  for (const raw of arr(navbar.items)) {
    const item = obj(raw);
    const type = str(item.type);
    const label = str(item.label);
    const position = item.position === 'right' ? 'right' : 'left';
    const labelText = localized(label, navMessages, `item.label.${label ?? ''}`);
    const to = str(item.to);
    const href = str(item.href);
    let entry: NavItem | null = null;
    if (type === 'docSidebar') {
      entry = {
        id: navId(label ?? 'docs'),
        kind: 'docs',
        position,
        label: labelText,
        hidden: false,
      };
    } else if (type === 'doc') {
      const target = str(item.docId);
      entry = {
        id: navId(label ?? target ?? 'doc'),
        kind: 'doc',
        position,
        label: labelText,
        href: target ? docUrl(target) : null,
        hidden: false,
      };
    } else if (type === 'localeDropdown') {
      entry = {
        id: navId('locale'),
        kind: 'localeDropdown',
        position,
        label: labelText,
        hidden: false,
      };
    } else if (type === 'docsVersionDropdown') {
      entry = {
        id: navId('version'),
        kind: 'versionDropdown',
        position,
        label: labelText,
        hidden: false,
      };
    } else if (!type || type === 'default') {
      if (to && to.replace(/\/+$/, '') === blogBase) {
        entry = {
          id: navId(label ?? 'blog'),
          kind: 'blog',
          position,
          label: labelText,
          hidden: false,
        };
      } else if (to || href) {
        entry = {
          id: navId(label ?? 'link'),
          kind: 'link',
          position,
          label: labelText,
          href: to ?? href,
          hidden: false,
        };
      }
    }
    if (!entry) {
      ctx.report({
        type: 'unsupported',
        source: `${CONFIG} › navbar.items`,
        action: `"${label ?? type ?? 'öğe'}" (${type ?? 'link'}) menü öğesi desteklenmiyor; eklenmedi`,
        target: null,
      });
      continue;
    }
    if (items.length < 20) items.push(entry);
  }

  const logo = obj(navbar.logo);
  const footerId = idMaker();
  const columns: FooterColumn[] = [];
  const links = arr(footer.links);
  const multiColumn = links.some((l) => isObject(l) && Array.isArray(l.items));
  const groups: JsObject[] = multiColumn
    ? links.filter(isObject)
    : links.length
      ? [{ title: null, items: links }]
      : [];
  for (const group of groups) {
    const title = str(group.title);
    const colItems: FooterColumn['items'] = [];
    const itemId = idMaker();
    for (const rawItem of arr(group.items)) {
      const it = obj(rawItem);
      const label = str(it.label);
      const target = str(it.to) ?? str(it.href);
      if (!label || !target) {
        ctx.report({
          type: 'unsupported',
          source: `${CONFIG} › footer.links`,
          action: 'HTML ya da etiketsiz alt bilgi öğesi taşınmadı',
          target: null,
        });
        continue;
      }
      if (colItems.length >= 20) break;
      colItems.push({
        id: itemId(label),
        label: localized(label, footerMessages, `link.item.label.${label}`),
        href: target,
      });
    }
    if (columns.length >= 8) break;
    columns.push({
      id: footerId(title ?? 'links'),
      title: localized(title, footerMessages, `link.title.${title ?? ''}`),
      items: colItems,
    });
  }

  const copyright = localized(str(footer.copyright), footerMessages, 'copyright');
  if (copyright[defaultLocale]?.includes(YEAR_TOKEN)) {
    for (const l of others) {
      const text = copyright[l];
      const year = text && !text.includes(YEAR_TOKEN) ? /\b(19|20)\d{2}\b/.exec(text) : null;
      if (year) {
        ctx.report({
          type: 'setting',
          source: `i18n/${l}/docusaurus-theme-classic/footer.json › copyright`,
          action: `Telif metninde yıl elle yazılmış (${year[0]}); {year} önerilir`,
          target: null,
        });
      }
    }
  }

  return {
    navbar: {
      title: localized(str(navbar.title), navMessages, 'title'),
      logo: {
        src: str(logo.src) ? media(str(logo.src) ?? '', `${CONFIG} › navbar.logo.src`) : null,
        srcDark: str(logo.srcDark)
          ? media(str(logo.srcDark) ?? '', `${CONFIG} › navbar.logo.srcDark`)
          : null,
        alt: str(logo.alt) ?? '',
      },
      items,
    },
    footer: {
      style: footer.style === 'light' ? 'light' : 'dark',
      columns,
      copyright,
    },
  };
}

// ---------------------------------------------------------------------------
// Home page (src/pages/homepageContent.json + the video embed of src/pages/index.*)

const HOME_FILE = 'src/pages/homepageContent.json';

export function readHome(
  ctx: ParseContext,
  locales: string[],
  defaultLocale: string,
  currentVersion: string,
  media: MediaLookup,
): PortalHome | null {
  const data = ctx.readJson(HOME_FILE);
  if (!isObject(data as JsValue)) return null;
  const content = data as JsObject;
  const perLocale = (section: JsObject, field: string): LocalizedText => {
    const out: LocalizedText = {};
    for (const l of locales) {
      const v = str(obj(section[l])[field] ?? null);
      if (v) out[l] = v;
    }
    return out;
  };
  const img = (v: JsValue | undefined, where: string) => {
    const s = str(v ?? null);
    return s ? media(s, `${HOME_FILE} › ${where}`) : null;
  };
  const sections: HomeSection[] = [];
  // Layout images of the landing page (homepageContent.json `images`): the hero uses
  // `milva` as its mark and subtract / tech / milvahoriz / milvahoriz2 as card shape,
  // circuit background and the vertical / horizontal wordmarks; features use `dot`.
  const shared = obj(content.images ?? null);
  const imgList = (keys: string[]) =>
    keys.map((k) => img(shared[k], `images.${k}`)).filter((v): v is string => v !== null);

  if (isObject(content.hero)) {
    const hero = content.hero;
    const badge = perLocale(hero, 'version');
    for (const [l, text] of Object.entries(badge)) {
      const m = /\d+(?:\.\d+)+(?:[-.][0-9A-Za-z.]+)?/.exec(text);
      if (!m) continue;
      badge[l] = text.replace(m[0], '{version}');
      ctx.report({
        type: 'home',
        source: `${HOME_FILE} › hero.${l}.version`,
        action: `"${text}" elle yazılmış; "${badge[l]}" yapıldı (güncel versiyon ${currentVersion})`,
        target: null,
      });
    }
    sections.push({
      id: 'hero',
      type: 'hero',
      hidden: false,
      title: perLocale(hero, 'title'),
      description: perLocale(hero, 'description'),
      ...(Object.keys(badge).length ? { badge } : {}),
      image: img(shared.milva, 'images.milva'),
      images: imgList(['subtract', 'tech', 'milvahoriz', 'milvahoriz2']),
    });
  }

  if (isObject(content.whoWeAre)) {
    sections.push({
      id: 'about',
      type: 'about',
      hidden: false,
      title: perLocale(content.whoWeAre, 'title'),
      description: perLocale(content.whoWeAre, 'description'),
    });
  }

  const page = ['src/pages/index.tsx', 'src/pages/index.jsx', 'src/pages/index.js'].find((f) =>
    ctx.isFile(f),
  );
  const video = page ? /youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})/.exec(ctx.read(page)) : null;
  if (video?.[1]) {
    sections.push({ id: 'video', type: 'video', hidden: false, title: {}, videoId: video[1] });
  }

  if (isObject(content.card)) {
    const card = content.card;
    const items: Record<string, string[]> = {};
    for (const l of locales) {
      const list = arr(obj(card[l]).features ?? null).filter(
        (v): v is string => typeof v === 'string',
      );
      if (list.length) items[l] = list;
    }
    const image = obj(card[defaultLocale]).image ?? card.image;
    sections.push({
      id: 'features',
      type: 'features',
      hidden: false,
      title: perLocale(card, 'title'),
      items,
      image: img(image, `card.${defaultLocale}.image`),
      images: imgList(['dot']),
    });
  }

  if (isObject(content.techs)) {
    const techs = content.techs;
    sections.push({
      id: 'technologies',
      type: 'technologies',
      hidden: false,
      title: perLocale(techs, 'title'),
      description: perLocale(techs, 'description'),
      image: img(techs.eyeImage, 'techs.eyeImage'),
      images: arr(techs.floatingImages ?? null)
        .map((v, i) => img(v, `techs.floatingImages[${i}]`))
        .filter((v): v is string => v !== null),
    });
  }

  if (isObject(content.community)) {
    const community = content.community;
    sections.push({
      id: 'community',
      type: 'community',
      hidden: false,
      title: perLocale(community, 'title'),
      description: perLocale(community, 'description'),
      image: img(community.backgroundImage, 'community.backgroundImage'),
    });
  }

  if (isObject(content.openSource)) {
    const os = content.openSource;
    const projects = arr(os.projects ?? null)
      .filter(isObject)
      .map((p, i) => {
        const description: LocalizedText = {};
        if (typeof p.description === 'string') description[defaultLocale] = p.description;
        else if (isObject(p.description)) {
          for (const [l, v] of Object.entries(p.description))
            if (typeof v === 'string') description[l] = v;
        }
        return {
          name: str(p.name) ?? '',
          image: img(p.image, `openSource.projects[${i}].image`),
          url: str(p.githubUrl ?? null) ?? str(p.url ?? null),
          description,
          badges: arr(p.badges ?? null)
            .filter(isObject)
            .map((b) => ({
              url: str(b.url) ?? '',
              image: str(b.badgeUrl) ?? str(b.image) ?? '',
              alt: str(b.alt) ?? '',
            }))
            .filter((b) => b.image !== ''),
        };
      });
    sections.push({
      id: 'projects',
      type: 'projects',
      hidden: false,
      title: perLocale(os, 'title'),
      description: perLocale(os, 'description'),
      projects,
    });
  }

  return { sections };
}
