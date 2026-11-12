import { createHash } from 'node:crypto';

/** Content tokens are stored as sha256; the plain token is shown once on rotation. */
export const hashTokenValue = (token: string) => createHash('sha256').update(token).digest('hex');
