/**
 * Address books of connected accounts (Microsoft Graph, later Exchange Web Services). The
 * provider owns the mirrored contact; these are the fields both sides know.
 */

export interface ExtContactFields {
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  company: string | null;
  jobTitle: string | null;
  emails: string[];
  workPhones: string[];
  homePhones: string[];
  mobilePhone: string | null;
  address: string | null;
  website: string | null;
  /** 'YYYY-MM-DD'. */
  birthday: string | null;
  notes: string | null;
  categories: string[];
}

export interface ExtContact extends ExtContactFields {
  id: string;
  /** Graph changeKey / EWS ChangeKey. */
  etag: string | null;
}

export interface ContactDelta {
  items: ExtContact[];
  /** Deleted at the provider since the last round. */
  removed: string[];
  /** Where the next round continues; null when there is nothing to continue from yet. */
  cursor: string | null;
  /** The listing holds everything: contacts it does not mention are gone. */
  full: boolean;
}

export interface ContactsClient {
  delta(cursor: string | null): Promise<ContactDelta>;
  get(id: string): Promise<ExtContact | null>;
  create(input: Partial<ExtContactFields>): Promise<ExtContact>;
  /** `ifMatch`: the version the write is based on; a newer one fails with status 412. */
  update(
    id: string,
    patch: Partial<ExtContactFields>,
    opts?: { ifMatch?: string },
  ): Promise<ExtContact>;
  remove(id: string): Promise<void>;
}

/** How many of each the provider has room for; the rest stays in Crewhall only. */
export const CONTACT_SLOTS = { emails: 3, workPhones: 2, homePhones: 2, mobile: 1 } as const;
