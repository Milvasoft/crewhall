/**
 * Seeds the Milvasoft example tenant for development:
 *   pnpm --filter @crewhall/backend seed
 * Runs the real setup service, then adds people through invitations, so seeded data
 * looks exactly like data made through the UI. Does nothing if an org already exists.
 */
import { and, eq } from 'drizzle-orm';
import { organizations, spaceMembers, spaces, users } from '@crewhall/db';
import { createCredentialUser, enableTotpWithSecret } from '../auth/users';
import type { Deps } from '../deps';
import { loadEnv } from '../env';
import { build } from '../server';
import { primaryOrg } from '../services/brand';
import { acceptInvitation, invitationUrl, issueInvitation } from '../services/invitations';
import { runSetup } from '../services/setup';
import { seedChat } from './seed-chat';
import { seedQuickAccess } from './seed-quick';
import { seedBoards } from '../services/boards/seed';
import { seedWiki } from './seed-wiki';
import {
  SEED_BACKUP_CODES,
  SEED_ORG,
  SEED_PASSWORD,
  SEED_PENDING_INVITATION,
  SEED_SPACES,
  SEED_TOTP_SECRET,
  SEED_USERS,
} from './seed-data';

const req = { ip: null, userAgent: 'crewhall-seed', locale: 'tr' };

export async function seed(deps: Deps) {
  const { db, auth } = deps;
  if (await primaryOrg(db)) return { seeded: false as const };

  const [owner, ...rest] = SEED_USERS;
  if (!owner) throw new Error('seed has no owner');
  const result = await runSetup(
    deps,
    {
      setupToken: deps.setupToken ?? undefined,
      org: SEED_ORG,
      owner: { name: owner.name, email: owner.email, password: SEED_PASSWORD },
      spaces: SEED_SPACES,
    },
    req,
  );
  const [org] = await db.select().from(organizations).where(eq(organizations.id, result.orgId));
  const [ownerRow] = await db.select().from(users).where(eq(users.id, result.ownerId));
  if (!org || !ownerRow) throw new Error('setup did not create the org');
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, ownerRow.id));
  if (owner.totp) {
    await enableTotpWithSecret(auth, db, ownerRow.id, SEED_TOTP_SECRET, SEED_BACKUP_CODES);
  }

  const spaceRows = await db.select().from(spaces).where(eq(spaces.orgId, org.id));
  const spaceId = (name: string) => {
    const s = spaceRows.find((r) => r.kind === 'shared' && r.name === name);
    if (!s) throw new Error(`seed space ${name} missing`);
    return s.id;
  };

  for (const person of rest) {
    if (person.role === 'owner') continue;
    const { token } = await issueInvitation(
      db,
      org,
      ownerRow,
      { email: person.email, role: person.role, spaceIds: [] },
      req,
    );
    const user = await createCredentialUser(auth, {
      email: person.email,
      name: person.name,
      password: SEED_PASSWORD,
      locale: 'tr',
    });
    await db.transaction((tx) =>
      acceptInvitation(tx, token, user, null, req, { defaultSpaceRole: 'editor' }),
    );
    for (const s of person.spaces) {
      await db
        .insert(spaceMembers)
        .values({
          spaceId: spaceId(s.name),
          userId: user.id,
          orgId: org.id,
          role: s.role,
          addedBy: ownerRow.id,
        })
        .onConflictDoUpdate({
          target: [spaceMembers.spaceId, spaceMembers.userId],
          set: { role: s.role },
        });
    }
    if (person.totp) {
      await enableTotpWithSecret(auth, db, user.id, SEED_TOTP_SECRET, SEED_BACKUP_CODES);
    }
  }

  const pending = await issueInvitation(
    db,
    org,
    ownerRow,
    { ...SEED_PENDING_INVITATION, spaceIds: [spaceId('Dumpapp')] },
    req,
  );
  const ownerSpaces = await db
    .select({ id: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.userId, ownerRow.id), eq(spaceMembers.orgId, org.id)));

  return {
    seeded: true as const,
    orgId: org.id,
    spaces: ownerSpaces.length,
    pendingInvitationUrl: invitationUrl(deps.env.HUB_URL, pending.token),
  };
}

if (process.argv[1]?.replaceAll('\\', '/').match(/(scripts\/seed\.ts|dist\/seed\.js)$/)) {
  const env = loadEnv();
  const built = await build(
    { ...env, MIGRATE_ON_START: true, WORKER_IN_PROCESS: false },
    { jobs: 'inline' },
  );
  const { deps } = built;
  try {
    const out = await seed(deps);
    const quick = await seedQuickAccess(deps);
    if (quick) console.log('Added the quick access and Drive sample (phase 1).');
    if (await seedBoards(deps)) console.log('Added the boards and drawings sample (phase 7).');
    const chat = await seedChat(deps);
    if (chat) console.log(`Added the chat sample (phase 3); Seq webhook: ${chat.webhookUrl}`);
    if (await seedWiki(deps)) console.log('Added the wiki sample (phase 4).');
    if (!out.seeded) {
      console.log('An organization already exists; account seed skipped.');
    } else {
      console.log(`Seeded ${SEED_ORG.name} (${out.orgId}).`);
      console.log(`Password for every account: ${SEED_PASSWORD}`);
      for (const u of SEED_USERS) {
        console.log(
          `  ${u.role.padEnd(6)} ${u.email}${u.totp ? '  (TOTP: pnpm --filter @crewhall/backend totp)' : ''}`,
        );
      }
      console.log(
        `Pending invitation for ${SEED_PENDING_INVITATION.email}: ${out.pendingInvitationUrl}`,
      );
    }
  } finally {
    await built.close();
  }
}
