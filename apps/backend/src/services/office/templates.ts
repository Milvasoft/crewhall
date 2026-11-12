import { strToU8, zipSync, type Zippable } from 'fflate';
import type { OfficeDocumentKind } from '@crewhall/shared';
import { OOXML_TEMPLATES } from './templates-ooxml';

/**
 * Empty files for Drive › Yeni › Belge / Tablo / Sunum. OpenDocument files are built here (the
 * smallest valid package: mimetype first and uncompressed, manifest, content); the Office Open
 * XML ones are empty documents saved once by LibreOffice and kept as base64.
 */

const ODF: Record<OfficeDocumentKind, { ext: string; mime: string; body: string; ns: string }> = {
  document: {
    ext: 'odt',
    mime: 'application/vnd.oasis.opendocument.text',
    ns: 'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
    body: '<office:text><text:p/></office:text>',
  },
  spreadsheet: {
    ext: 'ods',
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    ns: 'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
    body: '<office:spreadsheet><table:table table:name="Sheet1"><table:table-row><table:table-cell/></table:table-row></table:table></office:spreadsheet>',
  },
  presentation: {
    ext: 'odp',
    mime: 'application/vnd.oasis.opendocument.presentation',
    ns: 'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
    body: '<office:presentation><draw:page draw:name="page1"/></office:presentation>',
  },
};

export const OOXML_TYPES: Record<OfficeDocumentKind, { ext: string; mime: string }> = {
  document: {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  spreadsheet: {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  presentation: {
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
};

export function odfTemplate(kind: OfficeDocumentKind): Uint8Array {
  const t = ODF[kind];
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">' +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="${t.mime}"/>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>';
  const content =
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ${t.ns} office:version="1.2">` +
    `<office:body>${t.body}</office:body></office:document-content>`;
  // Key order is entry order: the mimetype must come first, stored without compression.
  const files: Zippable = {
    mimetype: [strToU8(t.mime), { level: 0 }],
    'META-INF/manifest.xml': strToU8(manifest),
    'content.xml': strToU8(content),
  };
  return zipSync(files);
}

/** Bytes, extension and type of a new empty file. */
export function officeTemplate(kind: OfficeDocumentKind, format: 'ooxml' | 'odf') {
  if (format === 'odf') {
    return { bytes: odfTemplate(kind), ext: ODF[kind].ext, mime: ODF[kind].mime };
  }
  return {
    bytes: new Uint8Array(Buffer.from(OOXML_TEMPLATES[kind], 'base64')),
    ...OOXML_TYPES[kind],
  };
}
