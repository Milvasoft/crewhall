// jsdom ships without types and @types/jsdom is not installed; the tests only need DOMParser.
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string);
    readonly window: Window & typeof globalThis;
  }
}
