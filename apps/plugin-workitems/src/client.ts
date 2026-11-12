import { connect, type Bridge, type Theme } from '@crewhall/plugin-sdk/bridge';

/** The page inside Crewhall's frame. */

const TR = {
  subtitle: 'Panolarını Azure DevOps ile eşitle, pipeline ve Library’yi buradan yönet.',
  subtitle_jira: 'Panolarını Jira ile iki yönlü eşitle, sana atanan işleri buradan takip et.',
  pipelines_sub: 'Koşuları izle, başlat ve onayla.',
  library_sub: 'Değişken gruplarını gör ve düzenle.',
  tab_syncs: 'Eşitlemeler',
  tab_connections: 'Bağlantılar',
  tab_mine: 'Bana atananlar',
  tab_pipelines: 'Pipeline',
  tab_library: 'Library',
  loading: 'Yükleniyor…',
  retry: 'Yeniden dene',
  cancel: 'Vazgeç',
  remove: 'Kaldır',
  save: 'Kaydet',
  refresh: 'Yenile',
  add_connection: 'Bağlantı ekle',
  new_connection: 'Yeni bağlantı',
  azure: 'Azure DevOps',
  jira: 'Jira',
  azure_hint: 'Work item, pipeline ve Library',
  jira_hint: 'Cloud ve Data Center',
  name: 'Bağlantı adı',
  name_ph: 'Örn. Şirket {service}',
  base_url_azure: 'Kuruluş adresi',
  base_url_jira: 'Site adresi',
  auth_pat: 'Token',
  auth_pat_hint: 'Kişisel erişim token’ı',
  auth_entra: 'Entra ID',
  auth_entra_hint: 'Microsoft hesabıyla giriş',
  token: 'Token',
  token_azure_hint: 'Work Items, Build, Variable Groups ve Project izinleri',
  token_jira_hint: 'Cloud için API token, Data Center için kişisel token',
  email: 'E-posta',
  email_hint: 'Yalnız Jira Cloud için',
  tenant: 'Kiracı (tenant) kimliği',
  client_id: 'Uygulama (client) kimliği',
  client_secret: 'Uygulama sırrı',
  entra_hint:
    'Açılan pencerede Microsoft hesabınla giriş yap. Bağlantı kurulunca burası güncellenir.',
  entra_waiting: 'Microsoft girişi bekleniyor…',
  entra_failed: 'Entra ID bağlantısı kurulamadı.',
  connect: 'Bağlan',
  via_pat: 'Token',
  via_entra: 'Entra ID',
  add_sync: 'Eşitleme ekle',
  new_sync: 'Yeni eşitleme',
  no_syncs: 'Bir panoyu {service} projesiyle eşitle; değişiklikler iki tarafa da yansısın.',
  need_connection: 'Eşitleme kurmak için önce bir bağlantı ekle.',
  step_source: 'Neyi eşitleyelim?',
  step_columns: 'Sütunlar ve durumlar',
  step_rules: 'Kurallar',
  connection: 'Bağlantı',
  project: 'Proje',
  board: 'Crewhall panosu',
  choose: 'Seç',
  types: 'İş türleri',
  types_hint: 'Hiçbirini seçmezsen hepsi eşitlenir.',
  filter_azure: 'Ek WIQL koşulu',
  filter_jira: 'Ek JQL koşulu',
  optional: 'İsteğe bağlı',
  column_map_hint: 'Her sütun için durumları seç. Kart taşınınca seçilen ilk durum yazılır.',
  pick_first: 'Sütunları görmek için proje ve pano seç.',
  direction: 'Yön',
  dir_both: 'İki yönlü',
  dir_to_crewhall: 'Yalnız Crewhall’a',
  dir_to_external: 'Yalnız dış servise',
  conflict: 'İki taraf da değiştirirse',
  conf_newest: 'Son değişiklik kazanır',
  conf_external: 'Dış servis kazanır',
  conf_crewhall: 'Crewhall kazanır',
  comments: 'Yorumları da eşitle',
  push_new: 'Panoda açılan kartlar için iş aç',
  default_type: 'Yeni iş türü',
  create_sync: 'Eşitlemeyi başlat',
  consent_needed: 'Eşitleme sen ekranda değilken de çalışır, bunun için izin vermen gerekiyor.',
  consent_unsupported: 'Arka plan izni bu uygulamada verilemiyor. Web’den aç.',
  run_now: 'Şimdi eşitle',
  started: 'Eşitleme başlatıldı',
  pause: 'Duraklat',
  resume: 'Sürdür',
  history: 'Geçmiş',
  linked: 'eşli kart',
  last_run: 'Son eşitleme',
  never: 'henüz yok',
  live: 'Anlık',
  polling: 'Periyodik',
  paused: 'Duraklatıldı',
  remove_sync_title: 'Eşitleme kaldırılsın mı?',
  remove_sync_body: 'Kartlar ve işler silinmez, yalnız aralarındaki bağlantı kopar.',
  remove_conn_title: 'Bağlantı kaldırılsın mı?',
  remove_conn_body: 'Kayıtlı token bu sunucudan silinir.',
  empty_mine: 'Sana atanmış açık iş yok.',
  none_connected: 'Bağlantı ekleyince sana atanan işler burada görünür.',
  failed_connections: 'Ulaşılamayan bağlantılar',
  log_empty: 'Henüz kayıt yok.',
  need_azure: 'Bu bölüm için bir Azure DevOps bağlantısı ekle.',
  choose_project: 'Görmek için bir proje seç.',
  search: 'Ara',
  search_pipelines: 'Pipeline ara',
  approvals: 'Onay bekleyenler',
  approve: 'Onayla',
  reject: 'Reddet',
  approved_toast: 'Onaylandı',
  rejected_toast: 'Reddedildi',
  active_runs: 'Şu an çalışan ve sırada bekleyen',
  all_pipelines: 'Pipeline’lar',
  no_pipelines: 'Bu projede pipeline yok.',
  no_match: 'Eşleşen sonuç yok.',
  run_pipeline: 'Çalıştır',
  run_title: 'Pipeline çalıştırılsın mı?',
  branch: 'Dal',
  branch_hint: 'Boş bırakırsan pipeline’ın varsayılan dalı kullanılır.',
  run_started: 'Pipeline başlatıldı',
  cancel_run: 'İptal et',
  cancel_run_title: 'Koşu iptal edilsin mi?',
  cancel_run_body: 'Çalışan adımlar durdurulur.',
  retry_stage: 'Yeniden çalıştır',
  retried: 'Aşama yeniden başlatıldı',
  open_azure: 'Azure’da aç',
  runs: 'Koşular',
  no_runs: 'Henüz koşu yok.',
  no_stages: 'Bu koşunun aşama bilgisi yok.',
  no_log: 'Bu adımın logu yok.',
  log_truncated: 'Yalnız son satırlar gösteriliyor.',
  close: 'Kapat',
  by: 'başlatan',
  st_notStarted: 'Sırada',
  st_inProgress: 'Çalışıyor',
  st_cancelling: 'İptal ediliyor',
  st_completed: 'Bitti',
  st_postponed: 'Ertelendi',
  rs_succeeded: 'Başarılı',
  rs_partiallySucceeded: 'Kısmen başarılı',
  rs_failed: 'Başarısız',
  rs_canceled: 'İptal edildi',
  rs_skipped: 'Atlandı',
  no_groups: 'Bu projede değişken grubu yok.',
  add_variable: 'Değişken ekle',
  edit_variable: 'Değişkeni düzenle',
  variable_name: 'Ad',
  variable_value: 'Değer',
  variable_secret: 'Gizli değer',
  variable_secret_hint: 'Kaydedildikten sonra kimse okuyamaz, yalnız yenisi yazılabilir.',
  secret_new_value: 'Yeni değer',
  secret_hidden: 'Gizli',
  save_title: 'Değişiklik kaydedilsin mi?',
  save_body: 'Bu grubu kullanan pipeline’lar bir sonraki koşuda yeni değeri alır.',
  remove_var_title: 'Değişken silinsin mi?',
  remove_var_body: 'Bu grubu kullanan pipeline’lar bu değeri artık alamaz.',
  saved: 'Kaydedildi',
  key_vault: 'Key Vault’a bağlı, burada düzenlenemez',
  variables: 'değişken',
  edited: 'güncelleyen',
  activity: 'Son işlemler',
  a_run: 'çalıştırdı',
  a_cancel: 'iptal etti',
  a_retry: 'yeniden başlattı',
  a_approved: 'onayladı',
  a_rejected: 'reddetti',
  a_set_variable: 'değişken yazdı',
  a_set_secret: 'gizli değer yazdı',
  a_remove_variable: 'değişken sildi',
  err_generic: 'İşlem tamamlanamadı.',
  err_auth_failed: 'Token kabul edilmedi. Süresini ve izinlerini kontrol et.',
  err_forbidden: 'Bu token’ın buna izni yok.',
  err_not_found: 'Bulunamadı. Adresi kontrol et.',
  err_invalid_url: 'Adres geçersiz, https ile başlamalı.',
  err_blocked_address: 'Bu adrese bu sunucudan bağlanılamaz.',
  err_unreachable: 'Servise ulaşılamadı.',
  err_rejected: 'Servis isteği reddetti.',
  err_connection_in_use: 'Bu bağlantıyı kullanan bir eşitleme var.',
  err_board_already_synced: 'Bu pano zaten eşitleniyor.',
  err_board_read_only: 'Bu panoda düzenleme yetkin yok.',
  err_unknown_type: 'İş türü bu projede yok.',
  err_entra_client_required: 'Uygulama kimliği gerekli.',
  err_validation_failed: 'Alanları kontrol et.',
  err_offline_not_granted: 'Arka plan izni kapalı. Eşitleme durdu.',
  err_library_read_only: 'Key Vault’a bağlı grup burada düzenlenemez.',
  err_library_secret_stays: 'Gizli bir değer düz metne çevrilemez. Silip yeniden ekle.',
  err_azure_only: 'Bu özellik yalnız Azure DevOps’ta var.',
  status_partial: 'Bazı öğeler eşitlenemedi',
  status_continuing: 'Aktarım sürüyor',
  field_title: 'başlık',
  field_description: 'açıklama',
  field_column: 'sütun',
  field_status: 'durum',
  field_assignee: 'atanan',
  field_priority: 'öncelik',
  field_dueDate: 'bitiş tarihi',
  field_startDate: 'başlangıç tarihi',
  field_labels: 'etiketler',
  field_points: 'puan',
  log_imported: 'Karta aktarıldı',
  log_pushed: 'Dış servise aktarıldı',
  log_updated_card: 'Kart güncellendi',
  log_updated_external: 'Dış servis güncellendi',
  log_external_removed: 'Dış serviste silindi, kart arşivlendi',
  log_card_removed: 'Kart silindi, bağlantı koptu',
  log_conflict: 'Çakışma çözüldü',
  log_no_status_for_column: 'Bu sütun için bu iş türünde durum yok',
  log_no_transition: 'İş akışı bu duruma geçişe izin vermiyor',
  ago_now: 'şimdi',
};
type Key = keyof typeof TR;

