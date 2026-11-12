// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/docker-run-to-compose/logic.ts. See THIRD_PARTY.md.
import { dump } from 'js-yaml';

/**
 * Convert a `docker run …` command into a docker-compose service. Pure and
 * local. Handles the common flags; unknown ones are skipped rather than guessed.
 */

/** Split a command line into tokens, honoring quotes and `\`-newline joins. */
export function tokenize(command: string): string[] {
  const cleaned = command.replace(/\\\r?\n/g, ' ');
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// Flags that consume the next token as their value.
const VALUE_FLAGS: Record<string, string> = {
  '--name': 'name',
  '-p': 'publish',
  '--publish': 'publish',
  '-v': 'volume',
  '--volume': 'volume',
  '-e': 'env',
  '--env': 'env',
  '--env-file': 'env-file',
  '--restart': 'restart',
  '-w': 'workdir',
  '--workdir': 'workdir',
  '--network': 'network',
  '--net': 'network',
  '--entrypoint': 'entrypoint',
  '-u': 'user',
  '--user': 'user',
  '--label': 'label',
  '-l': 'label',
  '--hostname': 'hostname',
  '-h': 'hostname',
  '-m': 'memory',
  '--memory': 'memory',
  '--cpus': 'cpus',
};

// Boolean flags we understand (value handled inline, no next token).
const BOOL_FLAGS = new Set([
  '-d',
  '--detach',
  '--rm',
  '-i',
  '-t',
  '-it',
  '-ti',
  '--privileged',
  '--init',
]);

export function dockerRunToCompose(command: string): string {
  let tokens = tokenize(command.trim());
  // Drop a leading `docker run` / `docker container run`.
  const runIdx = tokens.indexOf('run');
  if (tokens[0] === 'docker' && runIdx > 0) tokens = tokens.slice(runIdx + 1);

  const svc: Record<string, unknown> = {};
  const ports: string[] = [];
  const volumes: string[] = [];
  const environment: string[] = [];
  const envFiles: string[] = [];
  const labels: string[] = [];
  let name = '';
  let image = '';
  const cmd: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    let tok = tokens[i]!;
    if (image) {
      cmd.push(tok); // everything after the image is the command
      continue;
    }
    if (tok.startsWith('-')) {
      // Support --flag=value.
      let inlineValue: string | null = null;
      const eq = tok.indexOf('=');
      if (eq > 1 && tok.startsWith('--')) {
        inlineValue = tok.slice(eq + 1);
        tok = tok.slice(0, eq);
      }
      const kind = VALUE_FLAGS[tok];
      if (kind) {
        const value = inlineValue ?? tokens[++i] ?? '';
        switch (kind) {
          case 'name':
            name = value;
            break;
          case 'publish':
            ports.push(value);
            break;
          case 'volume':
            volumes.push(value);
            break;
          case 'env':
            environment.push(value);
            break;
          case 'env-file':
            envFiles.push(value);
            break;
          case 'label':
            labels.push(value);
            break;
          case 'restart':
            svc.restart = value;
            break;
          case 'workdir':
            svc.working_dir = value;
            break;
          case 'network':
            svc.network_mode = value;
            break;
          case 'entrypoint':
            svc.entrypoint = value;
            break;
          case 'user':
            svc.user = value;
            break;
          case 'hostname':
            svc.hostname = value;
            break;
          case 'memory':
            svc.mem_limit = value;
            break;
          case 'cpus':
            svc.cpus = value;
            break;
        }
      } else if (tok === '--privileged') {
        svc.privileged = true;
      } else if (BOOL_FLAGS.has(tok)) {
        // no-op (detach, tty, rm… have no compose equivalent)
      }
      // else: unknown flag, skip
    } else {
      image = tok;
    }
  }

  if (!image) throw new Error('No image found. Expected e.g. `docker run nginx`.');

  svc.image = image;
  if (name) svc.container_name = name;
  if (ports.length) svc.ports = ports;
  if (volumes.length) svc.volumes = volumes;
  if (environment.length) svc.environment = environment;
  if (envFiles.length) svc.env_file = envFiles;
  if (labels.length) svc.labels = labels;
  if (cmd.length) svc.command = cmd.length === 1 ? cmd[0] : cmd;

  const serviceName = name || image.split('/').pop()!.split(':')[0]!;
  const compose = { services: { [serviceName]: svc } };
  return dump(compose, { indent: 2, lineWidth: -1, noRefs: true });
}
