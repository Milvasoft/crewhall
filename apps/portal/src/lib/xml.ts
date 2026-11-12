/** Drops characters XML 1.0 does not allow (C0 controls except tab/LF/CR, U+FFFE/FFFF). */
function xmlChars(value: string): string {
  let out = '';
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff) {
      continue;
    }
    out += ch;
  }
  return out;
}

export function escapeXml(value: string): string {
  return xmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function cdata(value: string): string {
  return `<![CDATA[${xmlChars(value).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}
