import { describe, expect, it } from 'vitest';
import { can } from '../permissions';
import {
  FormField,
  answerText,
  checkAnswers,
  formDefinitionIssues,
  isFieldVisible,
  ratingScale,
  type FormFieldInput,
} from './forms';

const field = (f: FormFieldInput) => FormField.parse(f);

const choice = field({
  id: 'team',
  type: 'single_choice',
  label: 'Ekip',
  required: true,
  choices: [
    { id: 'web', label: 'Web' },
    { id: 'api', label: 'API' },
  ],
});
const detail = field({
  id: 'detail',
  type: 'short_text',
  label: 'Ayrıntı',
  required: true,
  showIf: { fieldId: 'team', op: 'equals', value: 'api' },
});
const deeper = field({
  id: 'deeper',
  type: 'number',
  label: 'Sayı',
  showIf: { fieldId: 'detail', op: 'answered' },
});
const tags = field({
  id: 'tags',
  type: 'multi_choice',
  label: 'Etiketler',
  choices: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
});

describe('form answers', () => {
  const fields = [choice, detail, deeper, tags];

  it('shows conditional fields only when the condition holds, chained', () => {
    expect(isFieldVisible(detail, { team: 'web' }, fields)).toBe(false);
    expect(isFieldVisible(detail, { team: 'api' }, fields)).toBe(true);
    // deeper depends on detail, which is hidden while team is web.
    expect(isFieldVisible(deeper, { team: 'web', detail: 'x' }, fields)).toBe(false);
    expect(isFieldVisible(deeper, { team: 'api', detail: 'x' }, fields)).toBe(true);
  });

  it('drops hidden answers and reports field errors', () => {
    expect(checkAnswers(fields, { team: 'web', detail: 'gizli', deeper: 3 })).toEqual({
      clean: { team: 'web' },
      errors: {},
    });
    expect(checkAnswers(fields, { team: 'api', tags: ['c'] }).errors).toEqual({
      detail: 'required',
      tags: 'unknown_choice',
    });
    expect(
      checkAnswers([field({ id: 'd', type: 'date', label: 'T' })], { d: '2026-02-30' }).errors,
    ).toEqual({
      d: 'invalid',
    });
    const rating = field({ id: 'r', type: 'rating', label: 'P', max: 7 });
    expect(ratingScale(rating)).toBe(7);
    expect(checkAnswers([rating], { r: 8 }).errors).toEqual({ r: 'too_large' });
    expect(checkAnswers([rating], { r: 7 }).errors).toEqual({});
  });

  it('finds definition problems the schema cannot', () => {
    expect(formDefinitionIssues([choice, choice])).toEqual(['fields.1.id: duplicate']);
    expect(formDefinitionIssues([detail, choice])).toEqual([
      'fields.0.showIf: must point to an earlier field',
    ]);
    expect(formDefinitionIssues([field({ id: 'x', type: 'multi_choice', label: 'X' })])).toEqual([
      'fields.0.choices: empty',
    ]);
  });

  it('renders answers as text with choice labels', () => {
    expect(answerText(choice, 'api')).toBe('API');
    expect(answerText(tags, ['a', 'b'])).toBe('A, B');
    expect(answerText(detail, null)).toBe('');
  });

  it('lets members (not guests) answer org forms and editors build them', () => {
    const org = { settings: { membersCanCreateSpaces: true, publicLinksEnabled: true } };
    const actor = (orgRole: 'member' | 'guest') => ({ userId: 'u', orgRole, orgPermissions: [] });
    expect(can(actor('member'), 'forms.respond', { type: 'org', org })).toBe(true);
    expect(can(actor('guest'), 'forms.respond', { type: 'org', org })).toBe(false);
    expect(can(actor('member'), 'forms.manage', { type: 'space', org, myRole: 'editor' })).toBe(
      true,
    );
    expect(can(actor('member'), 'forms.manage', { type: 'space', org, myRole: 'viewer' })).toBe(
      false,
    );
  });
});
