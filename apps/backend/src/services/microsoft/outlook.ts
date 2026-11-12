import { createHash } from 'node:crypto';
import {
  MICROSOFT_WEB_PATHS,
  OUTLOOK_ATTACHMENT_MAX_BYTES,
  type ShareAttachment,
  type SharedAttachment,
} from '@crewhall/shared';
import { resources } from '@crewhall/i18n';
import type { Deps } from '../../deps';
import type { Env } from '../../env';
import { AppError } from '../../http/errors';
import type { OrgRow, RequestInfo } from '../../http/types';
import type { DriveActor } from '../drive/access';
import { createShare } from '../drive/shares';
import { attachmentsFolderName, personalFolder, storeBytes } from './drive-store';

/**
 * Outlook add-in (Office Add-in, sonraki-isler.md): attachments of a mail being written become
 * Drive links (password and expiry optional), and the org's add-in manifest. The task pane
 * itself is the web app (`/office/outlook`); it signs in with Crewhall OIDC.
 */

export async function shareAttachment(
  deps: Deps,
  a: DriveActor & { userName: string },
  input: ShareAttachment,
  req: RequestInfo,
): Promise<SharedAttachment> {
  const content = Buffer.from(input.contentBase64, 'base64');
  if (!content.length) throw new AppError('upload_invalid', { reason: 'empty' });
  if (content.length > OUTLOOK_ATTACHMENT_MAX_BYTES) {
    throw new AppError('file_too_large', { maxFileBytes: OUTLOOK_ATTACHMENT_MAX_BYTES });
  }
  const folder = await personalFolder(deps, a, attachmentsFolderName(a.org.settings.defaultLocale));
  const { nodeId } = await storeBytes(deps, a, {
    spaceId: folder.spaceId,
    parentId: folder.folderId,
    name: input.name,
    content,
    mime: input.mime,
  });
  const share = await createShare(
    deps,
    a,
    nodeId,
    {
      kind: 'link',
      role: 'viewer',
      allowDownload: true,
      expiresAt: input.expiresAt ?? null,
      ...(input.password ? { password: input.password } : {}),
    },
    req,
  );
  if (!share.url) throw new AppError('internal');
  return {
    nodeId,
    url: share.url,
    expiresAt: share.expiresAt,
    passwordProtected: share.hasPassword,
  };
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A stable GUID per org and client, so a re-downloaded manifest updates the same add-in. */
export function addinId(orgId: string, clientId: string) {
  const h = createHash('sha256').update(`outlook\n${orgId}\n${clientId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Add-in only manifest (XML): a task pane in read mode ("Crewhall'a kaydet") and in compose
 * mode (attachments as links, upload request link). Mailbox 1.8 for attachment content.
 */
export function outlookManifest(
  env: Env,
  org: Pick<OrgRow, 'id' | 'name' | 'settings'>,
  clientId: string,
) {
  const hub = env.HUB_URL.replace(/\/+$/, '');
  const api = env.API_URL.replace(/\/+$/, '');
  const tr = org.settings.defaultLocale === 'tr';
  const pane = (mode: 'read' | 'compose') =>
    `${hub}${MICROSOFT_WEB_PATHS.outlookPane}?mode=${mode}&client=${encodeURIComponent(clientId)}`;
  const icon = (size: number) => `${hub}/office/icon-${size}.png`;
  const t = resources[org.settings.defaultLocale].email.microsoft.outlook;
  const appDomains = [...new Set([new URL(hub).origin, new URL(api).origin])];
  const button = (id: string, label: string, tip: string, url: string) => `
                <Control xsi:type="Button" id="${id}">
                  <Label resid="${label}"/>
                  <Supertip><Title resid="${label}"/><Description resid="${tip}"/></Supertip>
                  <Icon>
                    <bt:Image size="16" resid="icon16"/>
                    <bt:Image size="32" resid="icon32"/>
                    <bt:Image size="80" resid="icon80"/>
                  </Icon>
                  <Action xsi:type="ShowTaskpane"><SourceLocation resid="${url}"/></Action>
                </Control>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:mailappor="http://schemas.microsoft.com/office/mailappversionoverrides/1.0"
  xsi:type="MailApp">
  <Id>${addinId(org.id, clientId)}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>${xml(org.name)}</ProviderName>
  <DefaultLocale>${tr ? 'tr-TR' : 'en-US'}</DefaultLocale>
  <DisplayName DefaultValue="Crewhall"/>
  <Description DefaultValue="${xml(t.description)}"/>
  <IconUrl DefaultValue="${icon(64)}"/>
  <HighResolutionIconUrl DefaultValue="${icon(128)}"/>
  <SupportUrl DefaultValue="${hub}"/>
  <AppDomains>
${appDomains.map((d) => `    <AppDomain>${xml(d)}</AppDomain>`).join('\n')}
  </AppDomains>
  <Hosts><Host Name="Mailbox"/></Hosts>
  <Requirements><Sets><Set Name="Mailbox" MinVersion="1.1"/></Sets></Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings><SourceLocation DefaultValue="${xml(pane('read'))}"/><RequestedHeight>450</RequestedHeight></DesktopSettings>
    </Form>
    <Form xsi:type="ItemEdit">
      <DesktopSettings><SourceLocation DefaultValue="${xml(pane('compose'))}"/></DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadWriteItem</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Edit"/>
  </Rule>
  <DisableEntityHighlighting>false</DisableEntityHighlighting>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
      <Requirements>
        <bt:Sets DefaultMinVersion="1.8"><bt:Set Name="Mailbox"/></bt:Sets>
      </Requirements>
      <Hosts>
        <Host xsi:type="MailHost">
          <DesktopFormFactor>
            <ExtensionPoint xsi:type="MessageReadCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="crewhallRead">
                  <Label resid="groupLabel"/>${button('crewhallSave', 'saveLabel', 'saveTip', 'readPane')}
                </Group>
              </OfficeTab>
            </ExtensionPoint>
            <ExtensionPoint xsi:type="MessageComposeCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="crewhallCompose">
                  <Label resid="groupLabel"/>${button('crewhallShare', 'shareLabel', 'shareTip', 'composePane')}
                </Group>
              </OfficeTab>
            </ExtensionPoint>
          </DesktopFormFactor>
        </Host>
      </Hosts>
      <Resources>
        <bt:Images>
          <bt:Image id="icon16" DefaultValue="${icon(16)}"/>
          <bt:Image id="icon32" DefaultValue="${icon(32)}"/>
          <bt:Image id="icon80" DefaultValue="${icon(80)}"/>
        </bt:Images>
        <bt:Urls>
          <bt:Url id="readPane" DefaultValue="${xml(pane('read'))}"/>
          <bt:Url id="composePane" DefaultValue="${xml(pane('compose'))}"/>
        </bt:Urls>
        <bt:ShortStrings>
          <bt:String id="groupLabel" DefaultValue="${xml(t.group)}"/>
          <bt:String id="saveLabel" DefaultValue="${xml(t.save)}"/>
          <bt:String id="shareLabel" DefaultValue="${xml(t.share)}"/>
        </bt:ShortStrings>
        <bt:LongStrings>
          <bt:String id="saveTip" DefaultValue="${xml(t.saveTip)}"/>
          <bt:String id="shareTip" DefaultValue="${xml(t.shareTip)}"/>
        </bt:LongStrings>
      </Resources>
    </VersionOverrides>
  </VersionOverrides>
</OfficeApp>
`;
}
