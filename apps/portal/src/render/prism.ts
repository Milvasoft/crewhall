import { Prism, normalizeTokens, themes, type PrismTheme, type Token } from 'prism-react-renderer';

/**
 * Syntax highlighting with the Prism instance of prism-react-renderer (the one Docusaurus uses).
 * Tokens are rendered with class names only; both light and dark theme colours come from CSS
 * scoped by `[data-theme]`, so switching themes never re-renders code blocks.
 *
 * prism-react-renderer ships a subset of Prism languages. The languages the old site added
 * (`additionalLanguages`: csharp, bash, powershell, docker, diff) are defined below as compact
 * grammars derived from Prism's (MIT) definitions.
 */

type Grammar = NonNullable<(typeof Prism.languages)[string]>;

const BASH_COMMANDS =
  'docker|docker-compose|curl|wget|git|npm|npx|pnpm|yarn|node|dotnet|kubectl|helm|sudo|apt|apt-get|brew|cd|ls|cat|echo|export|mkdir|rm|cp|mv|chmod|chown|grep|sed|awk|tar|ssh|scp|source|make|python|python3|pip|pwsh|systemctl|journalctl|tail|head|touch|env|which|psql|redis-cli|openssl|unzip|zip|ping|ps|kill|set|unset|alias|read|printf|test|exit|eval|exec|trap|wait|xargs|find|sort|uniq|wc|tee|less|nc|dig|java|mvn|gradle|go|cargo|watch|time|sleep|history|man|nslookup|ip';

