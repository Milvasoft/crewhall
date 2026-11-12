import { type OfficeDocumentKind, type OfficeExtension } from '@crewhall/shared';
import { MenuItem, toast, type IconName } from '@crewhall/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { type ActionEntry } from '@/components/common/ActionMenu';
import { invalidateDrive } from '@/features/drive/api';
import { api, idempotencyKey } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useOfficeCanCreate } from '@/lib/office/queries';

const KINDS: { kind: OfficeDocumentKind; ext: OfficeExtension; icon: IconName }[] = [
  { kind: 'document', ext: 'docx', icon: 'file' },
  { kind: 'spreadsheet', ext: 'xlsx', icon: 'sheet' },
  { kind: 'presentation', ext: 'pptx', icon: 'screen' },
];

/** Creates an empty Word, Excel or PowerPoint file in a folder and opens it in the editor. */
export function useNewOfficeDocument() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const create = async (spaceId: string, parentId: string | null, kind: OfficeDocumentKind) => {
    setBusy(true);
    try {
      const node = await api.call('createOfficeDocument', {
        body: { spaceId, parentId, kind, format: 'ooxml', name: t(`office.untitled.${kind}`) },
        idempotencyKey: idempotencyKey(),
      });
      invalidateDrive(qc);
      void navigate({ to: '/office/$nodeId', params: { nodeId: node.id } });
    } catch (e) {
      toast(t(errorKey(e)));
    } finally {
      setBusy(false);
    }
  };
  return { create, busy };
}

/** Drive › Yeni: Belge, Tablo, Sunum when the document server can edit those types. */
export function OfficeNewItems({
  spaceId,
  parentId,
}: {
  spaceId: string;
  parentId: string | null;
}) {
  const { t } = useI18n();
  const canCreate = useOfficeCanCreate();
  const office = useNewOfficeDocument();
  return (
    <>
      {KINDS.filter((k) => canCreate(k.ext)).map((k) => (
        <MenuItem
          key={k.kind}
          icon={k.icon}
          disabled={office.busy}
          onSelect={() => void office.create(spaceId, parentId, k.kind)}
        >
          {t(`office.new.${k.kind}`)}
        </MenuItem>
      ))}
    </>
  );
}

/** The same items for the folder's right-click menu. */
export function useOfficeNewEntries() {
  const { t } = useI18n();
  const canCreate = useOfficeCanCreate();
  const office = useNewOfficeDocument();
  return (spaceId: string, parentId: string | null): ActionEntry[] =>
    KINDS.filter((k) => canCreate(k.ext)).map((k) => ({
      kind: 'item' as const,
      key: `office-${k.kind}`,
      icon: k.icon,
      label: t(`office.new.${k.kind}`),
      onSelect: () => void office.create(spaceId, parentId, k.kind),
    }));
}
