import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { expect, it } from 'vitest';
import { ErrorPage } from '@/components/common/ErrorPage';

it('renders the error page without the i18n provider', async () => {
  const rootRoute = createRootRoute({ component: () => <ErrorPage error={new Error('boom')} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(<RouterProvider router={router} />);
  expect(await screen.findByRole('heading', { name: 'Bir şeyler ters gitti' })).toBeInTheDocument();
});
