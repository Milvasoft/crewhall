import { def, type EndpointDef } from '../endpoint-def';
import { PushDiagnostics, PushDiagnosticsQuery } from '../schemas/chat';
import {
  DeliverySettings,
  DeliveryTestResult,
  TestDelivery,
  UpdateDeliverySettings,
} from '../schemas/delivery';

/**
 * Yönetim › Bildirim gönderimi: the org's e-mail and push delivery (SMTP, FCM/Expo, Notifike).
 * All three need `org.update_settings` (owner, admin); updates and tests are audited.
 */
export const deliveryEndpoints = {
  /**
   * "Why didn't this person get a push?": their open sessions, devices, rows and the last
   * notifications with what each provider answered. `org.manage_members`.
   */
  getPushDiagnostics: def({
    method: 'GET',
    path: '/api/v1/org/members/:userId/push-diagnostics',
    auth: 'session',
    query: PushDiagnosticsQuery,
    response: PushDiagnostics,
  }),
  getDeliverySettings: def({
    method: 'GET',
    path: '/api/v1/org/delivery',
    auth: 'session',
    response: DeliverySettings,
  }),
  /** Partial update; secrets are audited only as "changed". */
  updateDeliverySettings: def({
    method: 'PATCH',
    path: '/api/v1/org/delivery',
    auth: 'session',
    body: UpdateDeliverySettings,
    response: DeliverySettings,
  }),
  /** Sends a test e-mail or push; the result is stored and shows on the settings page. */
  testDelivery: def({
    method: 'POST',
    path: '/api/v1/org/delivery/test',
    auth: 'session',
    body: TestDelivery,
    response: DeliveryTestResult,
  }),
} as const satisfies Record<string, EndpointDef>;
