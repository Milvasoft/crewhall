import { setupServer } from 'msw/node';
import { handlers } from '@/mocks/handlers';

/** Same handlers as the browser mock: tests run against the contract-validated mock. */
export const server = setupServer(...handlers);