const EN: Record<Key, string> = {
  subtitle: 'Sync your boards with Azure DevOps, and manage pipelines and the Library here.',
  subtitle_jira: 'Keep your boards in two-way sync with Jira and follow your assigned issues here.',
  pipelines_sub: 'Watch, start and approve runs.',
  library_sub: 'See and edit variable groups.',
  tab_syncs: 'Syncs',
  tab_connections: 'Connections',
  tab_mine: 'Assigned to me',
  tab_pipelines: 'Pipelines',
  tab_library: 'Library',
  loading: 'Loading…',
  retry: 'Try again',
  cancel: 'Cancel',
  remove: 'Remove',
  save: 'Save',
  refresh: 'Refresh',
  add_connection: 'Add connection',
  new_connection: 'New connection',
  azure: 'Azure DevOps',
  jira: 'Jira',
  azure_hint: 'Work items, pipelines and Library',
  jira_hint: 'Cloud and Data Center',
  name: 'Connection name',
  name_ph: 'e.g. Company {service}',
  base_url_azure: 'Organization URL',
  base_url_jira: 'Site URL',
  auth_pat: 'Token',
  auth_pat_hint: 'Personal access token',
  auth_entra: 'Entra ID',
  auth_entra_hint: 'Sign in with Microsoft',
  token: 'Token',
  token_azure_hint: 'Work Items, Build, Variable Groups and Project scopes',
  token_jira_hint: 'API token for Cloud, personal token for Data Center',
  email: 'Email',
  email_hint: 'Jira Cloud only',
  tenant: 'Tenant ID',
  client_id: 'Application (client) ID',
  client_secret: 'Application secret',
  entra_hint:
    'Sign in with your Microsoft account in the window that opens. This page updates when it is done.',
  entra_waiting: 'Waiting for Microsoft sign-in…',
  entra_failed: 'Could not connect with Entra ID.',
  connect: 'Connect',
  via_pat: 'Token',
  via_entra: 'Entra ID',
  add_sync: 'Add sync',
  new_sync: 'New sync',
  no_syncs: 'Sync a board with a {service} project so changes reach both sides.',
  need_connection: 'Add a connection before setting up a sync.',
  step_source: 'What to sync',
  step_columns: 'Columns and statuses',
  step_rules: 'Rules',
  connection: 'Connection',
  project: 'Project',
  board: 'Crewhall board',
  choose: 'Choose',
  types: 'Work item types',
  types_hint: 'If you pick none, all are synced.',
  filter_azure: 'Extra WIQL condition',
  filter_jira: 'Extra JQL condition',
  optional: 'Optional',
  column_map_hint: 'Pick the statuses of each column. Moving a card writes the first one picked.',
  pick_first: 'Pick a project and a board to see the columns.',
  direction: 'Direction',
  dir_both: 'Two-way',
  dir_to_crewhall: 'Into Crewhall only',
  dir_to_external: 'Out to the service only',
  conflict: 'If both sides change',
  conf_newest: 'Latest change wins',
  conf_external: 'The service wins',
  conf_crewhall: 'Crewhall wins',
  comments: 'Sync comments too',
  push_new: 'Open a work item for new cards',
  default_type: 'New item type',
  create_sync: 'Start sync',
  consent_needed: 'The sync also runs while you are away, so it needs your permission.',
  consent_unsupported: 'Background access cannot be granted in this app. Open it on the web.',
  run_now: 'Sync now',
  started: 'Sync started',
  pause: 'Pause',
  resume: 'Resume',
  history: 'History',
  linked: 'linked cards',
  last_run: 'Last sync',
  never: 'not yet',
  live: 'Live',
  polling: 'Periodic',
  paused: 'Paused',
  remove_sync_title: 'Remove this sync?',
  remove_sync_body: 'Cards and work items stay; only their link ends.',
  remove_conn_title: 'Remove this connection?',
  remove_conn_body: 'The stored token is deleted from this server.',
  empty_mine: 'Nothing open is assigned to you.',
  none_connected: 'Work assigned to you appears here once you add a connection.',
  failed_connections: 'Connections that could not be reached',
  log_empty: 'Nothing yet.',
  need_azure: 'Add an Azure DevOps connection for this section.',
  choose_project: 'Choose a project to see it.',
  search: 'Search',
  search_pipelines: 'Search pipelines',
  approvals: 'Waiting for approval',
  approve: 'Approve',
  reject: 'Reject',
  approved_toast: 'Approved',
  rejected_toast: 'Rejected',
  active_runs: 'Running and queued',
  all_pipelines: 'Pipelines',
  no_pipelines: 'This project has no pipelines.',
  no_match: 'No matches.',
  run_pipeline: 'Run',
  run_title: 'Run this pipeline?',
  branch: 'Branch',
  branch_hint: 'Leave empty for the pipeline’s default branch.',
  run_started: 'Pipeline started',
  cancel_run: 'Cancel run',
  cancel_run_title: 'Cancel this run?',
  cancel_run_body: 'Running steps are stopped.',
  retry_stage: 'Retry',
  retried: 'Stage restarted',
  open_azure: 'Open in Azure',
  runs: 'Runs',
  no_runs: 'No runs yet.',
  no_stages: 'This run has no stage details.',
  no_log: 'This step has no log.',
  log_truncated: 'Only the last lines are shown.',
  close: 'Close',
  by: 'by',
  st_notStarted: 'Queued',
  st_inProgress: 'Running',
  st_cancelling: 'Cancelling',
  st_completed: 'Done',
  st_postponed: 'Postponed',
  rs_succeeded: 'Succeeded',
  rs_partiallySucceeded: 'Partly succeeded',
  rs_failed: 'Failed',
  rs_canceled: 'Canceled',
  rs_skipped: 'Skipped',
  no_groups: 'This project has no variable groups.',
  add_variable: 'Add variable',
  edit_variable: 'Edit variable',
  variable_name: 'Name',
  variable_value: 'Value',
  variable_secret: 'Secret value',
  variable_secret_hint: 'Once saved nobody can read it; it can only be replaced.',
  secret_new_value: 'New value',
  secret_hidden: 'Secret',
  save_title: 'Save this change?',
  save_body: 'Pipelines using this group get the new value on their next run.',
  remove_var_title: 'Delete this variable?',
  remove_var_body: 'Pipelines using this group will no longer get this value.',
  saved: 'Saved',
  key_vault: 'Linked to Key Vault, cannot be edited here',
  variables: 'variables',
  edited: 'updated by',
  activity: 'Recent actions',
  a_run: 'ran',
  a_cancel: 'canceled',
  a_retry: 'retried',
  a_approved: 'approved',
  a_rejected: 'rejected',
  a_set_variable: 'set a variable',
  a_set_secret: 'set a secret',
  a_remove_variable: 'deleted a variable',
  err_generic: 'That did not work.',
  err_auth_failed: 'The token was not accepted. Check its expiry and scopes.',
  err_forbidden: 'This token may not do that.',
  err_not_found: 'Not found. Check the address.',
  err_invalid_url: 'Invalid address. It must start with https.',
  err_blocked_address: 'This server cannot connect to that address.',
  err_unreachable: 'The service could not be reached.',
  err_rejected: 'The service refused the request.',
  err_connection_in_use: 'A sync is using this connection.',
  err_board_already_synced: 'This board is already synced.',
  err_board_read_only: 'You cannot edit this board.',
  err_unknown_type: 'That type does not exist in this project.',
  err_entra_client_required: 'The application ID is required.',
  err_validation_failed: 'Check the fields.',
  err_offline_not_granted: 'Background access is off. The sync has stopped.',
  err_library_read_only: 'A group linked to Key Vault cannot be edited here.',
  err_library_secret_stays: 'A secret cannot become plain text. Delete it and add it again.',
  err_azure_only: 'This is only available on Azure DevOps.',
  status_partial: 'Some items could not be synced',
  status_continuing: 'Import in progress',
  field_title: 'title',
  field_description: 'description',
  field_column: 'column',
  field_status: 'status',
  field_assignee: 'assignee',
  field_priority: 'priority',
  field_dueDate: 'due date',
  field_startDate: 'start date',
  field_labels: 'labels',
  field_points: 'points',
  log_imported: 'Imported to a card',
  log_pushed: 'Sent to the service',
  log_updated_card: 'Card updated',
  log_updated_external: 'Service updated',
  log_external_removed: 'Removed in the service, card archived',
  log_card_removed: 'Card deleted, link ended',
  log_conflict: 'Conflict resolved',
  log_no_status_for_column: 'This item type has no status for that column',
  log_no_transition: 'The workflow does not allow that move',
  ago_now: 'now',
};

