/** The plugin page's stylesheet: Crewhall's tokens, light and dark, served as /app.css. */
export const CSS = `
@font-face {
  font-family: Nunito; font-style: normal; font-display: swap; font-weight: 200 1000;
  src: url('/nunito-latin-ext.woff2') format('woff2-variations');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: Nunito; font-style: normal; font-display: swap; font-weight: 200 1000;
  src: url('/nunito-latin.woff2') format('woff2-variations');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
:root {
  color-scheme: light;
  --accent: #fbc419; --accent-fg: #141516;
  --bg: #f7f7f6; --bg2: #efefed; --surface: #fff; --line: rgba(11,11,11,.08); --line2: rgba(11,11,11,.16);
  --fg: #0b0b0b; --fg2: #5f5f5f; --fg3: #767674; --accent-soft: rgba(249,195,26,.18); --accent-text: #8a6100;
  --ok: #15803d; --ok-soft: rgba(21,128,61,.11); --warn: #c2620f; --warn-soft: rgba(194,98,15,.12);
  --err: #dc3b3b; --err-soft: rgba(220,59,59,.1); --info: #0e7490; --info-soft: rgba(14,116,144,.11);
  --shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.05);
  --mono: ui-monospace, SFMono-Regular, Consolas, monospace;
}
html.dark {
  color-scheme: dark;
  --bg: #0e0f0f; --bg2: #1d1e1f; --surface: #151617; --line: rgba(255,255,255,.08); --line2: rgba(255,255,255,.16);
  --fg: #f5f5f5; --fg2: #a5a6a6; --fg3: #8b8c8c; --accent-soft: rgba(251,196,25,.14); --accent-text: #fbc419;
  --ok: #3dd68c; --ok-soft: rgba(61,214,140,.12); --warn: #f38424; --warn-soft: rgba(243,132,36,.14);
  --err: #ff6369; --err-soft: rgba(255,99,105,.12); --info: #38bdf8; --info-soft: rgba(56,189,248,.12);
  --shadow: 0 1px 2px rgba(0,0,0,.3), 0 10px 28px rgba(0,0,0,.35);
}
* { box-sizing: border-box; }
html, body { background: var(--bg); }
body { margin: 0; color: var(--fg); font: 14px/1.55 Nunito, system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
main { padding: 26px 28px 56px; max-width: 1080px; margin: 0 auto; }
html[data-placement="card"], html[data-placement="card"] body { background: transparent; }
html[data-placement="card"] main { padding: 4px 12px 10px; }
a { color: inherit; }
svg.i { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
h1 { font-size: 23px; line-height: 1.2; font-weight: 800; letter-spacing: -.015em; margin: 0; }
h2 { font-size: 15px; line-height: 1.3; font-weight: 800; margin: 0; }
h3 { font-size: 12.5px; font-weight: 800; margin: 0 0 8px; color: var(--fg2); }
p { margin: 0; }
.muted { color: var(--fg2); } .small { font-size: 12.5px; } .err { color: var(--err); font-weight: 600; }
.mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.top { margin-bottom: 16px; }
.tabs { display: flex; gap: 2px; padding: 3px; background: var(--bg2); border-radius: 11px; margin: 0 0 18px; overflow-x: auto; scrollbar-width: none; }
.tabs button { display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; min-height: 36px; padding: 0 13px; border: 0; background: none; color: var(--fg2); border-radius: 9px; font: inherit; font-weight: 800; cursor: pointer; transition: color .15s, background .15s; }
.tabs button:hover { color: var(--fg); }
.tabs button.on { background: var(--surface); color: var(--fg); box-shadow: 0 1px 2px rgba(0,0,0,.14); }
.stack { display: flex; flex-direction: column; gap: 12px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; box-shadow: var(--shadow); }
.row { display: flex; align-items: center; gap: 12px; }
.row.wrap { flex-wrap: wrap; }
.grow { flex: 1 1 auto; min-width: 0; }
.between { justify-content: space-between; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.tile { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 11px; flex: none; background: var(--bg2); }
.tile svg.brand { width: 21px; height: 21px; }
.tile.azure { color: #0078d4; } .tile.jira { color: #0052cc; }
html.dark .tile.azure { color: #4aa8ee; } html.dark .tile.jira { color: #6a9bf4; }
.tile.soft { background: var(--accent-soft); color: var(--accent-text); }
.pill { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 800; white-space: nowrap; background: var(--bg2); color: var(--fg2); }
.pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.pill.plain::before { display: none; }
.pill.ok { background: var(--ok-soft); color: var(--ok); } .pill.warn { background: var(--warn-soft); color: var(--warn); }
.pill.bad { background: var(--err-soft); color: var(--err); } .pill.info { background: var(--info-soft); color: var(--info); }
.pill.run::before { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.facts { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: 12.5px; color: var(--fg2); }
.facts span { display: inline-flex; align-items: center; gap: 6px; }
.facts b { color: var(--fg); font-weight: 800; }
button.btn, a.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 36px; padding: 0 13px; font: inherit; font-weight: 800; font-size: 13px; border-radius: 9px; border: 1px solid var(--line2); background: var(--surface); color: var(--fg); cursor: pointer; text-decoration: none; transition: background .15s, filter .15s; white-space: nowrap; }
button.btn:hover, a.btn:hover { background: var(--bg2); }
button.btn:disabled { opacity: .5; cursor: default; }
button.pri { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
button.pri:hover { background: var(--accent); filter: brightness(.95); }
button.ghost { border-color: transparent; background: none; color: var(--fg2); }
button.ghost:hover { color: var(--fg); }
button.danger { border-color: transparent; background: none; color: var(--err); }
button.danger:hover { background: var(--err-soft); }
button.icon { width: 36px; padding: 0; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.divide { border-top: 1px solid var(--line); margin-top: 13px; padding-top: 11px; }
.empty { text-align: center; padding: 42px 20px; }
.empty .tile { margin: 0 auto 12px; width: 48px; height: 48px; }
.empty p { margin: 0 auto 14px; max-width: 46ch; color: var(--fg2); }
label.f { display: flex; flex-direction: column; gap: 5px; font-size: 13px; font-weight: 800; min-width: 0; }
label.f small { font-weight: 500; color: var(--fg2); font-size: 12.5px; }
label.check { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 13.5px; cursor: pointer; min-height: 28px; }
label.check input { accent-color: #c99700; width: 16px; height: 16px; }
input:not([type=checkbox]):not([type=radio]), select, textarea { font: inherit; font-weight: 600; font-size: 13.5px; color: inherit; background: var(--bg); border: 1px solid var(--line2); border-radius: 9px; padding: 8px 10px; min-height: 38px; width: 100%; transition: border-color .15s, box-shadow .15s; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.choice { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 9px; }
.choice button { display: flex; align-items: center; gap: 11px; padding: 11px 13px; border: 1px solid var(--line2); border-radius: 11px; background: var(--surface); color: var(--fg); font: inherit; font-weight: 800; cursor: pointer; text-align: left; transition: border-color .15s, background .15s; }
.choice button:hover { background: var(--bg); }
.choice button.on { border-color: var(--accent); background: var(--accent-soft); }
.choice small { display: block; font-weight: 500; font-size: 12.5px; color: var(--fg2); }
.section { padding: 15px 0 0; margin-top: 15px; border-top: 1px solid var(--line); }
.section .num { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 800; margin-right: 8px; }
.section > h2 { margin-bottom: 12px; display: flex; align-items: center; }
.map { display: grid; grid-template-columns: minmax(110px, 170px) minmax(0, 1fr); gap: 9px 12px; align-items: center; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: inherit; font-size: 12.5px; font-weight: 700; border: 1px solid var(--line2); background: none; color: var(--fg2); padding: 3px 11px; min-height: 28px; border-radius: 999px; cursor: pointer; transition: background .15s, color .15s; }
.chip:hover { color: var(--fg); }
.chip.on { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.list > * { border-top: 1px solid var(--line); }
.list > *:first-child { border-top: 0; }
.item { display: flex; align-items: center; gap: 12px; padding: 11px 0; min-width: 0; }
button.item { width: 100%; background: none; border-left: 0; border-right: 0; border-bottom: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
.list > button.item:hover .title { text-decoration: underline; }
.item .title { font-weight: 800; }
a.title { text-decoration: none; }
a.title:hover { text-decoration: underline; }
.log-row { display: flex; gap: 10px; padding: 8px 0; align-items: flex-start; font-size: 13px; }
.log-row svg { margin-top: 2px; color: var(--fg3); }
.log-row.error svg { color: var(--err); } .log-row.conflict svg { color: var(--warn); } .log-row.info svg { color: var(--ok); }
.crumb { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; font-weight: 700; color: var(--fg2); }
.crumb button { background: none; border: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; text-decoration: underline; }
.stage { padding: 11px 0; }
.stage-head { display: flex; align-items: center; gap: 10px; }
button[aria-expanded='true'] > svg.i:last-child { transform: rotate(90deg); }
.steps { margin: 9px 0 0 26px; display: flex; flex-direction: column; gap: 3px; }
.steps button { display: flex; align-items: center; gap: 8px; background: none; border: 0; padding: 3px 0; font: inherit; font-size: 13px; color: var(--fg2); cursor: pointer; text-align: left; }
.steps button:hover { color: var(--fg); text-decoration: underline; }
.dot { width: 18px; height: 18px; display: grid; place-items: center; flex: none; border-radius: 50%; }
.dot svg.i { width: 13px; height: 13px; stroke-width: 3; }
.dot.ok { background: var(--ok-soft); color: var(--ok); } .dot.bad { background: var(--err-soft); color: var(--err); }
.dot.warn { background: var(--warn-soft); color: var(--warn); } .dot.info { background: var(--info-soft); color: var(--info); }
.dot.idle { background: var(--bg2); color: var(--fg3); }
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
th { text-align: left; font-size: 12px; color: var(--fg2); font-weight: 700; padding: 6px 10px; }
td { padding: 8px 10px; border-top: 1px solid var(--line); vertical-align: middle; }
th:first-child, td:first-child { padding-left: 0; } th:last-child, td:last-child { padding-right: 0; }
td.value { max-width: 340px; overflow-wrap: anywhere; }
.secret { display: inline-flex; align-items: center; gap: 6px; color: var(--fg2); font-weight: 700; }
dialog { border: 1px solid var(--line2); border-radius: 15px; background: var(--surface); color: var(--fg); padding: 20px; width: min(460px, calc(100vw - 32px)); box-shadow: 0 24px 60px rgba(0,0,0,.35); }
dialog.wide { width: min(860px, calc(100vw - 32px)); }
dialog::backdrop { background: rgba(0,0,0,.45); }
dialog h2 { font-size: 16px; margin-bottom: 7px; }
dialog p { color: var(--fg2); margin-bottom: 14px; }
dialog form, dialog .form { display: flex; flex-direction: column; gap: 12px; }
dialog .foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
pre.log { margin: 0; max-height: 62vh; overflow: auto; background: #0e0f0f; color: #d7d8d8; border-radius: 10px; padding: 12px 14px; font: 12px/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.toolbar { display: flex; flex-wrap: wrap; gap: 9px; align-items: flex-end; margin-bottom: 14px; }
.toolbar label.f { flex: 0 1 220px; }
.toolbar label.f.wide { flex: 1 1 220px; }
html[data-placement="card"] .item { padding: 8px 0; }
@media (max-width: 620px) {
  main { padding: 16px 16px 40px; }
  .map { grid-template-columns: minmax(0, 1fr); gap: 3px; }
  .map strong { margin-top: 8px; }
  .hide-sm { display: none; }
  .toolbar label.f { flex: 1 1 100%; }
}
`;
