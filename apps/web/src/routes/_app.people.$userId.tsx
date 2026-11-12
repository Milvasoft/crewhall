import { createFileRoute } from '@tanstack/react-router';
import { PersonProfile } from '@/components/chat/PersonProfile';

export const Route = createFileRoute('/_app/people/$userId')({
  component: function Person() {
    const { userId } = Route.useParams();
    return <PersonProfile key={userId} userId={userId} />;
  },
});
