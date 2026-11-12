import { pagePath } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Icon,
  toast,
} from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { SaveTemplateBody } from '@/components/templates/SaveTemplate';
import { TemplateGallery } from '@/components/templates/TemplateGallery';
import { invalidateDrive } from '@/features/drive/api';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { wikiKeys } from '@/lib/wiki/api';
import { AssetIndex, rewriteAttachments } from '@/lib/wiki/importAssets';
import { attachmentUploader, pagesToImport, readPackage } from '@/lib/wiki/importPackage';
import { openWikiDialog, useWikiDialog } from './dialogs';
import { ExportBody } from './ExportDialog';
import { PortalSendBody } from './PortalSendDialog';

export function WikiDialogs() {
  const d = useWikiDialog();
  const close = () => openWikiDialog(null);
  return (
    <>
      <Dialog open={d?.kind === 'templates'} onOpenChange={(v) => (v ? null : close())}>
        {d?.kind === 'templates' ? (
          <TemplateGallery
            spaceId={d.spaceId}
            parentId={d.parentId}
            kind={d.templateKind ?? 'page'}
            onClose={close}
            onSaveSpace={() =>
              openWikiDialog({
                kind: 'saveTemplate',
                templateKind: 'space',
                spaceId: d.spaceId,
                name: '',
              })
            }
          />
        ) : null}
      </Dialog>
      <Dialog open={d?.kind === 'import'} onOpenChange={(v) => (v ? null : close())}>
        {d?.kind === 'import' ? (
          <ImportBody spaceId={d.spaceId} parentId={d.parentId} onClose={close} />
        ) : null}
      </Dialog>
      <Dialog open={d?.kind === 'export'} onOpenChange={(v) => (v ? null : close())}>
        {d?.kind === 'export' ? (
          <ExportBody nodeId={d.nodeId} name={d.name} onClose={close} />
        ) : null}
      </Dialog>
      <Dialog open={d?.kind === 'toPortal'} onOpenChange={(v) => (v ? null : close())}>
        {d?.kind === 'toPortal' ? (
          <PortalSendBody nodeId={d.nodeId} name={d.name} onClose={close} />
        ) : null}
      </Dialog>
      <Dialog open={d?.kind === 'saveTemplate'} onOpenChange={(v) => (v ? null : close())}>
        {d?.kind === 'saveTemplate' ? (
          <SaveTemplateBody
            kind={d.templateKind}
            nodeId={d.nodeId}
            spaceId={d.spaceId}
            defaultName={d.name}
            onClose={close}
          />
        ) : null}
      </Dialog>
    </>
  );
}

type ImportWarning =
  | { path: string; code: 'empty' | 'too_large' | 'duplicate' | 'unreadable' | 'too_many' }
  | { path: string; code: 'missing_attachment' | 'attachment_failed'; target: string };

/**
 * Markdown import (design 5.15): .md files, a whole folder or an export package (.zip from
 * Outline / Notion). Images and attachments the pages link to are uploaded to Drive and the
 * links point at them (H18); links that match no file of the package are listed.
 */
function ImportBody({
  spaceId,
  parentId,
  onClose,
}: {
  spaceId: string;
  parentId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<{
    pages: number;
    attachments: number;
    warnings: ImportWarning[];
  } | null>(null);

  const run = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const all = await readPackage(list);
      const { markdown, skipped } = pagesToImport(all);
      if (!markdown.length) {
        toast(t('errors.import_invalid'));
        return;
      }
      const assets = await rewriteAttachments(
        markdown,
        new AssetIndex(all),
        attachmentUploader({ spaceId, parentId, folderName: t('wiki.import.attachmentsFolder') }),
      );
      const res = await api.call('importPages', {
        params: { spaceId },
        body: { parentId, files: assets.files },
      });
      void qc.invalidateQueries({ queryKey: wikiKeys.tree(spaceId) });
      if (assets.uploaded) invalidateDrive(qc);
      const warnings: ImportWarning[] = [
        ...skipped,
        ...res.warnings,
        ...assets.missing.map((m) => ({ ...m, code: 'missing_attachment' as const })),
        ...assets.failed.map((m) => ({ ...m, code: 'attachment_failed' as const })),
      ];
      setReport({ pages: res.pages.length, attachments: assets.uploaded, warnings });
      const first = res.pages[0];
      if (first && warnings.length === 0) {
        onClose();
        toast(t('wiki.import.done', { count: res.pages.length }));
        void navigate({ to: '/p/$pageRef', params: { pageRef: pagePath(first).slice(3) } });
      }
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent width={520}>
      <DialogHeader
        icon="upload"
        title={t('wiki.import.title')}
        description={t('wiki.import.hint')}
      />
      {report ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="flex items-center gap-2 text-fg">
            <Icon name="checkC" size={16} className="text-success" />
            {t('wiki.import.done', { count: report.pages })}
          </p>
          {report.attachments ? (
            <p className="flex items-center gap-2 text-fg">
              <Icon name="checkC" size={16} className="text-success" />
              {t('wiki.import.attachments', { count: report.attachments })}
            </p>
          ) : null}
          <div className="flex max-h-[240px] flex-col gap-2 overflow-y-auto">
            {report.warnings.map((w, i) => (
              <p key={`${w.path}-${i}`} className="flex items-start gap-2 break-all text-fg2">
                <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-warning" />
                <span>
                  {w.path} ·{' '}
                  {'target' in w
                    ? t(`wiki.import.warning.${w.code}`, { target: w.target })
                    : t(`wiki.import.warning.${w.code}`)}
                </span>
              </p>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={() => files.current?.click()}
            className="flex flex-col items-start gap-1 rounded-lg border border-line p-4 text-left hover:bg-bg2"
          >
            <Icon name="file" size={20} />
            <span className="font-semibold">{t('wiki.import.files')}</span>
            <span className="text-cap text-fg3">{t('wiki.import.filesHint')}</span>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => folder.current?.click()}
            className="flex flex-col items-start gap-1 rounded-lg border border-line p-4 text-left hover:bg-bg2"
          >
            <Icon name="folder" size={20} />
            <span className="font-semibold">{t('wiki.import.folder')}</span>
            <span className="text-cap text-fg3">{t('wiki.import.folderHint')}</span>
          </button>
          <input
            ref={files}
            type="file"
            accept=".md,.markdown,text/markdown,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.zip,application/zip"
            multiple
            hidden
            onChange={(e) => void run(e.target.files)}
          />
          <input
            ref={(el) => {
              folder.current = el;
              el?.setAttribute('webkitdirectory', '');
            }}
            type="file"
            multiple
            hidden
            onChange={(e) => void run(e.target.files)}
          />
        </div>
      )}
      <DialogFooter>
        <Button variant="gh" onClick={onClose} loading={busy}>
          {report ? t('common.actions.close') : t('common.actions.cancel')}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
