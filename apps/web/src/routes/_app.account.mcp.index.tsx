import { createFileRoute } from '@tanstack/react-router';
import { McpOverviewPage } from '@/components/mcp/Overview';

/** Hesabım › MCP ve API (design 18.1). */
export const Route = createFileRoute('/_app/account/mcp/')({
  component: () => <McpOverviewPage />,
});
