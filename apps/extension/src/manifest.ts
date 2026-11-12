/**
 * The public half of the extension's signing key: it fixes the extension id, which the server
 * lists in BROWSER_EXTENSION_IDS (packages/shared/src/schemas/auth.ts).
 */
const PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw/XQihLdNgetd4GWcnoZwt7f5ouGs3F6AzVOKDlPs3VsPjxUO9HVsWzmXkATSVutrX7ruvV04Y/4KmisaCFUsc1Ym5cyWAaN/uT4lUfCNstpIs/t3Hh12fU4c41RHiJqShAdi7FgW+v1koUxmdtWbZoeRdW5/HXZWGCAc73mqxLH6+EM3yx7JKdeGtq4bQwdZwzWoshm8lGu3UuEGgwd2FY2fefnKz0ynwLUqTlYGbieJd14Fv593R0wW+CVYCqmy9SiNM17ED4HbDtjzN+qZ25+ynm2SHZwUP75hMdwHpq/oAu+YRnIL0A5xYMukvOFMdXoC/o0TKh17L7QqE8jyQIDAQAB';

const icons = { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' };

/**
 * What the extension asks for at install stays small. Sites are added when the person acts:
 * their Crewhall address on connecting, every site only when they turn the vault on.
 */
export function buildManifest(version: string) {
  return {
    manifest_version: 3,
    name: '__MSG_name__',
    description: '__MSG_description__',
    default_locale: 'tr',
    version,
    minimum_chrome_version: '127',
    key: PUBLIC_KEY,
    icons,
    action: { default_popup: 'popup.html', default_icon: icons, default_title: 'Crewhall' },
    background: { service_worker: 'background.js', type: 'module' },
    side_panel: { default_path: 'sidepanel.html' },
    options_ui: { page: 'options.html', open_in_tab: true },
    omnibox: { keyword: 'ch' },
    commands: {
      _execute_action: { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' } },
    },
    permissions: [
      'activeTab',
      'alarms',
      'clipboardWrite',
      'contextMenus',
      'identity',
      'idle',
      'offscreen',
      'scripting',
      'sidePanel',
      'storage',
    ],
    optional_permissions: ['clipboardRead', 'privacy'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    // WebAssembly: Argon2id, which derives the keys from the vault password.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    web_accessible_resources: [
      // The save question is the only page a website may frame.
      { resources: ['prompt.html'], matches: ['<all_urls>'] },
    ],
  };
}
