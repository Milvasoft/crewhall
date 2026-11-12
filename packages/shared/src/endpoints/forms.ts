import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import {
  CreateForm,
  Form,
  FormExportResult,
  FormFile,
  FormFileUrl,
  FormResponse,
  FormResponsesQuery,
  FormStats,
  FormSummary,
  FormToFill,
  SubmitFormResponse,
  SubmitFormResult,
  UpdateForm,
  UploadFormFile,
} from '../schemas/forms';
import { page } from '../schemas/common';

/**
 * Forms module contract (roadmap 16). Only the forms session edits this file; see
 * docs/contracts/moduller.md. CSV download is outside the table: FORMS_RAW_PATHS.
 */
export const formsEndpoints = {
  // ---- Building (space editors) ------------------------------------------------------
  listForms: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/forms',
    auth: 'session',
    response: items(FormSummary),
  }),
  createForm: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/forms',
    auth: 'session',
    body: CreateForm,
    response: Form,
  }),
  getForm: def({
    method: 'GET',
    path: '/api/v1/forms/:formId',
    auth: 'session',
    response: Form,
  }),
  updateForm: def({
    method: 'PATCH',
    path: '/api/v1/forms/:formId',
    auth: 'session',
    body: UpdateForm,
    response: Form,
  }),
  /** Removes the form with its answers and uploaded files. */
  deleteForm: def({
    method: 'DELETE',
    path: '/api/v1/forms/:formId',
    auth: 'session',
    response: Empty,
  }),
  /** New public link; the old one stops working. */
  regenerateFormLink: def({
    method: 'POST',
    path: '/api/v1/forms/:formId/link',
    auth: 'session',
    response: Form,
  }),
  /** Writes the CSV table to Drive now (it is also refreshed after every answer). */
  exportFormToDrive: def({
    method: 'POST',
    path: '/api/v1/forms/:formId/drive-export',
    auth: 'session',
    response: FormExportResult,
  }),

  // ---- Results (space editors) -------------------------------------------------------
  listFormResponses: def({
    method: 'GET',
    path: '/api/v1/forms/:formId/responses',
    auth: 'session',
    query: FormResponsesQuery,
    response: page(FormResponse),
  }),
  getFormStats: def({
    method: 'GET',
    path: '/api/v1/forms/:formId/stats',
    auth: 'session',
    response: FormStats,
  }),
  deleteFormResponse: def({
    method: 'DELETE',
    path: '/api/v1/form-responses/:responseId',
    auth: 'session',
    response: Empty,
  }),
  getFormFileUrl: def({
    method: 'GET',
    path: '/api/v1/form-files/:fileId/url',
    auth: 'session',
    response: FormFileUrl,
  }),

  // ---- Answering inside the org ------------------------------------------------------
  getFormToFill: def({
    method: 'GET',
    path: '/api/v1/forms/:formId/fill',
    auth: 'session',
    response: FormToFill,
  }),
  submitForm: def({
    method: 'POST',
    path: '/api/v1/forms/:formId/responses',
    auth: 'session',
    body: SubmitFormResponse,
    response: SubmitFormResult,
  }),
  uploadFormFile: def({
    method: 'POST',
    path: '/api/v1/forms/:formId/files',
    auth: 'session',
    body: UploadFormFile,
    response: FormFile,
  }),

  // ---- Public link (rate limited) ----------------------------------------------------
  getPublicForm: def({
    method: 'GET',
    path: '/api/v1/public/forms/:token',
    auth: 'public',
    response: FormToFill,
  }),
  submitPublicForm: def({
    method: 'POST',
    path: '/api/v1/public/forms/:token/responses',
    auth: 'public',
    body: SubmitFormResponse,
    response: SubmitFormResult,
  }),
  uploadPublicFormFile: def({
    method: 'POST',
    path: '/api/v1/public/forms/:token/files',
    auth: 'public',
    body: UploadFormFile,
    response: FormFile,
  }),
} as const satisfies Record<string, EndpointDef>;
