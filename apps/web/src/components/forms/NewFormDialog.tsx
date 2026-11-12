import { FORM_LIMITS, type Space } from '@crewhall/shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Field,
  Input,
  toast,
} from '@crewhall/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formKeys } from '@/lib/forms/api';
import { useI18n } from '@/lib/i18n/I18nContext';

/** New form: the name first, so no untitled drafts pile up (test findings 2026-10-22). */
export function NewFormDialog({
  space,
  open,
  onClose,
}: {
  space: Space;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.call('createForm', {
        params: { spaceId: space.id },
        body: { title: title.trim(), fields: [] },
      }),
    onSuccess: (form) => {
      qc.setQueryData(formKeys.form(form.id), form);
      void qc.invalidateQueries({ queryKey: formKeys.list(form.spaceId) });
      setTitle('');
      onClose();
      void navigate({ to: '/forms/f/$formId', params: { formId: form.id } });
    },
    onError: (e) => toast(t(errorKey(e))),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent width={460}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <DialogHeader
            icon="todo"
            title={t('forms.new.title')}
            description={t('forms.new.body')}
          />
          <Field label={t('forms.new.name')}>
            <Input
              autoFocus
              value={title}
              maxLength={FORM_LIMITS.titleChars}
              placeholder={t('forms.new.placeholder')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="gh" onClick={onClose}>
              {t('common.actions.cancel')}
            </Button>
            <Button type="submit" variant="pri" loading={create.isPending} disabled={!title.trim()}>
              {t('forms.new.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
