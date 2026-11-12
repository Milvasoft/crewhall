import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `crewhall update` (tools/crewhall/crewhall) against a fake `docker` that records every
 * call: backup before anything changes, new version on success, and on a failed health
 * check the old images, the old .env and the pre-update backup come back.
 */
const SCRIPT = resolve(__dirname, '../../../tools/crewhall/crewhall').replaceAll('\\', '/');
const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).stdout?.includes('GNU bash');

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls.log"
ups=$(cat "$FAKE_DIR/ups" 2>/dev/null || echo 0)
case "$*" in
  *"config --images"*) printf 'crewhall/backend:1.0.0\\ncrewhall/web:1.0.0\\nchrislusf/seaweedfs:4\\n' ;;
  *"ps -q backend"*) echo cid123 ;;
  inspect*) if [ "$ups" = "\${FAIL_ON_UP:-0}" ]; then echo unhealthy; else echo healthy; fi ;;
  *" up -d"*) echo $((ups + 1)) > "$FAKE_DIR/ups" ;;
  *"crewhall.js backup"*) echo "crewhall: backup" >&2; echo "2026-10-22T03-00-00-000Z" ;;
esac
exit 0
`;

describe.skipIf(!hasBash)('crewhall update', () => {
  let dir: string;
  let envFile: string;

  beforeEach(async () => {
    dir = (await mkdtemp(join(tmpdir(), 'crewhall-update-'))).replaceAll('\\', '/');
    envFile = `${dir}/.env`;
    await writeFile(`${dir}/compose.yml`, 'services: {}\n');
    await writeFile(envFile, 'CREWHALL_REGISTRY=crewhall\nCREWHALL_VERSION=1.0.0\nAUTH_SECRET=x\n');
    await writeFile(`${dir}/docker`, FAKE_DOCKER);
    await chmod(`${dir}/docker`, 0o755);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const update = (failOnUp?: number) =>
    spawnSync(
      'bash',
      [SCRIPT, '--compose-file', `${dir}/compose.yml`, '--env-file', envFile, 'update', '1.1.0'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CREWHALL_DOCKER: `${dir}/docker`,
          CREWHALL_HEALTH_TIMEOUT: '5',
          FAKE_DIR: dir,
          FAIL_ON_UP: failOnUp === undefined ? '' : String(failOnUp),
        },
      },
    );
  const calls = async () => (await readFile(`${dir}/calls.log`, 'utf8')).trim().split('\n');
  const indexOf = (list: string[], part: string) => list.findIndex((c) => c.includes(part));

  it('backs up first, then moves to the new version', async () => {
    const r = update();
    expect(r.status, r.stderr).toBe(0);
    const log = await calls();
    const tag = indexOf(log, 'image tag crewhall/backend:1.0.0 crewhall/backend:crewhall-rollback');
    const backup = indexOf(log, 'crewhall.js backup --trigger update');
    const pull = indexOf(log, ' pull');
    const up = indexOf(log, ' up -d');
    expect(tag).toBeGreaterThanOrEqual(0);
    expect(tag).toBeLessThan(backup);
    expect(backup).toBeLessThan(pull);
    expect(pull).toBeLessThan(up);
    expect(log.some((c) => c.includes('crewhall.js restore'))).toBe(false);
    expect(await readFile(envFile, 'utf8')).toContain('CREWHALL_VERSION=1.1.0');
    expect(r.stderr).toContain('Güncelleme tamam: 1.1.0');
  });

  it('rolls back images, .env, database and files when the new version is not healthy', async () => {
    const r = update(1);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('güncelleme geri alındı');
    const log = await calls();
    const restore = indexOf(log, 'crewhall.js restore 2026-10-22T03-00-00-000Z --yes');
    const retag = indexOf(
      log,
      'image tag crewhall/backend:crewhall-rollback crewhall/backend:1.0.0',
    );
    expect(retag).toBeGreaterThan(indexOf(log, ' up -d'));
    expect(restore).toBeGreaterThan(retag);
    expect(log.slice(restore).some((c) => c.includes(' up -d'))).toBe(true);
    expect(await readFile(envFile, 'utf8')).toContain('CREWHALL_VERSION=1.0.0');
  });

  it('changes nothing when the backup fails', async () => {
    await writeFile(
      `${dir}/docker`,
      FAKE_DOCKER.replace('echo "2026-10-22T03-00-00-000Z"', 'exit 1'),
    );
    const r = update();
    expect(r.status).toBe(1);
    const log = await calls();
    expect(log.some((c) => c.includes(' pull') || c.includes(' up -d'))).toBe(false);
    expect(await readFile(envFile, 'utf8')).toContain('CREWHALL_VERSION=1.0.0');
  });
});
