import { def, items, type EndpointDef } from '../endpoint-def';
import { CardMoveTarget, Link, ResolveLink } from '../schemas/quick';

/**
 * Quick access additions after phase 1 (the phase 1 table is in endpoints.ts): kept apart so
 * clients add them at their own pace.
 */
export const quickEndpoints = {
  /**
   * Creates or finds the org-wide Link for a URL (title and favicon fetched once), so a link card
   * can change its address in place with updateCard.
   */
  resolveLink: def({
    method: 'POST',
    path: '/api/v1/links',
    auth: 'session',
    body: ResolveLink,
    response: Link,
  }),
  /**
   * Surfaces the caller may move this card to, with who there cannot open its content. A vault
   * card only ever goes to the caller's own surface: from there the list is empty.
   */
  listCardMoveTargets: def({
    method: 'GET',
    path: '/api/v1/cards/:cardId/move-targets',
    auth: 'session',
    response: items(CardMoveTarget),
  }),
} as const satisfies Record<string, EndpointDef>;
