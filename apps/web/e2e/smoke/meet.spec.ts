import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { BUGRA, ELIF, REAL, secondSession, signIn, signInWithForm } from './support';

/**
 * Meetings on a real LiveKit server (design 07, 13.12). Real mode only: needs the api with
 * LIVEKIT_* set and LiveKit running (docs/contracts/meet-calistirma.md). Skipped in mock mode,
 * with E2E_MEET=0, and when the api answers meet_unavailable (no LiveKit).
 *
 * Chromium gets a fake camera, microphone and screen, and accepts the permission prompts.
 * Buğra starts a meeting from the direct chat with Elif, Elif joins as an invitee, a guest
 * knocks through the guest link and is let in; then mic/camera, hand, screen share, the
 * recording, ending for everybody and the chat lines. With egress running (MEET_EGRESS_ENABLED)
 * the recording is started and stopped, lands in Drive and is probed with ffprobe (duration,
 * codecs); without egress the dialog must say it cannot record.
 */
test.skip(!REAL || process.env.E2E_MEET === '0', 'meet smoke needs the real api and LiveKit');
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});
test.setTimeout(240_000);

/** JSON from the api with the page's session (cookies stay in the browser). */
function apiGet<T>(page: Page, url: string): Promise<T> {
  return page.evaluate(async (u) => {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`${u}: ${res.status}`);
    return (await res.json()) as T;
  }, url);
}

interface Probe {
  format: { duration: string };
  streams: { codec_type: string; codec_name: string }[];
}

/** ffprobe of a downloaded file; null when ffprobe is not installed (the step is noted). */
function ffprobe(file: string): Probe | null {
  const run = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,codec_name',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  if (run.error) return null;
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as Probe;
}

interface Pub {
  source: string;
  kind: string;
  subscribed: boolean;
  muted: boolean;
}
interface Remote {
  identity: string;
  name: string;
  hand: string;
  tracks: Pub[];
}

/** Remote participants as this page's LiveKit room sees them (dev hook in room/context.tsx). */
function remotes(page: Page): Promise<Remote[] | null> {
  return page.evaluate(() => {
    interface LkPub {
      source: string;
      kind: string;
      isSubscribed: boolean;
      isMuted: boolean;
    }
    interface LkParticipant {
      identity: string;
      name?: string;
      attributes: Record<string, string>;
      trackPublications: Map<string, LkPub>;
    }
    const room = (window as { __crewhallRoom?: { remoteParticipants: Map<string, LkParticipant> } })
      .__crewhallRoom;
    if (!room) return null;
    return [...room.remoteParticipants.values()].map((p) => ({
      identity: p.identity,
      name: p.name ?? '',
      hand: p.attributes.hand ?? '',
      tracks: [...p.trackPublications.values()].map((t) => ({
        source: t.source,
        kind: t.kind,
        subscribed: t.isSubscribed,
        muted: t.isMuted,
      })),
    }));
  });
}

/** Polls until the remote named `name` matches `check` on `page`. */
async function expectRemote(page: Page, name: RegExp, check: (r: Remote) => boolean) {
  let last: Remote[] | null = null;
  try {
    await expect
      .poll(
        async () => {
          last = await remotes(page);
          const r = last?.find((x) => name.test(x.name));
          return r ? check(r) : false;
        },
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true);
  } catch (e) {
    // Say what the room looked like: who is there and which tracks arrived.
    throw new Error(`remote ${name} on ${page.url()}: ${JSON.stringify(last)}`, { cause: e });
  }
}

const track = (r: Remote, source: string) => r.tracks.find((t) => t.source === source);
const live = (r: Remote, source: string) => {
  const t = track(r, source);
  return Boolean(t?.subscribed && !t.muted);
};

/**
 * A meeting tied to the open chat, as "Toplantı başlat" makes for space chats (direct chats
 * call instead, H7): created through the api, then its room is opened.
 */
async function meetingFromChat(page: Page) {
  const conversationId = new URL(page.url()).pathname.split('/').pop()!;
  const slug = await page.evaluate(async (id) => {
    const res = await fetch('/api/v1/meet/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'instant', conversationId: id }),
    });
    return ((await res.json()) as { slug: string }).slug;
  }, conversationId);
  await page.goto(`/meetings/room/${slug}`);
}

