import { strings } from '@/i18n';

/** Small dark bar shown only in draft mode (Hub "Önizle"). A plain link: never prefetched. */
export function PreviewBar({ locale }: { locale: string }) {
  const s = strings(locale);
  return (
    <div className="portal-preview-bar" role="status">
      <span>{s.previewBar}</span>
      <a href="/api/preview/exit">{s.previewExit}</a>
    </div>
  );
}
