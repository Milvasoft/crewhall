import { Button, Field, Input, Skeleton } from '@crewhall/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AuthLayout, Notice } from '@/components/auth/AuthLayout';
import { api, isApiError } from '@/lib/api';
import { errorKey } from '@/lib/errors';
import { formatBytes, formatDateLong } from '@/lib/i18n/format';
import { useI18n } from '@/lib/i18n/I18nContext';

/** File as base64 without the data URL prefix. */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('read'));
    reader.readAsDataURL(file);
  });
}

/**
 * `/u/<token>`: "bana dosya yükle" from the Outlook add-in. Anyone with the link uploads into
 * one folder of the person who asked; nothing in the folder is shown.
 */
export function UploadRequestPage({ token }: { token: string }) {
  const { t, locale } = useI18n();
  const info = useQuery({
    queryKey: ['upload-request', token],
    queryFn: () => api.call('getPublicUploadRequest', { params: { token } }),
    retry: false,
  });
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<{ tone: 'info' | 'error'; text: string }[]>([]);

  if (info.isError) {
    const closed =
      isApiError(info.error, 'upload_request_closed') || isApiError(info.error, 'not_found');
    return (
      <AuthLayout>
        <h1 className="m-0 text-h3 font-bold">{t('microsoft.upload.closed')}</h1>
        <p className="m-0 text-cap text-fg2">
          {closed ? t('microsoft.upload.closedBody') : t(errorKey(info.error))}
        </p>
      </AuthLayout>
    );
  }
  if (!info.data) {
    return (
      <AuthLayout>
        <Skeleton className="h-40 rounded-lg" />
      </AuthLayout>
    );
  }
  const r = info.data;

  const send = async () => {
    setBusy(true);
    const out: typeof messages = [];
    for (const file of files) {
      if (file.size > r.maxFileBytes) {
        out.push({
          tone: 'error',
          text: t('microsoft.upload.tooLarge', {
            name: file.name,
            size: formatBytes(r.maxFileBytes, locale),
          }),
        });
        continue;
      }
      try {
        const done = await api.call('uploadToRequest', {
          params: { token },
          body: {
            name: file.name,
            mime: file.type || null,
            contentBase64: await readBase64(file),
            ...(r.passwordRequired ? { password } : {}),
            ...(name.trim() ? { uploaderName: name.trim() } : {}),
          },
        });
        out.push({ tone: 'info', text: t('microsoft.upload.sent', { name: done.name }) });
      } catch (e) {
        out.push({ tone: 'error', text: `${file.name}: ${t(errorKey(e))}` });
      }
    }
    setMessages(out);
    setFiles([]);
    setBusy(false);
  };

  return (
    <AuthLayout>
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-h3 font-bold">
          {t('microsoft.upload.title', { name: r.requestedBy })}
        </h1>
        <span className="text-cap text-fg2">
          {t('microsoft.upload.subtitle', { org: r.orgName, folder: r.folderName })}
        </span>
        <span className="text-xs text-fg2">
          {t('microsoft.upload.expires', { date: formatDateLong(r.expiresAt, locale) })}
        </span>
      </div>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {r.passwordRequired ? (
          <Field label={t('microsoft.upload.password')}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        ) : null}
        <Field label={t('microsoft.upload.yourName')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </Field>
        <Field label={t('microsoft.upload.choose')}>
          <input
            type="file"
            multiple
            aria-label={t('microsoft.upload.choose')}
            className="text-cap"
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
          />
        </Field>
        {messages.map((m) => (
          <Notice key={m.text} tone={m.tone}>
            {m.text}
          </Notice>
        ))}
        <Button
          type="submit"
          variant="inv"
          loading={busy}
          disabled={files.length === 0 || (r.passwordRequired && !password)}
        >
          {busy ? t('microsoft.upload.sending') : t('microsoft.upload.send')}
        </Button>
      </form>
    </AuthLayout>
  );
}
