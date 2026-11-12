/**
 * @crewhall/portal-import: reads a Docusaurus 3 site into an `ImportBundle` that the backend
 * importer writes into a portal site as drafts (design 10.15 / 10.16, doc 17 §9).
 */
export type {
  ImportAuthor,
  ImportBundle,
  ImportCategory,
  ImportDoc,
  ImportEntry,
  ImportMedia,
  ImportPost,
  ImportVersion,
} from './bundle';
export { parseDocusaurus, type ParseOptions } from './parse';
export { compareUrls, normalizeUrl } from './parse/urls';