type Provider = 'azure' | 'jira';
interface Conn {
  id: string;
  provider: Provider;
  name: string;
  baseUrl: string;
  account: string;
  authKind: 'pat' | 'entra';
}
interface SyncRow {
  id: string;
  connectionId: string;
  boardName: string;
  boardId: string;
  scope: { project: string };
  direction: string;
  enabled: boolean;
  webhookId: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  linked: number;
}
interface State {
  connections: Conn[];
  syncs: SyncRow[];
  entraDefaults: boolean;
}
interface MineItem {
  key: string;
  url: string;
  title: string;
  status: string;
  provider: Provider;
  connection: string;
  dueDate: string | null;
}
interface Meta {
  types: string[];
  statuses: { name: string; category: string; types: string[] }[];
}
interface Column {
  id: string;
  name: string;
  isDone: boolean;
}
interface Run {
  id: number;
  number: string;
  status: string;
  result: string | null;
  branch: string;
  requestedBy: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  url: string | null;
  definitionId: number | null;
  definitionName: string;
}
interface Pipeline {
  id: number;
  name: string;
  folder: string;
  latest: Run | null;
}
interface Approval {
  id: string;
  pipeline: string;
  run: string;
  instructions: string;
}
interface Step {
  id: string;
  name: string;
  state: string;
  result: string | null;
  logId: number | null;
}
interface Job extends Step {
  steps: Step[];
}
interface Stage extends Step {
  identifier: string | null;
  jobs: Job[];
}
interface Variable {
  name: string;
  secret: boolean;
  value: string | null;
}
interface Group {
  id: number;
  name: string;
  description: string;
  editable: boolean;
  modifiedBy: string;
  modifiedOn: string | null;
  variables: Variable[];
}
interface Activity {
  at: string;
  user: string;
  action: string;
  project: string;
  target: string;
}

class RequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const ICONS = {
  sync: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  rocket:
    '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause:
    '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  stop: '<rect width="16" height="16" x="4" y="4" rx="2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  minus: '<path d="M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  alert:
    '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  history:
    '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  arrows:
    '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
} as const;
type IconName = keyof typeof ICONS;

// Simple Icons (CC0).
const BRANDS: Record<Provider, string> = {
  azure:
    'M0 8.877L2.247 5.91l8.405-3.416V.022l7.37 5.393L2.966 8.338v8.225L0 15.707zm24-4.45v14.651l-5.753 4.9-9.303-3.057v3.056l-5.978-7.416 15.057 1.798V5.415z',
  jira: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
};

type Child = Node | string | number | null | undefined | false;

function fill(el: Element, children: Child[]) {
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false)
      el.append(typeof c === 'number' ? String(c) : c);
  }
}

function h(tag: string, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function')
      el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked') (el as HTMLInputElement).checked = !!v;
    else if (k === 'disabled') (el as HTMLButtonElement).disabled = !!v;
    else el.setAttribute(k === 'class_' ? 'class' : k, v === true ? '' : String(v));
  }
  fill(el, children);
  return el;
}

function icon(name: IconName): SVGElement {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'i');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name];
  return s;
}

function logo(provider: Provider) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'brand');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'currentColor');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', BRANDS[provider]);
  s.append(p);
  return h('span', { class_: `tile ${provider}` }, s);
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme.scheme === 'dark');
  document.documentElement.style.setProperty('--accent', theme.accent);
}

const bridge: Bridge = await connect();
const { context } = bridge;
applyTheme(context.theme);
bridge.onTheme(applyTheme);
const dict = context.locale.startsWith('en') ? EN : TR;
const product: Provider = document.documentElement.dataset.product === 'jira' ? 'jira' : 'azure';
const t = (k: Key) => dict[k].replace('{service}', dict[product]);
const tryKey = (k: string, fallback: string) => (k in dict ? dict[k as Key] : fallback);
const known = (code: string) => tryKey(`err_${code.replace(/^plugin_/, '')}`, dict.err_generic);
const messageOf = (err: unknown) =>
  err instanceof RequestError ? known(err.code) : t('err_generic');

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await bridge.getToken();
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'crewhall-installation': context.installationId,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new RequestError(json.error ?? 'generic');
  return json as T;
}

const root = document.getElementById('app')!;
const fail = (err: unknown) => void bridge.toast(messageOf(err), 'error');
const guarded = (fn: () => Promise<unknown> | void) => () => {
  void Promise.resolve().then(fn).catch(fail);
};

const button = (
  label: Child,
  onclick: () => void,
  opts: { kind?: string; ic?: IconName; disabled?: boolean } = {},
) =>
  h(
    'button',
    { class_: `btn ${opts.kind ?? ''}`, type: 'button', onclick, disabled: opts.disabled },
    opts.ic ? icon(opts.ic) : null,
    label,
  );

const field = (label: string, control: HTMLElement, hint?: string) =>
  h('label', { class_: 'f' }, label, control, hint ? h('small', {}, hint) : null);

function select(
  options: [string, string][],
  value: string,
  change: (v: string) => void | Promise<void>,
  placeholder = false,
) {
  const el = h(
    'select',
    {
      onchange: (e: Event) => {
        void Promise.resolve(change((e.target as HTMLSelectElement).value)).catch(fail);
      },
    },
    placeholder && h('option', { value: '' }, t('choose')),
    ...options.map(([v, l]) => h('option', { value: v }, l)),
  ) as HTMLSelectElement;
  el.value = value;
  return el;
}

const empty = (ic: IconName, text: string, action?: Child) =>
  h(
    'div',
    { class_: 'card empty' },
    h('span', { class_: 'tile soft' }, icon(ic)),
    h('p', {}, text),
    action,
  );

const relative = new Intl.RelativeTimeFormat(context.locale, { numeric: 'auto', style: 'short' });
function ago(iso: string | null) {
  if (!iso) return t('never');
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return t('ago_now');
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(s / 3600), 'hour');
  return relative.format(Math.round(s / 86400), 'day');
}

