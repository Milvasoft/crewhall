import { createFileRoute } from '@tanstack/react-router';
import { PostEditorScreen } from '@/components/portal/blog/PostEditor';

/** 10.7 post editor. */
export const Route = createFileRoute('/_app/portal/$siteSlug/blog/$postId')({
  component: PostEditorScreen,
});
