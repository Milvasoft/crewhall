import { type ComplianceOverview, type EdiscoveryExport, type LegalHold } from '@crewhall/shared';
import { memberOf, MockApiError, requireUser, type Resolvers } from './core';
import { newId } from './db';
import type { MockState } from './seed';

/**
 * Yönetim › Uyumluluk in mock mode (roadmap 25): rules are kept in memory, exports are ready
 * at once with a placeholder download link.
 */
function state(s: MockState): ComplianceOverview {
  const holder = s as MockState & { compliance?: ComplianceOverview };
  holder.compliance ??= {
    policy: {
      retention: { chatDays: null, auditDays: 1825 },
      dlp: {
        rules: [
          { id: 'card', detector: 'card', name: 'Kart numarası', enabled: true, action: 'warn' },
          {
            id: 'tckn',
            detector: 'tckn',
            name: 'TC kimlik numarası',
            enabled: true,
            action: 'block',
          },
          { id: 'iban', detector: 'iban', name: 'IBAN', enabled: false, action: 'warn' },
        ],
      },
    },
    holds: [],
    exports: [],
  };
  return holder.compliance;
}

function requireAdmin(s: MockState) {
  const u = requireUser(s);
  const role = memberOf(s, u.id)?.role;
  if (role !== 'owner' && role !== 'admin') throw new MockApiError('forbidden');
  return u;
}

const summary = (u: { id: string; name: string; email: string; imageUrl: string | null }) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  imageUrl: u.imageUrl,
});

export const complianceResolvers: Resolvers<
  | 'getCompliance'
  | 'updateCompliancePolicy'
  | 'createLegalHold'
  | 'releaseLegalHold'
  | 'createEdiscoveryExport'
  | 'getEdiscoveryDownload'
> = {
  getCompliance: ({ s }) => {
    requireAdmin(s);
    return state(s);
  },
  updateCompliancePolicy: ({ s, body }) => {
    requireAdmin(s);
    state(s).policy = body;
    return state(s);
  },
  createLegalHold: ({ s, body }) => {
    const u = requireAdmin(s);
    const hold: LegalHold = {
      id: newId(),
      name: body.name,
      reason: body.reason ?? null,
      users: s.users.filter((x) => body.userIds.includes(x.id)).map(summary),
      spaces: s.spaces
        .filter((x) => body.spaceIds.includes(x.id))
        .map((x) => ({ id: x.id, name: x.name })),
      createdBy: summary(u),
      createdAt: new Date().toISOString(),
      releasedAt: null,
    };
    state(s).holds.unshift(hold);
    return hold;
  },
  releaseLegalHold: ({ s, params }) => {
    requireAdmin(s);
    const hold = state(s).holds.find((h) => h.id === params.holdId);
    if (!hold || hold.releasedAt) throw new MockApiError('not_found');
    hold.releasedAt = new Date().toISOString();
    return hold;
  },
  createEdiscoveryExport: ({ s, body }) => {
    const u = requireAdmin(s);
    const now = new Date();
    const item: EdiscoveryExport = {
      id: newId(),
      name: body.name,
      status: 'ready',
      scope: {
        userIds: body.scope.userIds,
        spaceIds: body.scope.spaceIds,
        from: body.scope.from,
        to: body.scope.to,
        include: body.scope.include,
      },
      sizeBytes: 4_200_000,
      counts: { chatMessages: 128, pages: 12, cards: 30 },
      error: null,
      requestedBy: summary(u),
      createdAt: now.toISOString(),
      finishedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
    };
    state(s).exports.unshift(item);
    return item;
  },
  getEdiscoveryDownload: ({ s, params }) => {
    requireAdmin(s);
    if (!state(s).exports.some((e) => e.id === params.exportId)) {
      throw new MockApiError('not_found');
    }
    return {
      url: 'https://example.com/ediscovery.zip',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  },
};
