import { describe, expect, it } from 'vitest';
import { endpoints } from './endpoints';

describe('query schemas', () => {
  it.each(['listSpaces', 'listOrgSpaces'] as const)(
    '%s reads archived from query strings, "false" included',
    (name) => {
      const query = endpoints[name].query;
      expect(query.parse({ archived: 'false' })).toEqual({ archived: false });
      expect(query.parse({ archived: '0' })).toEqual({ archived: false });
      expect(query.parse({ archived: 'true' })).toEqual({ archived: true });
      expect(query.parse({})).toEqual({});
      expect(query.safeParse({ archived: 'maybe' }).success).toBe(false);
    },
  );
});
