import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './index';

describe('schema', () => {
  it('builds ltree labels from node ids', () => {
    expect(schema.nodeLabel('0192f3a4-1b2c-7d3e-8f40-123456789abc')).toBe(
      '0192f3a41b2c7d3e8f40123456789abc',
    );
  });

  it('generates time-ordered uuid v7 ids', () => {
    const a = schema.newId();
    const b = schema.newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });

  it('puts org_id on every tenant table', () => {
    const tenantTables = [
      schema.orgThemes,
      schema.orgMembers,
      schema.invitations,
      schema.auditLogs,
      schema.spaces,
      schema.spaceMembers,
      schema.nodes,
      schema.blobs,
      schema.blobDerivatives,
      schema.nodeVersions,
      schema.uploads,
      schema.shares,
      schema.nodeUserState,
      schema.surfaces,
      schema.surfaceCards,
      schema.links,
      schema.linkChecks,
      schema.linkOpens,
      schema.conversations,
      schema.conversationMembers,
      schema.readStates,
      schema.messages,
      schema.messageAttachments,
      schema.reactions,
      schema.mentions,
      schema.incomingWebhooks,
      schema.webhookDeliveries,
      schema.notifications,
      schema.notificationPrefs,
      schema.chatUserSettings,
      schema.pushDevices,
      schema.pushTickets,
      schema.wsTickets,
      schema.mediaAssets,
      schema.deliverySettings,
      schema.forms,
      schema.formResponses,
      schema.formFiles,
      schema.activityDaily,
      schema.orgStatsDaily,
      schema.vaultPolicies,
      schema.vaultShares,
      schema.automationRules,
      schema.automationRuns,
      schema.dataTables,
      schema.tableFields,
      schema.tableViews,
      schema.tableRows,
      schema.tableRowComments,
      schema.tableRowHistory,
      schema.mailSettings,
      schema.mailAccounts,
      schema.mailOauthStates,
      schema.mailRecentRecipients,
      schema.mailBulkJobs,
      schema.mailHeaders,
      schema.mailFolderState,
    ];
    for (const table of tenantTables) {
      const cols = getTableConfig(table).columns.map((c) => c.name);
      expect(cols, getTableConfig(table).name).toContain('org_id');
    }
  });
});
