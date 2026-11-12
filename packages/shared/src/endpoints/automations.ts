import { def, Empty, items, type EndpointDef } from '../endpoint-def';
import {
  AutomationCatalog,
  AutomationRule,
  AutomationRun,
  AutomationRunsQuery,
  CreateAutomationRule,
  UpdateAutomationRule,
} from '../schemas/automations';
import { page } from '../schemas/common';

/**
 * Automations module contract (roadmap 17). Only the automations session edits this file; see
 * docs/contracts/moduller.md. The incoming webhook is outside the table: AUTOMATION_RAW_PATHS.
 */
export const automationsEndpoints = {
  /** Triggers and actions the server knows, with their config fields and availability. */
  getAutomationCatalog: def({
    method: 'GET',
    path: '/api/v1/automations/catalog',
    auth: 'session',
    response: AutomationCatalog,
  }),
  listAutomationRules: def({
    method: 'GET',
    path: '/api/v1/spaces/:spaceId/automations',
    auth: 'session',
    response: items(AutomationRule),
  }),
  createAutomationRule: def({
    method: 'POST',
    path: '/api/v1/spaces/:spaceId/automations',
    auth: 'session',
    body: CreateAutomationRule,
    response: AutomationRule,
  }),
  getAutomationRule: def({
    method: 'GET',
    path: '/api/v1/automations/:ruleId',
    auth: 'session',
    response: AutomationRule,
  }),
  /** Saving with `enabled: true` also clears a failure stop. */
  updateAutomationRule: def({
    method: 'PATCH',
    path: '/api/v1/automations/:ruleId',
    auth: 'session',
    body: UpdateAutomationRule,
    response: AutomationRule,
  }),
  deleteAutomationRule: def({
    method: 'DELETE',
    path: '/api/v1/automations/:ruleId',
    auth: 'session',
    response: Empty,
  }),
  /** Runs the rule now with a sample event of its trigger ("Şimdi dene"). */
  testAutomationRule: def({
    method: 'POST',
    path: '/api/v1/automations/:ruleId/test',
    auth: 'session',
    response: AutomationRun,
  }),
  /** New incoming webhook URL; the old one stops working. */
  regenerateAutomationHook: def({
    method: 'POST',
    path: '/api/v1/automations/:ruleId/hook',
    auth: 'session',
    response: AutomationRule,
  }),
  listAutomationRuns: def({
    method: 'GET',
    path: '/api/v1/automations/:ruleId/runs',
    auth: 'session',
    query: AutomationRunsQuery,
    response: page(AutomationRun),
  }),
} as const satisfies Record<string, EndpointDef>;