/** The waiting room has the same mic and camera buttons; only the room has "Ayrıl". */
const inRoom = (p: Page) => p.getByRole('button', { name: 'Ayrıl' });
const micOff = 'Mikrofonu kapat (Ctrl D)';
const micOn = 'Mikrofonu aç (Ctrl D)';
const camOff = 'Kamerayı kapat (Ctrl E)';
const camOn = 'Kamerayı aç (Ctrl E)';

test('two members and a guest meet on LiveKit', async ({ page, browser }) => {
  await signIn(page, BUGRA);

  // Buğra starts a meeting tied to the direct chat with Elif (the header button calls now, H7).
  await page.goto('/chat');
  await page.getByRole('link', { name: /Elif Yıldız/ }).click();
  const chatPath = new URL(page.url()).pathname;
  await meetingFromChat(page);
  await expect(page).toHaveURL(/\/meetings\/room\//);
  const roomPath = new URL(page.url()).pathname;

  // Waiting room (camera preview, devices), then the room.
  await expect(page.getByText('Katılmak üzeresin')).toBeVisible();
  await page.getByRole('button', { name: 'Katıl', exact: true }).click();
  const unavailable = page.getByText('Toplantı sunucusuna şu an ulaşılamıyor');
  await expect(inRoom(page).or(unavailable)).toBeVisible({
    timeout: 30_000,
  });
  test.skip(await unavailable.isVisible(), 'LiveKit is not configured on this api');

  // Elif was invited with the chat: she goes straight from the waiting room into the room.
  const elif = await secondSession(browser, page, ELIF);
  await elif.page.goto(roomPath);
  await elif.page.getByRole('button', { name: 'Katıl', exact: true }).click();
  await expect(inRoom(elif.page)).toBeVisible({ timeout: 30_000 });

  // Both receive the other's camera and microphone.
  await expectRemote(page, /Elif/, (r) => live(r, 'camera') && live(r, 'microphone'));
  await expectRemote(elif.page, /Ahmet/, (r) => live(r, 'camera') && live(r, 'microphone'));

  // Mic and camera off and on again, seen from Elif's side.
  await page.getByRole('button', { name: micOff }).click();
  await expectRemote(elif.page, /Ahmet/, (r) => track(r, 'microphone')?.muted !== false);
  await page.getByRole('button', { name: micOn }).click();
  await expectRemote(elif.page, /Ahmet/, (r) => live(r, 'microphone'));
  await page.getByRole('button', { name: camOff }).click();
  await expectRemote(elif.page, /Ahmet/, (r) => !live(r, 'camera'));
  await page.getByRole('button', { name: camOn }).click();
  await expectRemote(elif.page, /Ahmet/, (r) => live(r, 'camera'));

  // Elif raises her hand; Buğra sees it in the queue.
  await elif.page.getByRole('button', { name: 'El kaldır' }).click();
  await elif.page
    .getByRole('dialog')
    .getByRole('button', { name: /El kaldır/ })
    .click();
  await expectRemote(page, /Elif/, (r) => r.hand !== '');
  await expect(page.getByText('1. sırada').first()).toBeVisible();

  // Screen share (the fake capture source): Elif receives it.
  await page.getByRole('button', { name: 'Ekran paylaş' }).click();
  await expectRemote(elif.page, /Ahmet/, (r) => live(r, 'screen_share'));
  await page.getByRole('button', { name: 'Paylaşımı durdur' }).click();
  await expectRemote(elif.page, /Ahmet/, (r) => !track(r, 'screen_share'));

  // Guests: allow them on the link (lobby stays on), a guest knocks and is let in.
  await page.getByRole('button', { name: 'Katılımcılar' }).click();
  await page.getByRole('button', { name: 'Davet et' }).click();
  const invite = page.getByRole('dialog', { name: 'Kişi davet et' });
  // The chat's meeting room is reused across runs: guests may already be allowed.
  const guestSwitch = invite.getByRole('switch', { name: /Misafirler linkle katılabilir/ });
  if (!(await guestSwitch.isChecked())) await guestSwitch.click();
  await expect(guestSwitch).toBeChecked();
  const lobbySwitch = invite.getByRole('switch', { name: /bekleme salonunda onay beklesin/ });
  if (!(await lobbySwitch.isChecked())) await lobbySwitch.click();
  await expect(lobbySwitch).toBeChecked();
  const guestUrl = await invite.getByRole('textbox').first().inputValue();
  await page.keyboard.press('Escape');

  // No session: the config's storageState (Buğra) would otherwise apply to new contexts too.
  const guestContext = await browser.newContext({
    locale: 'tr-TR',
    storageState: { cookies: [], origins: [] },
  });
  const guest = await guestContext.newPage();
  await guest.goto(new URL(guestUrl).pathname);
  await expect(guest.getByText('Toplantıya davet edildin')).toBeVisible();
  await guest.getByLabel('Adın').fill('Deneme Misafir');
  await guest.getByRole('button', { name: 'Katılma isteği gönder' }).click();
  await expect(
    guest.getByRole('heading', { name: 'Toplantı sahibinin onayı bekleniyor' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'İçeri al' }).first().click();
  await expect(inRoom(guest)).toBeVisible({ timeout: 30_000 });
  await expectRemote(page, /Deneme Misafir/, (r) => live(r, 'camera'));
  await expectRemote(guest, /Ahmet/, (r) => live(r, 'camera'));

  // Recording: without egress the dialog says so and the start button stays off.
  await page.getByRole('button', { name: 'Kaydı başlat' }).click();
  const record = page.getByRole('dialog', { name: 'Kaydı başlat?' });
  await expect(record).toBeVisible();
  const startRecording = record.getByRole('button', { name: 'Kaydı başlat' });
  const noEgress = record.getByText('Kayıt şu an başlatılamıyor');
  // The button stays off while the target loads; then either egress is off or it turns on.
  await expect
    .poll(async () => (await noEgress.isVisible()) || (await startRecording.isEnabled()))
    .toBe(true);
  const recorded = !(await noEgress.isVisible());
  if (!recorded) {
    await expect(startRecording).toBeDisabled();
    await record.getByRole('button', { name: 'Vazgeç' }).click();
  } else {
    // Egress records a few seconds; stopping uploads to S3, egress_ended → recording.ingest.
    await startRecording.click();
    const stopRecording = page.getByRole('button', { name: 'Kaydı durdur' });
    await expect(stopRecording).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Kayıt başladı · herkese bildirildi').first()).toBeVisible();
    await page.waitForTimeout(8_000);
    await stopRecording.click();
    await expect(page.getByRole('button', { name: 'Kaydı başlat' })).toBeVisible({
      timeout: 30_000,
    });

    // Ready: a Drive file in "Toplantı kayıtları".
    const slug = roomPath.split('/').pop()!;
    const meeting = await apiGet<{ id: string }>(page, `/api/v1/meet/links/${slug}/meeting`);
    interface Rec {
      status: string;
      nodeId: string | null;
      fileName: string | null;
      durationSeconds: number | null;
      startedAt: string;
    }
    let rec: Rec | undefined;
    await expect
      .poll(
        async () => {
          const { items } = await apiGet<{ items: Rec[] }>(
            page,
            `/api/v1/meet/meetings/${meeting.id}/recordings`,
          );
          rec = items.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
          return rec?.status;
        },
        { timeout: 120_000, intervals: [1000, 2000] },
      )
      .toBe('ready');
    expect(rec!.nodeId).toBeTruthy();
    expect(rec!.fileName).toMatch(/.mp4$/);

    // The file plays: download it through Drive and ask ffprobe.
    const { url } = await apiGet<{ url: string }>(
      page,
      `/api/v1/nodes/${rec!.nodeId}/download-url`,
    );
    const res = await fetch(url);
    expect(res.ok).toBe(true);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'meet-rec-')), rec!.fileName!);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const probe = ffprobe(file);
    if (probe) {
      test.info().annotations.push({
        type: 'recording',
        description: `${probe.format.duration} s · ${probe.streams.map((x) => x.codec_name).join(', ')}`,
      });
      expect(Number(probe.format.duration)).toBeGreaterThan(4);
      const codecs = probe.streams.map((x) => `${x.codec_type}:${x.codec_name}`);
      expect(codecs).toContain('video:h264');
      expect(codecs.some((c) => c.startsWith('audio:'))).toBe(true);
    } else {
      test
        .info()
        .annotations.push({ type: 'note', description: 'ffprobe not installed: not probed' });
    }
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

  // Buğra ends it for everybody; Elif lands on the summary, the guest sees it ended.
  await page.getByRole('button', { name: 'Ayrıl' }).click();
  await page.getByRole('menuitem', { name: 'Herkes için bitir' }).click();
  await expect(elif.page).toHaveURL(/\/meetings\/summary\//, { timeout: 30_000 });
  await expect(guest.getByText('Toplantı herkes için bitirildi.')).toBeVisible({
    timeout: 30_000,
  });

  // The direct chat got the meeting lines (LiveKit webhooks → api).
  await page.goto(chatPath);
  const log = page.getByRole('log');
  await expect(log.getByText(/toplantı başlattı/).last()).toBeVisible({ timeout: 30_000 });
  await expect(log.getByText(/Toplantı bitti/).last()).toBeVisible({ timeout: 30_000 });
  if (recorded) {
    await expect(log.getByText(/Toplantı kaydı hazır/).last()).toBeVisible();
  }

  await guestContext.close();
  await elif.context.close();
});

/**
 * The app opened by LAN address from another device. Plain http is not a secure context: no
 * camera or microphone (and no crypto.randomUUID), so the meeting starts and Buğra listens.
 * With the https dev server (VITE_DEV_HTTPS=1) everything works, LiveKit through /livekit.
 * Set E2E_LAN_URL (http://<LAN IP>:<web port>) and E2E_HTTPS_URL (https://<LAN IP>:<port>).
 */
async function lanSession(browser: Browser, baseURL: string) {
  const context = await browser.newContext({
    baseURL,
    locale: 'tr-TR',
    viewport: { width: 1280, height: 820 },
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await signInWithForm(page, BUGRA);
  await page.goto('/chat');
  await page.getByRole('link', { name: /Elif Yıldız/ }).click();
  await meetingFromChat(page);
  await expect(page).toHaveURL(/\/meetings\/room\//);
  return { context, page, roomPath: new URL(page.url()).pathname };
}

async function elifJoins(browser: Browser, from: Page, roomPath: string) {
  const elif = await secondSession(browser, from, ELIF);
  await elif.page.goto(roomPath);
  await elif.page.getByRole('button', { name: 'Katıl', exact: true }).click();
  await expect(inRoom(elif.page)).toBeVisible({ timeout: 30_000 });
  return elif;
}

async function endForAll(page: Page) {
  await page.getByRole('button', { name: 'Ayrıl' }).click();
  await page.getByRole('menuitem', { name: 'Herkes için bitir' }).click();
}

test('plain http on the LAN: the meeting starts and the caller listens', async ({ browser }) => {
  const lan = process.env.E2E_LAN_URL;
  test.skip(!lan, 'set E2E_LAN_URL to the web server by LAN address');
  const bugra = await lanSession(browser, lan!);
  await expect(
    bugra.page.getByText('Kamera ve mikrofon için güvenli bağlantı gerekiyor'),
  ).toBeVisible();
  await bugra.page.getByRole('button', { name: 'Katıl', exact: true }).click();
  await expect(inRoom(bugra.page)).toBeVisible({ timeout: 30_000 });
  const needsHttps = 'Kamera ve mikrofon için güvenli bağlantı (https) gerekiyor';
  await expect(bugra.page.getByRole('button', { name: needsHttps }).first()).toBeDisabled();

  const elif = await elifJoins(browser, bugra.page, bugra.roomPath);
  // Buğra hears and sees Elif; Elif sees Buğra without tracks.
  await expectRemote(bugra.page, /Elif/, (r) => live(r, 'camera') && live(r, 'microphone'));
  await expectRemote(elif.page, /Ahmet/, (r) => !track(r, 'camera') && !track(r, 'microphone'));

  await endForAll(bugra.page);
  await elif.context.close();
  await bugra.context.close();
});

test('https dev server on the LAN: camera and microphone work', async ({ browser }) => {
  const https = process.env.E2E_HTTPS_URL;
  test.skip(!https, 'set E2E_HTTPS_URL to the https dev server (VITE_DEV_HTTPS=1)');
  const bugra = await lanSession(browser, https!);
  await bugra.page.getByRole('button', { name: 'Katıl', exact: true }).click();
  await expect(inRoom(bugra.page)).toBeVisible({ timeout: 30_000 });
  await expect(bugra.page.getByRole('button', { name: micOff })).toBeEnabled();

  const elif = await elifJoins(browser, bugra.page, bugra.roomPath);
  await expectRemote(elif.page, /Ahmet/, (r) => live(r, 'camera') && live(r, 'microphone'));
  await expectRemote(bugra.page, /Elif/, (r) => live(r, 'camera') && live(r, 'microphone'));

  await endForAll(bugra.page);
  await elif.context.close();
  await bugra.context.close();
});

test('a blocked media path is explained, with ICE state and a retry (H9)', async ({ page }) => {
  // TURN-only ICE on a LiveKit without TURN: signalling connects, media never does.
  await page.addInitScript(() => localStorage.setItem('crewhall.dev.iceRelayOnly', '1'));
  await signIn(page, BUGRA);
  await page.goto('/chat');
  await page.getByRole('link', { name: /Elif Yıldız/ }).click();
  await meetingFromChat(page);
  await page.getByRole('button', { name: 'Katıl', exact: true }).click();
  const unavailable = page.getByText('Toplantı sunucusuna şu an ulaşılamıyor');
  await expect(inRoom(page).or(unavailable)).toBeVisible({ timeout: 30_000 });
  test.skip(await unavailable.isVisible(), 'LiveKit is not configured on this api');

  // Either the room stays open and warns (banner with ICE state), or it never got in and the
  // page says so; both offer a retry, and a retry on the same blocked network warns again.
  const title = 'Ses ve görüntü sunucuya ulaşamıyor';
  const banner = page.getByRole('alert').filter({ hasText: title });
  const failed = page.getByText(title);
  await expect(banner.or(failed).first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText('UDP 50000-60000').first()).toBeVisible();
  if (await banner.isVisible()) {
    await expect(banner).toContainText(/Yayın: \w+ · Alış: \w+/);
    await banner.getByRole('button', { name: 'Yeniden dene' }).click();
    await expect(banner).toBeVisible({ timeout: 45_000 });
    await endForAll(page);
  } else {
    await page.getByRole('button', { name: 'Yeniden dene' }).click();
    await page.getByRole('button', { name: 'Katıl', exact: true }).click();
    await expect(failed.first()).toBeVisible({ timeout: 45_000 });
  }
});

test('a space viewer is told why they cannot speak and can ask for the floor (H9)', async ({
  page,
  browser,
}) => {
  // Elif (Dumpapp editor) opens a Dumpapp meeting; the support guest is a Dumpapp viewer.
  const elif = await secondSession(browser, page, ELIF);
  const slug = await elif.page.evaluate(async () => {
    const spaces = (await (await fetch('/api/v1/spaces')).json()) as {
      items: { id: string; name: string }[];
    };
    const spaceId = spaces.items.find((s) => s.name === 'Dumpapp')!.id;
    const res = await fetch('/api/v1/meet/meetings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'instant', title: 'Dumpapp destek', spaceId }),
    });
    return ((await res.json()) as { slug: string }).slug;
  });

  const context = await browser.newContext({
    locale: 'tr-TR',
    viewport: { width: 1280, height: 820 },
    storageState: { cookies: [], origins: [] },
  });
  const viewer = await context.newPage();
  await viewer.goto('/login');
  await viewer.getByLabel('E-posta').fill('destek@dumpapp.io');
  await viewer.getByLabel('Şifre', { exact: true }).fill(BUGRA.password);
  await viewer.getByRole('button', { name: 'Giriş yap', exact: true }).click();
  await expect(viewer).not.toHaveURL(/\/login/, { timeout: 30_000 });
  await viewer.goto(`/meetings/room/${slug}`);
  await viewer.getByRole('button', { name: 'Katıl', exact: true }).click();
  const unavailable = viewer.getByText('Toplantı sunucusuna şu an ulaşılamıyor');
  await expect(inRoom(viewer).or(unavailable)).toBeVisible({ timeout: 30_000 });
  test.skip(await unavailable.isVisible(), 'LiveKit is not configured on this api');

  const why = 'İzleyen olduğun için konuşamaz ve görüntü açamazsın; moderatörden söz iste';
  await expect(viewer.getByRole('button', { name: why }).first()).toBeDisabled();
  await viewer.getByRole('button', { name: 'Söz iste', exact: true }).click();
  await expect(viewer.getByRole('button', { name: 'Söz istendi · geri al' })).toBeVisible();
  await expectRemoteHand(elif.page, slug);

  await context.close();
  await elif.context.close();
});

/** Elif joins the room and sees the viewer's raised hand. */
async function expectRemoteHand(page: Page, slug: string) {
  await page.goto(`/meetings/room/${slug}`);
  await page.getByRole('button', { name: 'Katıl', exact: true }).click();
  await expect(inRoom(page)).toBeVisible({ timeout: 30_000 });
  await expectRemote(page, /Dumpapp Destek/, (r) => r.hand !== '');
}

/** H7: Buğra calls Elif from their direct chat. */
async function callElif(page: Page, browser: Browser, video: boolean) {
  await signIn(page, BUGRA);
  await page.goto('/chat');
  await page.getByRole('link', { name: /Elif Yıldız/ }).click();
  const chatPath = new URL(page.url()).pathname;
  const elif = await secondSession(browser, page, ELIF);
  await elif.page.goto('/');
  await page.getByRole('button', { name: video ? 'Görüntülü ara' : 'Sesli ara' }).click();
  // The caller goes straight into the room and waits there.
  await expect(page).toHaveURL(/\/meetings\/room\/.+\?call=/);
  const unavailable = page.getByText('Toplantı sunucusuna şu an ulaşılamıyor');
  await expect(inRoom(page).or(unavailable)).toBeVisible({ timeout: 30_000 });
  test.skip(await unavailable.isVisible(), 'LiveKit is not configured on this api');
  await expect(page.getByRole('status').filter({ hasText: 'aranıyor' })).toBeVisible();
  const ring = elif.page.getByRole('alertdialog', {
    name: video ? /görüntülü arıyor/ : /sesli arıyor/,
  });
  await expect(ring).toBeVisible({ timeout: 15_000 });
  return { chatPath, elif, ring };
}

test('a call rings, is answered, and hanging up ends it with history (H7)', async ({
  page,
  browser,
}) => {
  const { chatPath, elif, ring } = await callElif(page, browser, true);
  await ring.getByRole('button', { name: 'Kabul et' }).click();
  await expect(inRoom(elif.page)).toBeVisible({ timeout: 30_000 });
  await expectRemote(page, /Elif/, (r) => live(r, 'camera') && live(r, 'microphone'));
  await expectRemote(elif.page, /Ahmet/, (r) => live(r, 'camera') && live(r, 'microphone'));

  // Elif hangs up: a one-to-one call ends for both, back to the chat with the call history.
  await elif.page.getByRole('button', { name: 'Ayrıl' }).click();
  await expect(elif.page).toHaveURL(new RegExp(`${chatPath}$`), { timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`${chatPath}$`), { timeout: 30_000 });
  await expect(
    page
      .getByRole('log')
      .getByText(/Görüntülü arama · \d\d:\d\d/)
      .last(),
  ).toBeVisible({ timeout: 30_000 });
  await elif.context.close();
});

test('a declined call tells the caller and leaves a declined-call line (H7)', async ({
  page,
  browser,
}) => {
  const { chatPath, elif, ring } = await callElif(page, browser, false);
  await ring.getByRole('button', { name: 'Reddet' }).click();
  await expect(ring).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'aramayı reddetti' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${chatPath}$`), { timeout: 30_000 });
  await expect(
    page
      .getByRole('log')
      .getByText(/Reddedilen sesli arama/)
      .last(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await elif.context.close();
});
