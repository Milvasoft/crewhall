import type { TemplateKind } from '@crewhall/shared';
import {
  Button,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  Radio,
  RadioGroup,
  toast,
} from '@crewhall/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useSpaces } from '@/lib/useSpaces';
import { templateKeys, templatesQuery } from './api';

type Scope = 'personal' | 'space' | 'org';

/**
 * "Şablon olarak kaydet" (roadmap 8): a page or a board (`nodeId`) or a whole space becomes a
 * template. Personal for anyone; the space's templates for its admins and owner; the org's for
 * org admins.
 */
export function SaveTemplateBody({
  kind,
  nodeId,
  spaceId,
  defaultName,
  onClose,
}: {
  kind: TemplateKind;
  nodeId?: string;
  spaceId: string;
  defaultName: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const { items: spaces } = useSpaces();
  const space = spaces.find((s) => s.id === spaceId);
  const canSpace = space?.myRole === 'owner' || space?.myRole === 'admin';
  const canOrg = useQuery(templatesQuery()).data?.canCreateOrg ?? false;
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<Scope>('personal');

  const save = useMutation({
    mutationFn: () =>
      api.call('createTemplate', {
        body: {
          kind,
          scope,
          ...(kind === 'space'
            ? { spaceId }
            : { nodeId, spaceId: scope === 'space' ? spaceId : undefined }),
          name: name.trim(),
          description: description.trim(),
          category: kind === 'board' || kind === 'space' ? 'project' : 'team',
        },
      }),
    onSuccess: (tpl) => {
      void qc.invalidateQueries({ queryKey: templateKeys.all });
      void qc.invalidateQueries({ queryKey: ['wiki', 'templates'] });
      toast(t('templates.saved', { name: tpl.name }));
      onClose();
    },
    onError: (e) => toast(t(errorKey(e))),
  });

  return (
    <DialogContent width={480}>
      <DialogHeader
        icon="layers"
        title={t(`templates.saveTitle.${kind}`)}
        description={t(`templates.saveHint.${kind}`)}
      />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <Field label={t('templates.name')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
        </Field>
        <Field label={t('templates.description')}>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={300}
          />
        </Field>
        <RadioGroup
          value={scope}
          onValueChange={(v) => setScope(v as Scope)}
          aria-label={t('templates.scope')}
          className="flex flex-col gap-2"
        >
          <label className="flex items-center gap-2 text-sm">
            <Radio value="personal" /> {t('templates.scopes.personal')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Radio value="space" disabled={!canSpace} /> {t('templates.scopes.space')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Radio value="org" disabled={!canOrg} /> {t('templates.scopes.org')}
          </label>
        </RadioGroup>
        <DialogFooter>
          <Button type="button" variant="gh" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="submit" variant="pri" loading={save.isPending} disabled={!name.trim()}>
            {t('templates.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
