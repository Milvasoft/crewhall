import { paths, withQuery, type AiSearchHit } from '@crewhall/shared';

/** The web path of a search result or assistant source; null when it has no page of its own. */
export function hitPath(hit: AiSearchHit, spaceSlug: (spaceId: string) => string | undefined) {
  if (hit.path) return hit.path;
  switch (hit.kind) {
    case 'page':
      return hit.nodeId ? paths.page(hit.nodeId) : null;
    case 'board':
      return hit.nodeId ? paths.board(hit.nodeId) : null;
    case 'drawing':
      return hit.nodeId ? paths.drawing(hit.nodeId) : null;
    case 'card':
      return hit.boardId && hit.cardNumber !== null
        ? paths.boardCard(hit.boardId, String(hit.cardNumber))
        : null;
    case 'message':
      return hit.conversationId
        ? withQuery(paths.chatConversation(hit.conversationId), { seq: hit.seq || undefined })
        : null;
    case 'folder': {
      const slug = hit.spaceId ? spaceSlug(hit.spaceId) : undefined;
      return slug && hit.nodeId ? paths.driveFolder(slug, hit.nodeId) : null;
    }
    case 'file': {
      const slug = hit.spaceId ? spaceSlug(hit.spaceId) : undefined;
      return slug && hit.nodeId ? withQuery(paths.driveSpace(slug), { preview: hit.nodeId }) : null;
    }
    default:
      return null;
  }
}