function defineLanguages() {
  const L = Prism.languages;
  if (L.csharp) return;

  L.csharp = {
    comment: [
      { pattern: /(^|[^\\])\/\*[\s\S]*?(?:\*\/|$)/, lookbehind: true, greedy: true },
      { pattern: /(^|[^\\:])\/\/.*/, lookbehind: true, greedy: true },
    ],
    string: [
      { pattern: /\$?@"(?:""|[^"])*"(?!")/, greedy: true },
      { pattern: /\$?"(?:\\.|[^\\"\r\n])*"/, greedy: true },
      { pattern: /'(?:[^\r\n'\\]|\\.|\\[Uux][\da-fA-F]{1,8})'/, greedy: true },
    ],
    keyword:
      /\b(?:abstract|add|alias|as|ascending|async|await|base|bool|break|by|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|descending|do|double|dynamic|else|enum|equals|event|explicit|extern|false|file|finally|fixed|float|for|foreach|from|get|global|goto|group|if|implicit|in|init|int|interface|internal|into|is|join|let|lock|long|managed|nameof|namespace|new|notnull|null|object|on|operator|orderby|out|override|params|partial|private|protected|public|readonly|record|ref|remove|required|return|sbyte|scoped|sealed|select|set|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unmanaged|unsafe|ushort|using|value|var|virtual|void|volatile|when|where|while|with|yield)\b/,
    'class-name': [
      {
        pattern:
          /(\b(?:class|enum|interface|record|struct|new|is|as|typeof|throw|catch|where|nameof|default)\s+)(?:@?[A-Z_]\w*)(?:\.@?[A-Z_]\w*)*/,
        lookbehind: true,
      },
      { pattern: /\b[A-Z]\w*(?=\s*<[^<>()]*>)/ },
      { pattern: /\b[A-Z]\w*(?=\s+@?[a-z_]\w*\s*(?:[=;,)]|=>|\{))/ },
      { pattern: /(\(\s*)[A-Z]\w*(?=\s*\))/, lookbehind: true },
    ],
    function: /\b@?\w+(?=\s*(?:<[^<>()]*>)?\s*\()/,
    number:
      /(?:\b0(?:x[\da-f_]*[\da-f]|b[01_]*[01])|(?:\B\.\d+(?:_+\d+)*|\b\d+(?:_+\d+)*(?:\.\d+(?:_+\d+)*)?)(?:e[-+]?\d+(?:_+\d+)*)?)(?:[dflmu]|lu|ul)?\b/i,
    operator: />>=?|<<=?|[-=]>|([-+&|])\1|~|\?\?=?|[-+*/%&|^!=<>]=?/,
    punctuation: /\?\.?|::|[{}[\];(),.:]/,
  } as Grammar;

  const variable = /\$\{[^}]+\}|\$\(\([\s\S]+?\)\)|\$\w+|\$[?!#*@$0-9-]/;
  L.bash = {
    shebang: { pattern: /^#!\s*\/.*/, alias: 'important' },
    comment: { pattern: /(^|[^"{\\$])#.*/, lookbehind: true },
    parameter: {
      pattern: /(^|\s)-{1,2}(?:\w+:[+-]?)?\w+(?:\.\w+)*(?=[=\s]|$)/m,
      lookbehind: true,
      alias: 'variable',
    },
    string: [
      {
        pattern: /"(?:\\[\s\S]|\$\([^)]+\)|\$(?!\()|`[^`]+`|[^"\\`$])*"/,
        greedy: true,
        inside: { variable },
      },
      { pattern: /'[^']*'/, greedy: true },
    ],
    variable,
    function: {
      pattern: new RegExp(`(^|[\\s;|&(])(?:${BASH_COMMANDS})(?=$|[)\\s;|&])`, 'm'),
      lookbehind: true,
    },
    keyword: {
      pattern:
        /(^|[\s;|&(])(?:case|do|done|elif|else|esac|fi|for|function|if|in|select|then|until|while)(?=$|[)\s;|&])/m,
      lookbehind: true,
    },
    boolean: { pattern: /(^|[\s;|&(])(?:false|true)(?=$|[)\s;|&])/m, lookbehind: true },
    operator: /\d?<>|>\||\+=|=[=~]?|!=?|<<[<-]?|[&\d]?>>|\d[<>]&?|[<>][&=]?|&[>&]?|\|[&|]?/,
    punctuation: /\$?\(\(?|\)\)?|\.\.|[{}[\];\\]/,
    number: { pattern: /(^|\s)(?:[1-9]\d*|0)(?:[.,]\d+)?\b/, lookbehind: true },
  } as Grammar;

  L.powershell = {
    comment: [
      { pattern: /(^|[^`])<#[\s\S]*?#>/, lookbehind: true },
      { pattern: /(^|[^`])#.*/, lookbehind: true },
    ],
    string: [
      { pattern: /"(?:`[\s\S]|[^`"])*"/, greedy: true, inside: { variable: /\$\w+/ } },
      { pattern: /'(?:[^']|'')*'/, greedy: true },
    ],
    namespace: /\[[a-z](?:\[(?:\[[^\]]*\]|[^[\]])*\]|[^[\]])*\]/i,
    boolean: /\$(?:false|true)\b/i,
    variable: /\$\w+\b/,
    function: [
      /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/,
      /\b(?:cat|cd|clear|cls|copy|cp|del|dir|echo|erase|gc|gci|iex|irm|iwr|kill|ls|mkdir|move|mv|ps|pwd|rm|rmdir|sleep|sort|start|tee|type|write)\b/i,
    ],
    keyword:
      /\b(?:Begin|Break|Catch|Class|Continue|Data|Define|Do|DynamicParam|Else|ElseIf|End|Exit|Filter|Finally|For|ForEach|From|Function|If|InlineScript|Parallel|Param|Process|Return|Sequence|Switch|Throw|Trap|Try|Until|Using|Var|While|Workflow)\b/i,
    operator: {
      pattern:
        /(^|\W)(?:!|-(?:b?(?:and|x?or)|as|(?:not)?(?:contains|in|like|match)|eq|ge|gt|is(?:not)?|join|le|lt|ne|not|replace|sh[lr])\b|-[-=]?|\+[+=]?|[*/%]=?)/i,
      lookbehind: true,
    },
    punctuation: /[|{}[\];(),.]/,
  } as Grammar;

  L.docker = {
    comment: { pattern: /(^[ \t]*)#.*/m, lookbehind: true, greedy: true },
    string: {
      pattern: /"(?:[^"\\\r\n]|\\(?:\r\n|[\s\S]))*"|'(?:[^'\\\r\n]|\\(?:\r\n|[\s\S]))*'/,
      greedy: true,
    },
    keyword: [
      {
        pattern:
          /(^[ \t]*)(?:ADD|ARG|CMD|COPY|ENTRYPOINT|ENV|EXPOSE|FROM|HEALTHCHECK|LABEL|MAINTAINER|ONBUILD|RUN|SHELL|STOPSIGNAL|USER|VOLUME|WORKDIR)(?=\s)/im,
        lookbehind: true,
      },
      { pattern: /(\s)AS(?=\s)/i, lookbehind: true },
    ],
    variable: /\$(?:\w+|\{[^{}"'\\]*\})/,
    operator: /\\$/m,
    punctuation: /[[\],]/,
  } as Grammar;

  L.diff = {
    coord: [/^(?:\*{3}|-{3}|\+{3}).*$/m, /^@@.*@@$/m, /^\d.*$/m],
    deleted: /^[-<].*$/m,
    inserted: /^[+>].*$/m,
  } as Grammar;
}

defineLanguages();

const ALIASES: Record<string, string> = {
  cs: 'csharp',
  'c#': 'csharp',
  dotnet: 'csharp',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  terminal: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  ps: 'powershell',
  dockerfile: 'docker',
  yml: 'yaml',
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  md: 'markdown',
  json5: 'json',
  jsonc: 'json',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
};

/** Prism grammar name for a fence language, or null for plain text. */
export function grammarName(language: string | null | undefined): string | null {
  if (!language) return null;
  const lang = language.toLowerCase();
  const name = ALIASES[lang] ?? lang;
  return Prism.languages[name] ? name : null;
}

/** Lines of tokens, as prism-react-renderer's `Highlight` produces them. */
export function highlight(code: string, language: string | null | undefined): Token[][] {
  const name = grammarName(language);
  const grammar = name ? Prism.languages[name] : undefined;
  if (!grammar) {
    return code
      .split('\n')
      .map((line) => [{ types: ['plain'], content: line, empty: line === '' }]);
  }
  return normalizeTokens(Prism.tokenize(code, grammar));
}

/** Docusaurus theme names → prism-react-renderer themes. */
export function prismTheme(
  name: string | null | undefined,
  fallback: 'github' | 'dracula',
): PrismTheme {
  const all = themes as unknown as Record<string, PrismTheme>;
  return (name && all[name]) || all[fallback]!;
}

function declarations(style: PrismTheme['plain']): string {
  const map: Record<string, string | number | undefined> = {
    color: style.color,
    'background-color': style.backgroundColor ?? style.background,
    'font-style': style.fontStyle,
    'font-weight': style.fontWeight,
    'text-decoration-line': style.textDecorationLine,
    opacity: style.opacity,
  };
  return Object.entries(map)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}:${String(v).replace(/[;{}<>]/g, '')}`)
    .join(';');
}

/** CSS for both colour modes; token classes are what the code block renders. */
export function prismThemeCss(light: PrismTheme, dark: PrismTheme): string {
  const block = (mode: 'light' | 'dark', theme: PrismTheme) => {
    const scope = `[data-theme='${mode}']`;
    const out = [
      `${scope} .theme-code-block{--prism-color:${theme.plain.color ?? 'inherit'};--prism-background-color:${
        theme.plain.backgroundColor ?? theme.plain.background ?? 'transparent'
      }}`,
    ];
    for (const entry of theme.styles) {
      const decl = declarations(entry.style);
      if (!decl) continue;
      const langs = entry.languages?.length ? entry.languages : [null];
      const selectors = langs.flatMap((lang) =>
        entry.types.map(
          (type) =>
            `${scope} ${lang ? `.language-${lang} ` : ''}.token.${type.replace(/[^\w-]/g, '')}`,
        ),
      );
      out.push(`${selectors.join(',')}{${decl}}`);
    }
    return out.join('\n');
  };
  return `${block('light', light)}\n${block('dark', dark)}`;
}
