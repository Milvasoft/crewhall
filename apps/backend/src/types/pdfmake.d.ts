/**
 * pdfmake 0.3 (server build): the module exports a ready instance. Only what the page export
 * uses is typed here; the community types describe the 0.2 API.
 */
declare module 'pdfmake' {
  interface FontFiles {
    normal: string;
    bold: string;
    italics: string;
    bolditalics: string;
  }
  interface OutputDocument {
    getBuffer(): Promise<Buffer>;
  }
  interface PdfMake {
    setFonts(fonts: Record<string, FontFiles>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    setLocalAccessPolicy(callback: (path: string) => boolean): void;
    createPdf(definition: Record<string, unknown>): OutputDocument;
  }
  const pdfmake: PdfMake;
  export default pdfmake;
}