function duration(run: Pick<Run, 'startedAt' | 'finishedAt'>) {
  if (!run.startedAt) return '';
  const s = Math.max(
    0,
    Math.round(
      ((run.finishedAt ? Date.parse(run.finishedAt) : Date.now()) - Date.parse(run.startedAt)) /
        1000,
    ),
  );
  const m = Math.floor(s / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}sa ${m % 60}dk`
        .replace('sa', context.locale.startsWith('en') ? 'h' : 'sa')
        .replace('dk', context.locale.startsWith('en') ? 'm' : 'dk')
    : `${m}:${String(s % 60).padStart(2, '0')}`;
}

const pill = (tone: string, label: string, extra = '') =>
  h('span', { class_: `pill ${tone} ${extra}` }, label);

function toneOf(state: string, result: string | null) {
  if (result === 'succeeded') return 'ok';
  if (result === 'failed') return 'bad';
  if (result === 'partiallySucceeded' || result === 'succeededWithIssues') return 'warn';
  if (result) return '';
  return state === 'inProgress' ? 'info' : '';
}

function runPill(run: Pick<Run, 'status' | 'result'>) {
  const label = run.result
    ? tryKey(`rs_${run.result}`, run.result)
    : tryKey(`st_${run.status}`, run.status);
  return pill(toneOf(run.status, run.result), label, run.status === 'inProgress' ? 'run' : '');
}

function stateDot(s: Pick<Step, 'state' | 'result'>) {
  const tone = toneOf(s.state, s.result);
  const ic: IconName =
    s.result === 'succeeded' || s.result === 'succeededWithIssues'
      ? 'check'
      : s.result === 'failed'
        ? 'x'
        : s.result
          ? 'minus'
          : s.state === 'inProgress'
            ? 'clock'
            : 'minus';
  return h('span', { class_: `dot ${tone || 'idle'}` }, icon(ic));
}

// ---- dialogs ----

function showDialog(build: (close: (v: unknown) => void) => HTMLElement, wide = false) {
  return new Promise<unknown>((resolve) => {
    const d = h('dialog', { class_: wide ? 'wide' : '' }) as HTMLDialogElement;
    const close = (v: unknown) => {
      d.close();
      d.remove();
      resolve(v);
    };
    d.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(null);
    });
    d.append(build(close));
    document.body.append(d);
    d.showModal();
  });
}

const confirmBox = (title: string, body: string, action: string, kind = 'pri') =>
  showDialog((close) =>
    h(
      'div',
      {},
      h('h2', {}, title),
      h('p', {}, body),
      h(
        'div',
        { class_: 'foot' },
        button(t('cancel'), () => close(false), { kind: 'ghost' }),
        button(action, () => close(true), { kind }),
      ),
    ),
  ).then((v) => v === true);

function openLog(title: string, lines: Promise<{ lines: string[]; truncated: boolean }>) {
  const pre = h('pre', { class_: 'log' }, t('loading'));
  const note = h('p', { class_: 'small', hidden: true }, t('log_truncated'));
  lines.then(
    (r) => {
      pre.textContent = r.lines.join('\n') || t('no_log');
      note.hidden = !r.truncated;
    },
    (err: unknown) => {
      pre.textContent = messageOf(err);
    },
  );
  void showDialog(
    (close) =>
      h(
        'div',
        {},
        h('h2', {}, title),
        note,
        pre,
        h(
          'div',
          { class_: 'foot' },
          button(t('close'), () => close(null)),
        ),
      ),
    true,
  );
}

// ---- home card ----

const mineList = (items: MineItem[]) =>
  h(
    'div',
    { class_: 'list' },
    ...items.map((i) =>
      h(
        'div',
        { class_: 'item' },
        logo(i.provider),
        h(
          'div',
          { class_: 'grow' },
          h(
            'a',
            { href: i.url, target: '_blank', rel: 'noopener', class_: 'title ellipsis' },
            i.title,
          ),
          h(
            'span',
            { class_: 'muted small' },
            [i.key, i.connection, i.dueDate].filter(Boolean).join(' · '),
          ),
        ),
        pill('info', i.status),
      ),
    ),
  );

async function renderCard() {
  root.replaceChildren(h('p', { class_: 'muted' }, t('loading')));
  const r = await call<{ items: MineItem[] }>('GET', '/api/mine');
  root.replaceChildren(
    r.items.length ? mineList(r.items.slice(0, 5)) : h('p', { class_: 'muted' }, t('empty_mine')),
  );
  await bridge.resize(document.documentElement.scrollHeight);
}

// ---- shell ----

type Tab = 'syncs' | 'connections' | 'mine' | 'pipelines' | 'library';
const placement = document.documentElement.dataset.placement;
/** Opened from its own item in the left rail: only that section, without the tab strip. */
const single = placement === 'pipelines' || placement === 'library' ? placement : null;
let tab: Tab = single ?? 'syncs';
let state: State = { connections: [], syncs: [], entraDefaults: false };
const content = h('div', { class_: 'stack' });

async function reload() {
  state = await call<State>('GET', '/api/state');
  shell();
}

const azures = () => state.connections.filter((c) => c.provider === 'azure');

const pageHeader = (title: string, subtitle: string) =>
  h('div', { class_: 'top' }, h('h1', {}, title), h('p', { class_: 'muted' }, subtitle));

function drawNeedAzure() {
  content.replaceChildren(
    empty(
      tab === 'pipelines' ? 'rocket' : 'library',
      t('need_azure'),
      button(t('add_connection'), () => content.replaceChildren(connectionForm(true)), {
        kind: 'pri',
        ic: 'plug',
      }),
    ),
  );
}

function shell() {
  if (single) {
    root.replaceChildren(
      pageHeader(
        t(single === 'pipelines' ? 'tab_pipelines' : 'tab_library'),
        t(single === 'pipelines' ? 'pipelines_sub' : 'library_sub'),
      ),
      content,
    );
    stopPolling();
    if (!azures().length) drawNeedAzure();
    else if (single === 'pipelines') void drawPipelines().catch(showError);
    else void drawLibrary().catch(showError);
    return;
  }
  const b = (id: Tab, label: Key, ic: IconName) =>
    h(
      'button',
      {
        class_: tab === id ? 'on' : '',
        type: 'button',
        'aria-pressed': String(tab === id),
        onclick: () => {
          tab = id;
          shell();
        },
      },
      icon(ic),
      t(label),
    );
  const hasAzure = azures().length > 0;
  if (!hasAzure && (tab === 'pipelines' || tab === 'library')) tab = 'syncs';
  root.replaceChildren(
    pageHeader(t(product), t(product === 'jira' ? 'subtitle_jira' : 'subtitle')),
    h(
      'div',
      { class_: 'tabs', role: 'group' },
      b('syncs', 'tab_syncs', 'sync'),
      b('connections', 'tab_connections', 'plug'),
      b('mine', 'tab_mine', 'user'),
      hasAzure ? b('pipelines', 'tab_pipelines', 'rocket') : null,
      hasAzure ? b('library', 'tab_library', 'library') : null,
    ),
    content,
  );
  // Redrawing starts the strip over; on a narrow screen the open tab must stay in view.
  root.querySelector('.tabs .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  stopPolling();
  if (tab === 'connections') drawConnections();
  else if (tab === 'mine') void drawMine().catch(fail);
  else if (tab === 'pipelines') void drawPipelines().catch(showError);
  else if (tab === 'library') void drawLibrary().catch(showError);
  else drawSyncs();
}

const showError = (err: unknown) =>
  content.replaceChildren(h('div', { class_: 'card err' }, messageOf(err)));

// ---- connections ----

function drawConnections() {
  const rows = state.connections.map((c) =>
    h(
      'div',
      { class_: 'card row' },
      logo(c.provider),
      h(
        'div',
        { class_: 'grow' },
        h('h2', { class_: 'ellipsis' }, c.name),
        h('span', { class_: 'muted small ellipsis' }, `${c.account} · ${c.baseUrl}`),
      ),
      pill('', t(c.authKind === 'pat' ? 'via_pat' : 'via_entra'), 'plain hide-sm'),
      button(
        t('remove'),
        guarded(async () => {
          if (
            !(await confirmBox(t('remove_conn_title'), t('remove_conn_body'), t('remove'), 'pri'))
          )
            return;
          await call('DELETE', `/api/connections/${c.id}`);
          await reload();
        }),
        { kind: 'danger' },
      ),
    ),
  );
  content.replaceChildren(...(rows.length ? rows : []), connectionForm(rows.length === 0));
}

function connectionForm(first: boolean) {
  const form = h('div', { class_: 'card', 'data-form': true });
  const provider = product;
  let auth: Conn['authKind'] = 'pat';
  const name = h('input', { maxlength: 80, placeholder: t('name_ph') }) as HTMLInputElement;
  const baseUrl = h('input', { inputmode: 'url' }) as HTMLInputElement;
  const token = h('input', { type: 'password', autocomplete: 'off' }) as HTMLInputElement;
  const email = h('input', { type: 'email' }) as HTMLInputElement;
  const tenant = h('input', {}) as HTMLInputElement;
  const clientId = h('input', {}) as HTMLInputElement;
  const clientSecret = h('input', { type: 'password', autocomplete: 'off' }) as HTMLInputElement;
  const message = h('p', { class_: 'small' });
  const say = (text: string, bad = false) => {
    message.className = `small ${bad ? 'err' : 'muted'}`;
    message.textContent = text;
  };

  const choice = (on: boolean, pick: () => void, lead: Child, title: string, hint: string) =>
    h(
      'button',
      { class_: on ? 'on' : '', type: 'button', onclick: pick },
      lead,
      h('span', {}, title, h('small', {}, hint)),
    );

  const paint = () => {
    const entraFields = auth === 'entra' && !state.entraDefaults;
    form.replaceChildren(
      h(
        'div',
        { class_: 'row' },
        logo(provider),
        h(
          'div',
          { class_: 'grow' },
          h('h2', {}, t(first ? 'add_connection' : 'new_connection')),
          h(
            'span',
            { class_: 'muted small' },
            t(provider === 'azure' ? 'azure_hint' : 'jira_hint'),
          ),
        ),
      ),
      h(
        'div',
        { class_: 'section' },
        h(
          'div',
          { class_: 'stack' },
          provider === 'azure'
            ? h(
                'div',
                { class_: 'choice' },
                choice(
                  auth === 'pat',
                  () => {
                    auth = 'pat';
                    paint();
                  },
                  null,
                  t('auth_pat'),
                  t('auth_pat_hint'),
                ),
                choice(
                  auth === 'entra',
                  () => {
                    auth = 'entra';
                    paint();
                  },
                  null,
                  t('auth_entra'),
                  t('auth_entra_hint'),
                ),
              )
            : null,
          h(
            'div',
            { class_: 'grid' },
            field(t('name'), name),
            field(
              t(provider === 'azure' ? 'base_url_azure' : 'base_url_jira'),
              baseUrl,
              provider === 'azure' ? 'https://dev.azure.com/…' : 'https://….atlassian.net',
            ),
            auth === 'pat' &&
              field(
                t('token'),
                token,
                t(provider === 'azure' ? 'token_azure_hint' : 'token_jira_hint'),
              ),
            provider === 'jira' && field(t('email'), email, t('email_hint')),
            entraFields && field(t('tenant'), tenant, t('optional')),
            entraFields && field(t('client_id'), clientId),
            entraFields && field(t('client_secret'), clientSecret, t('optional')),
          ),
          auth === 'entra' && h('p', { class_: 'muted small' }, t('entra_hint')),
          message,
          h(
            'div',
            { class_: 'actions', style: 'justify-content:flex-end' },
            button(t('connect'), guarded(submit), { kind: 'pri', ic: 'plug' }),
          ),
        ),
      ),
    );
  };

  const submit = async () => {
    say('');
    try {
      if (auth === 'pat') {
        await call('POST', '/api/connections', {
          provider,
          name: name.value,
          baseUrl: baseUrl.value,
          token: token.value,
          ...(provider === 'jira' && email.value ? { email: email.value } : {}),
        });
        await reload();
        return;
      }
      // Opened before the first await, while the click still counts as the person's gesture.
      const popup = window.open('about:blank', '_blank', 'width=520,height=680');
      const start = await call<{ id: string; url: string }>('POST', '/api/oauth/entra', {
        name: name.value,
        baseUrl: baseUrl.value,
        ...(state.entraDefaults
          ? {}
          : {
              ...(tenant.value ? { tenant: tenant.value } : {}),
              clientId: clientId.value,
              ...(clientSecret.value ? { clientSecret: clientSecret.value } : {}),
            }),
      }).catch((err: unknown) => {
        popup?.close();
        throw err;
      });
      if (popup) popup.location.href = start.url;
      else window.open(start.url, '_blank');
      say(t('entra_waiting'));
      for (let i = 0; i < 180; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const r = await call<{ result: string }>('GET', `/api/oauth/${start.id}`);
        if (r.result === 'ok') {
          await reload();
          return;
        }
        if (r.result === 'failed') break;
      }
      say(t('entra_failed'), true);
    } catch (err) {
      say(messageOf(err), true);
    }
  };

  paint();
  return form;
}

// ---- my work ----

async function drawMine() {
  if (!state.connections.length) {
    content.replaceChildren(empty('user', t('none_connected')));
    return;
  }
  content.replaceChildren(h('p', { class_: 'muted' }, t('loading')));
  const r = await call<{ items: MineItem[]; failed: string[] }>('GET', '/api/mine');
  const body: Child[] = [
    r.items.length
      ? h('div', { class_: 'card' }, mineList(r.items))
      : empty('inbox', t('empty_mine')),
    r.failed.length
      ? h('p', { class_: 'err small' }, `${t('failed_connections')}: ${r.failed.join(', ')}`)
      : null,
  ];
  content.replaceChildren(...(body.filter(Boolean) as Node[]));
}

// ---- syncs ----

function syncStatus(s: SyncRow) {
  if (!s.enabled) return pill('', t('paused'));
  if (s.lastError === 'continuing') return pill('info', t('status_continuing'), 'run');
  if (s.lastError)
    return pill(
      s.lastError === 'partial' ? 'warn' : 'bad',
      s.lastError === 'partial' ? t('status_partial') : known(s.lastError),
    );
  return s.webhookId ? pill('ok', t('live')) : pill('info', t('polling'));
}

function logDetail(detail: string) {
  return detail
    .split(', ')
    .map((part) => tryKey(`field_${part}`, part))
    .join(', ');
}

async function fillHistory(target: HTMLElement, id: string) {
  const r = await call<{
    log: { at: string; level: string; code: string; item?: string; detail?: string }[];
  }>('GET', `/api/syncs/${id}/log`);
  target.replaceChildren(
    ...(r.log.length
      ? r.log.map((l) => {
          const code = l.code.startsWith('conflict_') ? 'conflict' : l.code;
          const text = tryKey(`log_${code}`, known(l.code));
          return h(
            'div',
            { class_: `log-row ${l.level}` },
            icon(l.level === 'error' ? 'alert' : l.level === 'conflict' ? 'arrows' : 'check'),
            h(
              'div',
              { class_: 'grow' },
              text,
              l.item ? h('span', { class_: 'muted' }, ` · ${l.item}`) : null,
              l.detail ? h('span', { class_: 'muted' }, ` · ${logDetail(l.detail)}`) : null,
            ),
            h('span', { class_: 'muted small' }, ago(l.at)),
          );
        })
      : [h('p', { class_: 'muted small' }, t('log_empty'))]),
  );
}

function drawSyncs() {
  const rows = state.syncs.map((s) => {
    const conn = state.connections.find((c) => c.id === s.connectionId);
    const history = h('div', { class_: 'divide list', hidden: true, 'data-open': true });
    const dirIcon = s.direction === 'both' ? '⇄' : s.direction === 'to_crewhall' ? '→' : '←';
    return h(
      'div',
      { class_: 'card' },
      h(
        'div',
        { class_: 'row' },
        conn ? logo(conn.provider) : h('span', { class_: 'tile' }, icon('sync')),
        h(
          'div',
          { class_: 'grow' },
          h('h2', { class_: 'ellipsis' }, `${s.boardName} ${dirIcon} ${s.scope.project}`),
          h('span', { class_: 'muted small ellipsis' }, conn?.name ?? ''),
        ),
        syncStatus(s),
      ),
      h(
        'div',
        { class_: 'row wrap between divide' },
        h(
          'div',
          { class_: 'facts' },
          h('span', {}, h('b', {}, s.linked), t('linked')),
          h('span', {}, icon('clock'), `${t('last_run')}: ${ago(s.lastRunAt)}`),
        ),
        h(
          'div',
          { class_: 'actions' },
          button(
            t('run_now'),
            guarded(async () => {
              await call('POST', `/api/syncs/${s.id}/run`);
              await bridge.toast(t('started'));
            }),
            { kind: 'pri', ic: 'sync' },
          ),
          button(
            t(s.enabled ? 'pause' : 'resume'),
            guarded(async () => {
              await call('PATCH', `/api/syncs/${s.id}`, { enabled: !s.enabled });
              await reload();
            }),
            { ic: s.enabled ? 'pause' : 'play' },
          ),
          button(
            t('history'),
            guarded(async () => {
              if (!history.hidden) {
                history.hidden = true;
                return;
              }
              await fillHistory(history, s.id);
              history.hidden = false;
            }),
            { ic: 'history' },
          ),
          button(
            t('remove'),
            guarded(async () => {
              if (!(await confirmBox(t('remove_sync_title'), t('remove_sync_body'), t('remove'))))
                return;
              await call('DELETE', `/api/syncs/${s.id}`);
              await reload();
            }),
            { kind: 'danger' },
          ),
        ),
      ),
      history,
    );
  });
  const add = state.connections.length
    ? button(t('add_sync'), guarded(openSyncForm), { kind: 'pri', ic: 'plus' })
    : button(
        t('add_connection'),
        () => {
          tab = 'connections';
          shell();
        },
        { kind: 'pri', ic: 'plug' },
      );
  content.replaceChildren(
    ...(rows.length
      ? [...rows, h('div', { class_: 'actions' }, add)]
      : [empty('sync', state.connections.length ? t('no_syncs') : t('need_connection'), add)]),
  );
}

function suggestion(column: Column, meta: Meta, index: number, count: number) {
  const name = column.name.toLowerCase();
  const exact = meta.statuses.filter((s) => s.name.toLowerCase() === name);
  if (exact.length) return exact.map((s) => s.name);
  if (column.isDone) return meta.statuses.filter((s) => s.category === 'done').map((s) => s.name);
  if (index === 0) return meta.statuses.filter((s) => s.category === 'todo').map((s) => s.name);
  if (index === count - 2 || index === 1)
    return meta.statuses.filter((s) => s.category === 'doing').map((s) => s.name);
  return [];
}

async function openSyncForm() {
  const boards = await call<{ items: { id: string; name: string; space: string }[] }>(
    'GET',
    '/api/boards',
  );
  const form = h('div', { class_: 'card', 'data-form': true });
  let connection = state.connections[0]!;
  type P = { key: string; name: string };
  let projects = (await call<{ items: P[] }>('GET', `/api/connections/${connection.id}/projects`))
    .items;
  let project = '';
  let meta: Meta | null = null;
  let boardId = '';
  let columns: Column[] = [];
  const types = new Set<string>();
  const map: Record<string, string[]> = {};
  const filter = h('input', {}) as HTMLInputElement;
  const comments = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
  const pushNew = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const message = h('p', { class_: 'err small' });
  let direction = 'both';
  let conflict = 'newest';
  let defaultType = '';

  const suggest = () => {
    if (!meta) return;
    columns.forEach((c, i) => {
      map[c.id] = suggestion(c, meta!, i, columns.length);
    });
  };
  const chip = (label: string, on: boolean, toggle: () => void) =>
    h(
      'button',
      {
        class_: on ? 'chip on' : 'chip',
        type: 'button',
        'aria-pressed': String(on),
        onclick: toggle,
      },
      label,
    );
  const heading = (n: number, label: Key) => h('h2', {}, h('span', { class_: 'num' }, n), t(label));

  const paint = () => {
    form.replaceChildren(
      h(
        'div',
        { class_: 'row between' },
        h('h2', {}, t('new_sync')),
        button(t('cancel'), () => shell(), { kind: 'ghost' }),
      ),
      h(
        'div',
        { class_: 'section' },
        heading(1, 'step_source'),
        h(
          'div',
          { class_: 'grid' },
          field(
            t('connection'),
            select(
              state.connections.map((c) => [c.id, c.name]),
              connection.id,
              async (v) => {
                connection = state.connections.find((c) => c.id === v)!;
                projects = (await call<{ items: P[] }>('GET', `/api/connections/${v}/projects`))
                  .items;
                project = '';
                meta = null;
                paint();
              },
            ),
          ),
          field(
            t('project'),
            select(
              projects.map((p) => [p.key, p.name]),
              project,
              async (v) => {
                project = v;
                meta = v
                  ? await call<Meta>(
                      'GET',
                      `/api/connections/${connection.id}/meta?project=${encodeURIComponent(v)}`,
                    )
                  : null;
                types.clear();
                defaultType = meta?.types[0] ?? '';
                suggest();
                paint();
              },
              true,
            ),
          ),
          field(
            t('board'),
            select(
              boards.items.map((b) => [b.id, `${b.space} / ${b.name}`]),
              boardId,
              async (v) => {
                boardId = v;
                columns = v
                  ? (await call<{ columns: Column[] }>('GET', `/api/boards/${v}`)).columns
                  : [];
                suggest();
                paint();
              },
              true,
            ),
          ),
          field(
            t(connection.provider === 'azure' ? 'filter_azure' : 'filter_jira'),
            filter,
            t('optional'),
          ),
        ),
        meta
          ? h(
              'div',
              { style: 'margin-top:12px' },
              h('h3', {}, t('types')),
              h(
                'div',
                { class_: 'chips' },
                ...meta.types.map((x) =>
                  chip(x, types.has(x), () => {
                    if (types.has(x)) types.delete(x);
                    else types.add(x);
                    paint();
                  }),
                ),
              ),
              h('p', { class_: 'muted small', style: 'margin-top:6px' }, t('types_hint')),
            )
          : null,
      ),
      h(
        'div',
        { class_: 'section' },
        heading(2, 'step_columns'),
        meta && columns.length
          ? h(
              'div',
              {},
              h('p', { class_: 'muted small', style: 'margin-bottom:10px' }, t('column_map_hint')),
              h(
                'div',
                { class_: 'map' },
                ...columns.flatMap((c) => [
                  h('strong', {}, c.name),
                  h(
                    'div',
                    { class_: 'chips' },
                    ...meta!.statuses.map((s) => {
                      const list = map[c.id] ?? [];
                      return chip(s.name, list.includes(s.name), () => {
                        map[c.id] = list.includes(s.name)
                          ? list.filter((x) => x !== s.name)
                          : [...list, s.name];
                        paint();
                      });
                    }),
                  ),
                ]),
              ),
            )
          : h('p', { class_: 'muted small' }, t('pick_first')),
      ),
      h(
        'div',
        { class_: 'section' },
        heading(3, 'step_rules'),
        h(
          'div',
          { class_: 'grid' },
          field(
            t('direction'),
            select(
              [
                ['both', t('dir_both')],
                ['to_crewhall', t('dir_to_crewhall')],
                ['to_external', t('dir_to_external')],
              ],
              direction,
              (v) => {
                direction = v;
              },
            ),
          ),
          field(
            t('conflict'),
            select(
              [
                ['newest', t('conf_newest')],
                ['external', t('conf_external')],
                ['crewhall', t('conf_crewhall')],
              ],
              conflict,
              (v) => {
                conflict = v;
              },
            ),
          ),
          meta
            ? field(
                t('default_type'),
                select(
                  meta.types.map((x) => [x, x]),
                  defaultType,
                  (v) => {
                    defaultType = v;
                  },
                ),
              )
            : null,
        ),
        h(
          'div',
          { style: 'margin-top:10px' },
          h('label', { class_: 'check' }, comments, t('comments')),
          h('label', { class_: 'check' }, pushNew, t('push_new')),
        ),
      ),
      h(
        'div',
        { class_: 'section row between wrap' },
        message,
        button(t('create_sync'), guarded(submit), {
          kind: 'pri',
          ic: 'sync',
          disabled: !project || !boardId,
        }),
      ),
    );
  };

  const submit = async () => {
    message.textContent = '';
    let granted: boolean;
    try {
      granted = (await bridge.offlineAccess('grant')).granted;
    } catch {
      message.textContent = t('consent_unsupported');
      return;
    }
    if (!granted) {
      message.textContent = t('consent_needed');
      return;
    }
    try {
      await call('POST', '/api/syncs', {
        connectionId: connection.id,
        boardId,
        project,
        types: [...types],
        filter: filter.value,
        columnMap: map,
        direction,
        conflict,
        comments: comments.checked,
        pushNewCards: pushNew.checked,
        defaultType,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      await reload();
    } catch (err) {
      message.textContent = messageOf(err);
    }
  };

  paint();
  content.replaceChildren(form);
}

// ---- azure: shared project picker ----

const remember = {
  get(key: string) {
    try {
      return localStorage.getItem(`wi:${key}`) ?? '';
    } catch {
      return '';
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`wi:${key}`, value);
    } catch {
      // A private window keeps nothing; the pickers just start empty.
    }
  },
};

let azureConn = '';
let azureProject = '';
const projectCache = new Map<string, { key: string; name: string }[]>();

function currentAzure() {
  const list = azures();
  const saved = azureConn || remember.get('conn');
  return list.find((c) => c.id === saved) ?? list[0]!;
}

async function pickers(after: () => void) {
  const conn = currentAzure();
  azureConn = conn.id;
  let projects = projectCache.get(conn.id);
  if (!projects) {
    projects = (
      await call<{ items: { key: string; name: string }[] }>(
        'GET',
        `/api/azure/${conn.id}/projects`,
      )
    ).items;
    projectCache.set(conn.id, projects);
  }
  const saved = azureProject || remember.get(`project:${conn.id}`);
  azureProject = projects.some((p) => p.key === saved) ? saved : (projects[0]?.key ?? '');
  const list = azures();
  return {
    conn,
    toolbar: [
      list.length > 1
        ? field(
            t('connection'),
            select(
              list.map((c) => [c.id, c.name]),
              conn.id,
              (v) => {
                azureConn = v;
                azureProject = '';
                remember.set('conn', v);
                after();
              },
            ),
          )
        : null,
      field(
        t('project'),
        select(
          projects.map((p) => [p.key, p.name]),
          azureProject,
          (v) => {
            azureProject = v;
            remember.set(`project:${conn.id}`, v);
            after();
          },
        ),
      ),
    ] as Child[],
  };
}

const qs = () => `project=${encodeURIComponent(azureProject)}`;

async function activityCard() {
  const r = await call<{ items: Activity[] }>('GET', '/api/activity');
  if (!r.items.length) return null;
  return h(
    'div',
    { class_: 'card' },
    h('h2', { style: 'margin-bottom:6px' }, t('activity')),
    h(
      'div',
      { class_: 'list' },
      ...r.items
        .slice(0, 10)
        .map((a) =>
          h(
            'div',
            { class_: 'log-row info' },
            icon('history'),
            h(
              'div',
              { class_: 'grow' },
              h('b', {}, a.user),
              ' ',
              tryKey(`a_${a.action}`, a.action),
              h('span', { class_: 'muted' }, ` · ${a.target}`),
            ),
            h('span', { class_: 'muted small' }, ago(a.at)),
          ),
        ),
    ),
  );
}

// ---- pipelines ----

let pollTimer: ReturnType<typeof setInterval> | null = null;
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
/** Runs change by themselves: refresh unless the person is typing or a dialog is open. */
function pollWhile(draw: () => Promise<void>) {
  stopPolling();
  pollTimer = setInterval(() => {
    if (document.visibilityState !== 'visible' || document.querySelector('dialog')) return;
    if (content.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT')
      return;
    draw().catch(() => undefined);
  }, 10_000);
}

let pipelineSearch = '';

const runMeta = (r: Run) =>
  h(
    'div',
    { class_: 'facts' },
    h('span', {}, icon('branch'), r.branch),
    r.startedAt ? h('span', {}, icon('clock'), duration(r)) : null,
    h('span', {}, ago(r.queuedAt)),
    r.requestedBy ? h('span', { class_: 'hide-sm' }, r.requestedBy) : null,
  );

function runRow(r: Run, onOpen: () => void) {
  return h(
    'button',
    { class_: 'item', type: 'button', onclick: onOpen },
    h(
      'div',
      { class_: 'grow' },
      h(
        'span',
        { class_: 'title ellipsis' },
        r.definitionName ? `${r.definitionName} · ${r.number}` : r.number,
      ),
      runMeta(r),
    ),
    runPill(r),
    icon('chevron'),
  );
}

const startRun = (p: { id: number; name: string }, then: () => void) => async () => {
  const conn = currentAzure();
  const branch = h('input', { placeholder: 'main', autocomplete: 'off' }) as HTMLInputElement;
  const ok = await showDialog((close) =>
    h(
      'div',
      { class_: 'form' },
      h('div', {}, h('h2', {}, t('run_title')), h('p', { style: 'margin:0' }, p.name)),
      field(t('branch'), branch, t('branch_hint')),
      h(
        'div',
        { class_: 'foot' },
        button(t('cancel'), () => close(false), { kind: 'ghost' }),
        button(t('run_pipeline'), () => close(true), { kind: 'pri', ic: 'play' }),
      ),
    ),
  );
  if (ok !== true) return;
  await call('POST', `/api/azure/${conn.id}/pipelines/${p.id}/runs`, {
    project: azureProject,
    name: p.name,
    branch: branch.value,
  });
  await bridge.toast(t('run_started'));
  then();
};

async function drawPipelines() {
  content.replaceChildren(h('p', { class_: 'muted' }, t('loading')));
  const { conn, toolbar } = await pickers(() => void drawPipelines().catch(showError));
  if (!azureProject) {
    content.replaceChildren(empty('rocket', t('choose_project')));
    return;
  }
  const data = await call<{ pipelines: Pipeline[]; active: Run[]; approvals: Approval[] }>(
    'GET',
    `/api/azure/${conn.id}/pipelines?${qs()}`,
  );
  const refresh = () => void drawPipelines().catch(showError);

  const listEl = h('div', { class_: 'list' });
  const paintList = () => {
    const q = pipelineSearch.trim().toLocaleLowerCase(context.locale);
    const shown = data.pipelines.filter(
      (p) => !q || `${p.name} ${p.folder}`.toLocaleLowerCase(context.locale).includes(q),
    );
    listEl.replaceChildren(
      ...(shown.length
        ? shown.map((p) =>
            h(
              'div',
              { class_: 'item' },
              p.latest
                ? stateDot({ state: p.latest.status, result: p.latest.result })
                : h('span', { class_: 'dot idle' }, icon('minus')),
              h(
                'button',
                {
                  class_: 'grow',
                  type: 'button',
                  style:
                    'background:none;border:0;padding:0;font:inherit;color:inherit;text-align:left;cursor:pointer;min-width:0',
                  onclick: guarded(() => drawRuns(p)),
                },
                h('span', { class_: 'title ellipsis' }, p.name),
                p.latest ? runMeta(p.latest) : h('span', { class_: 'muted small' }, t('no_runs')),
              ),
              button(t('run_pipeline'), guarded(startRun(p, refresh)), { ic: 'play' }),
            ),
          )
        : [
            h(
              'p',
              { class_: 'muted', style: 'padding:14px 0' },
              data.pipelines.length ? t('no_match') : t('no_pipelines'),
            ),
          ]),
    );
  };
  paintList();
  const search = h('input', {
    value: pipelineSearch,
    placeholder: t('search_pipelines'),
    oninput: (e: Event) => {
      pipelineSearch = (e.target as HTMLInputElement).value;
      paintList();
    },
  });

  const sections: Child[] = [
    h(
      'div',
      { class_: 'toolbar' },
      ...(toolbar.filter(Boolean) as Node[]),
      h('label', { class_: 'f wide' }, t('search'), search),
      button(t('refresh'), refresh, { ic: 'sync' }),
    ),
    data.approvals.length
      ? h(
          'div',
          { class_: 'card' },
          h('h2', { style: 'margin-bottom:6px' }, t('approvals')),
          h(
            'div',
            { class_: 'list' },
            ...data.approvals.map((a) => {
              const decide = (decision: 'approved' | 'rejected') =>
                guarded(async () => {
                  await call(
                    'POST',
                    `/api/azure/${conn.id}/approvals/${encodeURIComponent(a.id)}`,
                    { project: azureProject, decision, name: a.pipeline },
                  );
                  await bridge.toast(
                    t(decision === 'approved' ? 'approved_toast' : 'rejected_toast'),
                  );
                  refresh();
                });
              return h(
                'div',
                { class_: 'item' },
                h('span', { class_: 'tile soft' }, icon('clock')),
                h(
                  'div',
                  { class_: 'grow' },
                  h('span', { class_: 'title ellipsis' }, a.pipeline),
                  h('span', { class_: 'muted small ellipsis' }, a.instructions || a.run),
                ),
                h(
                  'div',
                  { class_: 'actions' },
                  button(t('reject'), decide('rejected'), { kind: 'danger' }),
                  button(t('approve'), decide('approved'), { kind: 'pri', ic: 'check' }),
                ),
              );
            }),
          ),
        )
      : null,
    data.active.length
      ? h(
          'div',
          { class_: 'card' },
          h('h2', { style: 'margin-bottom:6px' }, t('active_runs')),
          h(
            'div',
            { class_: 'list' },
            ...data.active.map((r) =>
              runRow(
                r,
                guarded(() => drawRun(r, () => void drawPipelines().catch(showError))),
              ),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class_: 'card' },
      h('h2', { style: 'margin-bottom:6px' }, t('all_pipelines')),
      listEl,
    ),
    await activityCard().catch(() => null),
  ];
  content.replaceChildren(...(sections.filter(Boolean) as Node[]));
  pollWhile(drawPipelines);
}

const crumbs = (...parts: [string, (() => void) | null][]) =>
  h(
    'div',
    { class_: 'crumb' },
    ...parts.flatMap(([label, go], i) => [
      i ? icon('chevron') : null,
      go ? h('button', { type: 'button', onclick: go }, label) : h('span', {}, label),
    ]),
  );

async function drawRuns(p: Pick<Pipeline, 'id' | 'name'>) {
  stopPolling();
  const conn = currentAzure();
  const back = () => void drawPipelines().catch(showError);
  const r = await call<{ items: Run[] }>(
    'GET',
    `/api/azure/${conn.id}/pipelines/${p.id}/runs?${qs()}`,
  );
  const redraw = () => void drawRuns(p).catch(showError);
  content.replaceChildren(
    crumbs([t('all_pipelines'), back], [p.name, null]),
    h(
      'div',
      { class_: 'card' },
      h(
        'div',
        { class_: 'row between', style: 'margin-bottom:6px' },
        h('h2', {}, t('runs')),
        button(t('run_pipeline'), guarded(startRun(p, redraw)), { kind: 'pri', ic: 'play' }),
      ),
      r.items.length
        ? h(
            'div',
            { class_: 'list' },
            ...r.items.map((x) =>
              runRow(
                { ...x, definitionName: '' },
                guarded(() => drawRun(x, redraw)),
              ),
            ),
          )
        : h('p', { class_: 'muted' }, t('no_runs')),
    ),
  );
  pollWhile(() => drawRuns(p));
}

async function drawRun(run: Run, back: () => void) {
  stopPolling();
  const conn = currentAzure();
  const { stages } = await call<{ stages: Stage[] }>(
    'GET',
    `/api/azure/${conn.id}/runs/${run.id}/timeline?${qs()}`,
  );
  const redraw = () => void drawRun(run, back).catch(showError);
  const openable = (s: Step) => {
    if (s.logId === null) return;
    const logId = s.logId;
    openLog(s.name, call(`GET`, `/api/azure/${conn.id}/runs/${run.id}/logs/${logId}?${qs()}`));
  };
  const active = run.status === 'inProgress' || run.status === 'notStarted';
  content.replaceChildren(
    crumbs(
      [t('all_pipelines'), () => void drawPipelines().catch(showError)],
      [run.definitionName || run.number, back],
      [run.number, null],
    ),
    h(
      'div',
      { class_: 'card' },
      h(
        'div',
        { class_: 'row wrap between' },
        h(
          'div',
          { class_: 'grow' },
          h('h2', {}, `${run.definitionName} ${run.number}`),
          runMeta(run),
        ),
        runPill(run),
        h(
          'div',
          { class_: 'actions' },
          active
            ? button(
                t('cancel_run'),
                guarded(async () => {
                  if (
                    !(await confirmBox(
                      t('cancel_run_title'),
                      t('cancel_run_body'),
                      t('cancel_run'),
                    ))
                  )
                    return;
                  await call('POST', `/api/azure/${conn.id}/runs/${run.id}/cancel`, {
                    project: azureProject,
                    name: `${run.definitionName} ${run.number}`,
                  });
                  redraw();
                }),
                { kind: 'danger', ic: 'stop' },
              )
            : null,
          run.url
            ? h(
                'a',
                { class_: 'btn', href: run.url, target: '_blank', rel: 'noopener' },
                icon('external'),
                t('open_azure'),
              )
            : null,
        ),
      ),
      h(
        'div',
        { class_: 'divide list' },
        ...(stages.length
          ? stages.map((s) =>
              h(
                'div',
                { class_: 'stage' },
                h(
                  'div',
                  { class_: 'stage-head' },
                  stateDot(s),
                  h('b', { class_: 'grow' }, s.name),
                  s.result === 'failed' && s.identifier
                    ? button(
                        t('retry_stage'),
                        guarded(async () => {
                          await call('POST', `/api/azure/${conn.id}/runs/${run.id}/retry`, {
                            project: azureProject,
                            stage: s.identifier,
                            name: `${run.definitionName} ${run.number}`,
                          });
                          await bridge.toast(t('retried'));
                          redraw();
                        }),
                        { ic: 'sync' },
                      )
                    : null,
                ),
                h(
                  'div',
                  { class_: 'steps' },
                  ...s.jobs.flatMap((j) => [
                    h(
                      'button',
                      { type: 'button', onclick: () => openable(j) },
                      stateDot(j),
                      j.name,
                    ),
                    ...j.steps
                      .filter((x) => x.result === 'failed' || x.state === 'inProgress')
                      .map((x) =>
                        h(
                          'button',
                          { type: 'button', style: 'margin-left:26px', onclick: () => openable(x) },
                          stateDot(x),
                          x.name,
                        ),
                      ),
                  ]),
                ),
              ),
            )
          : [h('p', { class_: 'muted', style: 'padding-top:6px' }, t('no_stages'))]),
      ),
    ),
  );
  if (active) pollWhile(() => drawRun(run, back));
}

// ---- library ----

const openGroups = new Set<number>();

async function drawLibrary() {
  content.replaceChildren(h('p', { class_: 'muted' }, t('loading')));
  const { conn, toolbar } = await pickers(() => void drawLibrary().catch(showError));
  if (!azureProject) {
    content.replaceChildren(empty('library', t('choose_project')));
    return;
  }
  const { items } = await call<{ items: Group[] }>('GET', `/api/azure/${conn.id}/library?${qs()}`);
  const redraw = () => void drawLibrary().catch(showError);
  const base = `/api/azure/${conn.id}/library`;

  const editVariable = (g: Group, v: Variable | null) => async () => {
    const name = h('input', {
      value: v?.name ?? '',
      disabled: !!v,
      autocomplete: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;
    const secretBox = h('input', {
      type: 'checkbox',
      checked: v?.secret ?? false,
      disabled: v?.secret ?? false,
    }) as HTMLInputElement;
    const value = h(v?.secret ? 'input' : 'textarea', {
      value: v?.value ?? '',
      autocomplete: 'off',
      spellcheck: 'false',
      rows: 3,
      ...(v?.secret ? { type: 'password' } : {}),
    }) as HTMLInputElement;
    const message = h('p', { class_: 'err small', style: 'margin:0' });
    await showDialog((close) =>
      h(
        'div',
        { class_: 'form' },
        h(
          'div',
          {},
          h('h2', {}, t(v ? 'edit_variable' : 'add_variable')),
          h('p', { style: 'margin:0' }, g.name),
        ),
        field(t('variable_name'), name),
        field(t(v?.secret ? 'secret_new_value' : 'variable_value'), value),
        h('label', { class_: 'check' }, secretBox, t('variable_secret')),
        h('p', { class_: 'muted small', style: 'margin:0' }, t('variable_secret_hint')),
        message,
        h(
          'div',
          { class_: 'foot' },
          button(t('cancel'), () => close(null), { kind: 'ghost' }),
          button(
            t('save'),
            () => {
              void (async () => {
                // A wrong value breaks the next deployment: one more look before it is written.
                const body = `${g.name} · ${name.value}. ${t('save_body')}`;
                if (!(await confirmBox(t('save_title'), body, t('save')))) return;
                try {
                  await call('PUT', `${base}/${g.id}/variables`, {
                    project: azureProject,
                    name: name.value,
                    value: value.value,
                    secret: secretBox.checked,
                  });
                  close(true);
                  void bridge.toast(t('saved'));
                  redraw();
                } catch (err) {
                  message.textContent = messageOf(err);
                }
              })();
            },
            { kind: 'pri' },
          ),
        ),
      ),
    );
  };

  const groups = items.map((g) => {
    const open = openGroups.has(g.id);
    const toggle = () => {
      if (open) openGroups.delete(g.id);
      else openGroups.add(g.id);
      redraw();
    };
    return h(
      'div',
      { class_: 'card' },
      h(
        'button',
        {
          class_: 'item',
          type: 'button',
          style: 'padding:0;border:0',
          'aria-expanded': String(open),
          onclick: toggle,
        },
        h('span', { class_: 'tile soft' }, icon('library')),
        h(
          'div',
          { class_: 'grow' },
          h('span', { class_: 'title ellipsis' }, g.name),
          h(
            'span',
            { class_: 'muted small ellipsis' },
            [
              `${g.variables.length} ${t('variables')}`,
              g.modifiedBy ? `${t('edited')}: ${g.modifiedBy}` : '',
              g.modifiedOn ? ago(g.modifiedOn) : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
        ),
        g.editable ? null : pill('', 'Key Vault', 'plain'),
        icon('chevron'),
      ),
      open
        ? h(
            'div',
            { class_: 'divide' },
            g.editable
              ? null
              : h('p', { class_: 'muted small', style: 'margin-bottom:8px' }, t('key_vault')),
            h(
              'div',
              { class_: 'table-scroll' },
              h(
                'table',
                {},
                h(
                  'thead',
                  {},
                  h(
                    'tr',
                    {},
                    h('th', {}, t('variable_name')),
                    h('th', {}, t('variable_value')),
                    g.editable ? h('th', {}) : null,
                  ),
                ),
                h(
                  'tbody',
                  {},
                  ...g.variables.map((v) =>
                    h(
                      'tr',
                      {},
                      h('td', { class_: 'mono' }, v.name),
                      h(
                        'td',
                        { class_: 'value' },
                        v.secret
                          ? h('span', { class_: 'secret' }, icon('lock'), t('secret_hidden'))
                          : h('span', { class_: 'mono' }, v.value ?? ''),
                      ),
                      g.editable
                        ? h(
                            'td',
                            { style: 'width:1%;white-space:nowrap' },
                            h(
                              'div',
                              { class_: 'actions', style: 'flex-wrap:nowrap' },
                              h(
                                'button',
                                {
                                  class_: 'btn ghost icon',
                                  type: 'button',
                                  'aria-label': `${t('edit_variable')}: ${v.name}`,
                                  onclick: guarded(editVariable(g, v)),
                                },
                                icon('pencil'),
                              ),
                              h(
                                'button',
                                {
                                  class_: 'btn danger icon',
                                  type: 'button',
                                  'aria-label': `${t('remove')}: ${v.name}`,
                                  onclick: guarded(async () => {
                                    if (
                                      !(await confirmBox(
                                        t('remove_var_title'),
                                        `${v.name}. ${t('remove_var_body')}`,
                                        t('remove'),
                                      ))
                                    )
                                      return;
                                    await call(
                                      'DELETE',
                                      `${base}/${g.id}/variables/${encodeURIComponent(v.name)}?${qs()}`,
                                    );
                                    await bridge.toast(t('saved'));
                                    redraw();
                                  }),
                                },
                                icon('trash'),
                              ),
                            ),
                          )
                        : null,
                    ),
                  ),
                ),
              ),
            ),
            g.editable
              ? h(
                  'div',
                  { class_: 'actions', style: 'margin-top:10px' },
                  button(t('add_variable'), guarded(editVariable(g, null)), { ic: 'plus' }),
                )
              : null,
          )
        : null,
    );
  });

  const sections: Child[] = [
    h('div', { class_: 'toolbar' }, ...(toolbar.filter(Boolean) as Node[])),
    ...(groups.length ? groups : [empty('library', t('no_groups'))]),
    await activityCard().catch(() => null),
  ];
  content.replaceChildren(...(sections.filter(Boolean) as Node[]));
}

// ---- start ----

if (document.documentElement.dataset.placement === 'card') {
  await renderCard().catch(() => {
    root.replaceChildren(h('p', { class_: 'muted' }, t('none_connected')));
  });
} else {
  // Syncs run on the server; the list follows them unless someone is busy with a form or history.
  setInterval(() => {
    if (
      tab !== 'syncs' ||
      document.visibilityState !== 'visible' ||
      document.querySelector('dialog')
    )
      return;
    if (content.querySelector('[data-form], [data-open]:not([hidden])')) return;
    reload().catch(() => undefined);
  }, 5_000);
  await reload().catch((err: unknown) => {
    root.replaceChildren(
      h('p', { class_: 'err' }, messageOf(err)),
      h(
        'button',
        { class_: 'btn', type: 'button', onclick: () => void reload().catch(fail) },
        t('retry'),
      ),
    );
  });
}
