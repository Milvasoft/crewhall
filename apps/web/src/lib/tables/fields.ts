import {
  type CellValue,
  type ChoiceColor,
  type FilterOp,
  type TableField,
  type TableFieldType,
  type TableView,
} from '@crewhall/shared';
import { type IconName } from '@crewhall/ui';
import { newId } from '@/lib/ids';

/** Field types in menu order with their icons. */
export const FIELD_TYPES: { type: TableFieldType; icon: IconName }[] = [
  { type: 'text', icon: 'text' },
  { type: 'long_text', icon: 'note' },
  { type: 'number', icon: 'numbers' },
  { type: 'currency', icon: 'tag' },
  { type: 'date', icon: 'calendar' },
  { type: 'single_select', icon: 'checkC' },
  { type: 'multi_select', icon: 'todo' },
  { type: 'person', icon: 'user' },
  { type: 'attachment', icon: 'clip' },
  { type: 'checkbox', icon: 'check' },
  { type: 'url', icon: 'link' },
  { type: 'email', icon: 'mail' },
  { type: 'phone', icon: 'phone' },
  { type: 'rating', icon: 'star' },
  { type: 'relation', icon: 'layers' },
  { type: 'lookup', icon: 'search' },
  { type: 'rollup', icon: 'sliders' },
  { type: 'formula', icon: 'code' },
  { type: 'created_at', icon: 'clock' },
  { type: 'updated_at', icon: 'history' },
];

export const fieldIcon = (type: TableFieldType): IconName =>
  FIELD_TYPES.find((f) => f.type === type)?.icon ?? 'text';

/** Choice chip colors as theme-friendly classes. */
export const CHOICE_CLASS: Record<ChoiceColor, string> = {
  gray: 'bg-bg2 text-fg',
  yellow: 'bg-[#FBC419]/25 text-fg',
  orange: 'bg-[#F38424]/20 text-fg',
  red: 'bg-danger/15 text-fg',
  pink: 'bg-[#E0559E]/18 text-fg',
  purple: 'bg-[#8B5CF6]/18 text-fg',
  blue: 'bg-info/18 text-fg',
  teal: 'bg-[#14B8A6]/18 text-fg',
  green: 'bg-success/18 text-fg',
};

export const CHOICE_COLORS: ChoiceColor[] = ['blue', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'teal', 'gray'];

export const newChoiceId = () => `c_${newId().replace(/-/g, '').slice(0, 8)}`;

/** Filter operators that make sense for a field type. */
export function opsFor(type: TableFieldType): FilterOp[] {
  switch (type) {
    case 'number':
    case 'currency':
    case 'rating':
    case 'rollup':
      return ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'is_not_empty'];
    case 'date':
    case 'created_at':
    case 'updated_at':
      return ['is', 'is_before', 'is_after', 'is_empty', 'is_not_empty'];
    case 'single_select':
      return ['is', 'is_not', 'has_any', 'has_none', 'is_empty', 'is_not_empty'];
    case 'multi_select':
    case 'person':
    case 'relation':
      return ['has_any', 'has_all', 'has_none', 'is_empty', 'is_not_empty'];
    case 'checkbox':
      return ['is_checked', 'is_unchecked'];
    case 'attachment':
      return ['is_empty', 'is_not_empty'];
    default:
      return ['contains', 'not_contains', 'is', 'is_not', 'starts_with', 'is_empty', 'is_not_empty'];
  }
}

export const opNeedsValue = (op: FilterOp) =>
  !['is_empty', 'is_not_empty', 'is_checked', 'is_unchecked'].includes(op);

/** Fields of a view in its order, hidden ones left out unless asked. */
export function viewFields(fields: TableField[], view: TableView | undefined, withHidden = false) {
  const order = view?.config.order ?? [];
  const sorted = [
    ...fields.filter((f) => f.primary),
    ...order.map((id) => fields.find((f) => f.id === id && !f.primary)).filter((f): f is TableField => !!f),
    ...fields.filter((f) => !f.primary && !order.includes(f.id)),
  ];
  const hidden = new Set(view?.config.hidden ?? []);
  return withHidden ? sorted : sorted.filter((f) => f.primary || !hidden.has(f.id));
}

/** Number / currency text in the reader's language. */
export function formatNumber(field: TableField, v: CellValue | undefined, locale: string) {
  if (typeof v !== 'number') return '';
  const digits = field.options.precision ?? (field.type === 'currency' ? 2 : undefined);
  const opts: Intl.NumberFormatOptions =
    field.type === 'currency'
      ? { style: 'currency', currency: field.options.currency ?? 'TRY', minimumFractionDigits: digits, maximumFractionDigits: digits }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits ?? 6 };
  try {
    return new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'tr-TR', opts).format(v);
  } catch {
    return String(v);
  }
}

export const isEmptyCell = (v: CellValue | undefined) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
