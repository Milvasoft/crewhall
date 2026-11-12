import { def, Empty, type EndpointDef } from '../endpoint-def';
import {
  ApplyTemplate,
  ApplyTemplateResult,
  CreateTemplate,
  Template,
  TemplateList,
  TemplateListQuery,
} from '../schemas/templates';

/**
 * Template gallery (roadmap 8): page, board and space templates. Core endpoints (no module
 * switch of their own): applying the page part needs the wiki module, the board part the
 * boards module; a part whose module is off is skipped and reported. `:templateRef` is a
 * built-in id (`builtin:board:sprint`) or a saved template's uuid.
 */
export const templateEndpoints = {
  listTemplates: def({
    method: 'GET',
    path: '/api/v1/templates',
    auth: 'session',
    query: TemplateListQuery,
    response: TemplateList,
  }),
  /** "Şablon olarak kaydet" for a page, a board or a whole space. */
  createTemplate: def({
    method: 'POST',
    path: '/api/v1/templates',
    auth: 'session',
    body: CreateTemplate,
    response: Template,
  }),
  deleteTemplate: def({
    method: 'DELETE',
    path: '/api/v1/templates/:templateRef',
    auth: 'session',
    response: Empty,
  }),
  /** Creates the template's content (a page, a board, or a space's pages and boards). */
  applyTemplate: def({
    method: 'POST',
    path: '/api/v1/templates/:templateRef/apply',
    auth: 'session',
    body: ApplyTemplate,
    response: ApplyTemplateResult,
  }),
} as const satisfies Record<string, EndpointDef>;
