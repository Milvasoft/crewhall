import { createFileRoute } from '@tanstack/react-router';
import { RulePage } from '@/components/automations/AutomationPages';

/** An automation rule: editor and run history. */
export const Route = createFileRoute('/_app/automations/rule/$ruleId')({
  component: function RuleRoute() {
    const { ruleId } = Route.useParams();
    return <RulePage ruleId={ruleId} />;
  },
});
