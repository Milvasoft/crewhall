// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/docker-run-to-compose/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { dockerRunToCompose, tokenize } from './logic';

describe('docker-run-to-compose', () => {
  it('tokenizes quotes and line continuations', () => {
    expect(tokenize('a "b c" \\\n d')).toEqual(['a', 'b c', 'd']);
  });

  it('converts a typical run command', () => {
    const yaml = dockerRunToCompose(
      'docker run -d --name web -p 8080:80 -e ENV=prod -v ./data:/data --restart always nginx:alpine',
    );
    const parsed = load(yaml) as { services: Record<string, Record<string, unknown>> };
    const web = parsed.services.web!;
    expect(web.image).toBe('nginx:alpine');
    expect(web.container_name).toBe('web');
    expect(web.ports).toEqual(['8080:80']);
    expect(web.environment).toEqual(['ENV=prod']);
    expect(web.volumes).toEqual(['./data:/data']);
    expect(web.restart).toBe('always');
  });

  it('supports --flag=value and derives the service name from the image', () => {
    const yaml = dockerRunToCompose('docker run --restart=on-failure redis:7');
    const parsed = load(yaml) as { services: Record<string, unknown> };
    expect(Object.keys(parsed.services)).toEqual(['redis']);
  });

  it('captures the trailing command', () => {
    const yaml = dockerRunToCompose('docker run alpine echo hello world');
    const parsed = load(yaml) as { services: Record<string, Record<string, unknown>> };
    expect(parsed.services.alpine!.command).toEqual(['echo', 'hello', 'world']);
  });

  it('throws when no image is present', () => {
    expect(() => dockerRunToCompose('docker run -d')).toThrow();
  });

  it('throws on empty or whitespace-only input', () => {
    expect(() => dockerRunToCompose('')).toThrow();
    expect(() => dockerRunToCompose('   ')).toThrow();
  });

  it('tokenizes an unterminated quote without throwing', () => {
    expect(tokenize('a "unterminated')).toEqual(['a', 'unterminated']);
  });

  it('collapses runs of whitespace including tabs and newlines', () => {
    expect(tokenize('  a   b\t c\n d ')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sets privileged: true for --privileged', () => {
    const yaml = dockerRunToCompose('docker run --privileged nginx');
    const parsed = load(yaml) as { services: Record<string, Record<string, unknown>> };
    expect(parsed.services.nginx!.privileged).toBe(true);
  });

  it('collects repeated -e and -p flags into ordered arrays', () => {
    const yaml = dockerRunToCompose('docker run -e A=1 -e B=2 -p 80:80 -p 443:443 nginx');
    const parsed = load(yaml) as { services: Record<string, Record<string, unknown>> };
    expect(parsed.services.nginx!.environment).toEqual(['A=1', 'B=2']);
    expect(parsed.services.nginx!.ports).toEqual(['80:80', '443:443']);
  });

  it('treats -d, --rm, -it as no-ops with no compose equivalent', () => {
    const yaml = dockerRunToCompose('docker run -d --rm -it alpine sh');
    const parsed = load(yaml) as { services: Record<string, Record<string, unknown>> };
    const alpine = parsed.services.alpine!;
    expect(alpine).not.toHaveProperty('detach');
    expect(alpine).not.toHaveProperty('rm');
    expect(alpine).not.toHaveProperty('tty');
    expect(alpine.command).toBe('sh');
  });

  it('derives the service name from a registry image, stripping port, path, and tag', () => {
    const yaml = dockerRunToCompose('docker run myregistry.io:5000/group/myimage:1.2.3');
    const parsed = load(yaml) as { services: Record<string, unknown> };
    expect(Object.keys(parsed.services)).toEqual(['myimage']);
  });

  it('strips a `docker container run` prefix same as `docker run`', () => {
    const yaml = dockerRunToCompose('docker container run nginx');
    const parsed = load(yaml) as { services: Record<string, Record<string, unknown>> };
    expect(parsed.services.nginx!.image).toBe('nginx');
  });

  it('keeps a quoted multi-word entrypoint value intact', () => {
    const yaml = dockerRunToCompose('docker run --entrypoint "/bin/sh -c" alpine');
    const parsed = load(yaml) as { services: Record<string, Record<string, unknown>> };
    expect(parsed.services.alpine!.entrypoint).toBe('/bin/sh -c');
  });
});
