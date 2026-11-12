import { createFileRoute } from '@tanstack/react-router';
import { McpOverviewPage } from '@/components/mcp/Overview';

/** Connected client detail (design 18.5): the overview with the panel on the right. */
export const Route = createFileRoute('/_app/account/mcp/client/$grantId')({
  component: ClientRoute,
});

function ClientRoute() {
  const { grantId } = Route.useParams();
  return <McpOverviewPage grantId={grantId} />;
}
