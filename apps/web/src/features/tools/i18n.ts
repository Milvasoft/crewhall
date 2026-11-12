import { useMemo } from 'react';
import { useI18n, type WebKey } from '@/lib/i18n/I18nContext';
import { type ToolCategoryId, type ToolDefinition } from './lib/tool-sdk';

/**
 * Crewhall's texts for the copied tools. The copied definitions keep their English name,
 * description and keywords (the registry stays as it was); every screen shows the localized
 * ones from `tools.items.<id>` (packages/i18n web/tools/<category>.json).
 */

/** Key of a tool's own message: `tools.items.<toolId>.<name>`. */
export function toolKey(toolId: string, name: string): WebKey {
  return `tools.items.${toolId}.${name}` as WebKey;
}

export function categoryKey(id: ToolCategoryId, field: 'name' | 'description'): WebKey {
  return `tools.categories.${id}.${field}` as WebKey;
}

export interface LocalizedTool extends ToolDefinition {
  /** The English name from the copied definition, kept for search. */
  sourceName: string;
}

/** A definition with the name and description in the current language; keywords in both. */
export function useLocalizedTool() {
  const { t } = useI18n();
  return useMemo(
    () =>
      (def: ToolDefinition): LocalizedTool => {
        const extra = t(toolKey(def.id, 'keywords'))
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean);
        return {
          ...def,
          sourceName: def.name,
          name: t(toolKey(def.id, 'name')),
          description: t(toolKey(def.id, 'description')),
          keywords: [...def.keywords, def.name, ...extra],
        };
      },
    [t],
  );
}
