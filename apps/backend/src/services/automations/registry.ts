import type { DbOrTx } from '@crewhall/db';
import type {
  AutomationCatalogEntry,
  AutomationField,
  AutomationStep,
  ModuleKey,
} from '@crewhall/shared';
import type { z } from 'zod';
import type { Deps } from '../../deps';
import type { DriveActor } from '../drive/access';
import { enabledModules } from '../identity/modules';

/**
 * The automation registry (roadmap 17): trigger and action types are plugins. A module registers
 * its own at import time (see builtin.ts); the AI module adds an "AI step" action the same way,
 * with no contract change: the catalog endpoint describes each type and its config fields, and
 * the editor renders them generically.
 */

/** Something happened in a space; rules with this trigger type look at it. */
export interface AutomationEvent {
  orgId: string;
  spaceId: string;
  type: string;
  /** Shown to conditions and `{{…}}` templates; stored with the run (trimmed). */
  data: Record<string, unknown>;
  /** Only for trigger matching (ancestor folder ids…); not stored. */
  match?: Record<string, unknown>;
}

export interface TriggerDef<C = Record<string, unknown>> {
  type: string;
  /** Switchable module the trigger belongs to; null = core (Drive). */
  module: ModuleKey | null;
  /** A module that is not part of this build yet (calendar): listed, not selectable. */
  planned?: boolean;
  config: z.ZodType<C>;
  fields: AutomationField[];
  /** Event paths offered for conditions and templates. */
  variables: string[];
  /** Saving: the config's targets exist and the saver may see them. */
  validate?: (db: DbOrTx, a: DriveActor, spaceId: string, config: C) => Promise<void>;
  matches: (config: C, event: AutomationEvent) => boolean;
  /** Event data for "Şimdi dene". */
  sample: (config: C) => Record<string, unknown>;
}

export interface ActionContext {
  deps: Deps;
  /** The rule's owner: actions run with their rights. */
  actor: DriveActor;
  rule: { id: string; name: string; spaceId: string; signingSecret: string };
  run: { id: string; chain: string[]; depth: number };
  event: { type: string; data: Record<string, unknown> };
  /** Outputs of earlier steps by action id. */
  steps: Record<string, AutomationStep['output']>;
  /** `{{…}}` with the event data and `steps`. */
  render: (text: string) => string;
}

export interface ActionDef<C = Record<string, unknown>> {
  type: string;
  module: ModuleKey | null;
  config: z.ZodType<C>;
  fields: AutomationField[];
  validate?: (db: DbOrTx, a: DriveActor, spaceId: string, config: C) => Promise<void>;
  /** Throws AppError (or Error) to fail the step; returns small facts for the history. */
  run: (ctx: ActionContext, config: C) => Promise<AutomationStep['output']>;
}

const triggers = new Map<string, TriggerDef>();
const actions = new Map<string, ActionDef>();

export function registerTrigger<C>(def: TriggerDef<C>) {
  if (triggers.has(def.type)) throw new Error(`automation trigger ${def.type} registered twice`);
  triggers.set(def.type, def as unknown as TriggerDef);
}

export function registerAction<C>(def: ActionDef<C>) {
  if (actions.has(def.type)) throw new Error(`automation action ${def.type} registered twice`);
  actions.set(def.type, def as unknown as ActionDef);
}

export const triggerDef = (type: string) => triggers.get(type);
export const actionDef = (type: string) => actions.get(type);

function entry(
  def: Pick<TriggerDef, 'type' | 'module' | 'fields' | 'planned'>,
  enabled: ReadonlySet<string>,
  variables: string[],
): AutomationCatalogEntry {
  const off = def.module !== null && !enabled.has(def.module);
  return {
    type: def.type,
    module: def.module,
    available: !def.planned && !off,
    unavailableReason: def.planned ? 'module_missing' : off ? 'module_off' : null,
    fields: def.fields,
    variables,
  };
}

/** Everything registered, with availability for the org's module switches. */
export function catalog(settings: Parameters<typeof enabledModules>[0]) {
  const enabled = new Set<string>(enabledModules(settings));
  return {
    triggers: [...triggers.values()].map((d) => entry(d, enabled, d.variables)),
    actions: [...actions.values()].map((d) => entry(d, enabled, [])),
  };
}
