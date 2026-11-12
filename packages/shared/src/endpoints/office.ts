import { def, type EndpointDef } from '../endpoint-def';
import { DriveNode } from '../schemas/drive';
import {
  CreateOfficeDocument,
  OfficeCapabilities,
  OfficeSession,
  OfficeSettings,
  OfficeTestResult,
  OpenOfficeSession,
  UpdateOfficeSettings,
} from '../schemas/office';

/**
 * Office module contract. The WOPI endpoints the document server calls (`/wopi/files/:id`,
 * CheckFileInfo, GetFile, PutFile, locks) are outside this table: they take the WOPI access
 * token, not a session. Settings need `org.update_settings`.
 */
export const officeEndpoints = {
  getOfficeSettings: def({
    method: 'GET',
    path: '/api/v1/office/settings',
    auth: 'session',
    response: OfficeSettings,
  }),
  updateOfficeSettings: def({
    method: 'PATCH',
    path: '/api/v1/office/settings',
    auth: 'session',
    body: UpdateOfficeSettings,
    response: OfficeSettings,
  }),
  /** Reads the server's WOPI discovery and stores the result as `lastTest`. */
  testOfficeSettings: def({
    method: 'POST',
    path: '/api/v1/office/settings/test',
    auth: 'session',
    response: OfficeTestResult,
  }),
  /** Whether Drive offers "Düzenle" for office files, and for which extensions. */
  getOfficeCapabilities: def({
    method: 'GET',
    path: '/api/v1/office/capabilities',
    auth: 'session',
    response: OfficeCapabilities,
  }),
  /** Editor URL and WOPI access token for a file (view rights; edit needs space.edit_content). */
  openOfficeSession: def({
    method: 'POST',
    path: '/api/v1/office/nodes/:nodeId/session',
    auth: 'session',
    body: OpenOfficeSession,
    response: OfficeSession,
  }),
  /** New empty document, spreadsheet or presentation in a folder (Drive › Yeni). */
  createOfficeDocument: def({
    method: 'POST',
    path: '/api/v1/office/documents',
    auth: 'session',
    body: CreateOfficeDocument,
    response: DriveNode,
  }),
} as const satisfies Record<string, EndpointDef>;
