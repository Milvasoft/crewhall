import '@fontsource-variable/nunito';
import '@scalar/api-reference/style.css';
import { createApiReference } from '@scalar/api-reference';
import { config } from '@/config';

/**
 * The REST API reference (Scalar, MIT) on the server's generated OpenAPI document. Runs in its
 * own page inside an iframe: Scalar brings global CSS (resets, utilities) the app must not get.
 * The framing screen passes the colour scheme and language in the query string.
 */
const q = new URLSearchParams(window.location.search);
const dark = q.get('theme') === 'dark';
const lang = q.get('lang') === 'en' ? 'en' : 'tr';
document.documentElement.lang = lang;

createApiReference('#app', {
  url: `${config.apiUrl}/api/openapi.json?lang=${lang}`,
  // Nothing leaves the installation: no telemetry, no font CDN, no hosted AI chat.
  telemetry: false,
  withDefaultFonts: false,
  agent: { disabled: true },
  showDeveloperTools: 'never',
  hideDarkModeToggle: true,
  forceDarkModeState: dark ? 'dark' : 'light',
  documentDownloadType: 'none',
  localization: { locale: lang },
  authentication: { preferredSecurityScheme: 'personalToken' },
  customCss: `
    .scalar-app, .scalar-api-reference { font-family: 'Nunito Variable', ui-sans-serif, system-ui, sans-serif; }
    .light-mode { --scalar-color-accent: #b07d00; }
    .dark-mode { --scalar-color-accent: #fbc419; }
  `,
});
