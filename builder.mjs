import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const selectedKeys = ['DOCKER_CONTEXT', 'BUILDX_BUILDER', 'BUILDX_METADATA_PROVENANCE', 'DOCKER_BUILD_RECORD_UPLOAD', 'DOCKER_BUILD_SUMMARY'];
const escapeCommand = value => String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');

function input(env, name, fallback = '') {
  return env[`INPUT_${name.toUpperCase()}`]?.trim() || fallback;
}

async function record(file, name, value) {
  if (!file) throw new Error(`GitHub command file is required for ${name}`);
  const delimiter = randomUUID();
  await appendFile(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

export async function command(executable, args, env, timeout = 120_000) {
  try {
    const { stdout } = await exec(executable, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    // Never include argv, environment, or stdout (which may contain credentials).
    const timedOut = error.killed && error.signal === 'SIGTERM' && error.code == null;
    const details = [timedOut ? `timed out after ${timeout / 1000}s` : 'command failed',
      `exit=${error.code ?? 'none'}`, `signal=${error.signal ?? 'none'}`, `killed=${Boolean(error.killed)}`];
    const operation = args.includes('version') ? 'version' : args.slice(0, 2).filter(a => /^[a-z-]+$/.test(a)).join(' ');
    throw new Error(`${executable.split('/').at(-1)} ${operation}: ${details.join(', ')}${error.stderr ? `; ${String(error.stderr).slice(-4096)}` : ''}`);
  }
}

function withoutToken(env) {
  const copy = { ...env };
  delete copy.INPUT_TOKEN;
  delete copy.COMPOSAL_API_TOKEN;
  delete copy.VEX_API_TOKEN;
  return copy;
}

export async function setup(env = process.env, run = command, wait = delay) {
  const token = input(env, 'token');
  if (!token) throw new Error('token is required');
  if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${escapeCommand(token)}`);
  const org = input(env, 'org');
  const builder = input(env, 'builder', 'main-gen2');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(org)) throw new Error('org is required and must be a slug or public ID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(builder)) throw new Error('builder must be a slug or public ID');
  const api = new URL(input(env, 'api-url', 'https://composal.ai'));
  if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash) {
    throw new Error('api-url must be an HTTPS origin');
  }
  if (process.platform !== 'linux') throw new Error('This action requires a Linux runner');
  const startedAt = Date.now();
  let stageStartedAt = startedAt;
  const stage = name => {
    const now = Date.now();
    console.log(`${name} (${((now - stageStartedAt) / 1000).toFixed(1)}s; total ${((now - startedAt) / 1000).toFixed(1)}s)`);
    stageStartedAt = now;
  };
  const install = input(env, 'install-cli', 'true');
  if (!['true', 'false'].includes(install)) throw new Error('install-cli must be true or false');
  const wakeTimeout = Number(input(env, 'wake-timeout', '900'));
  if (!Number.isInteger(wakeTimeout) || wakeTimeout < 30 || wakeTimeout > 3600) throw new Error('wake-timeout must be between 30 and 3600 seconds');
  const use = input(env, 'use', 'true');
  if (!['true', 'false'].includes(use)) throw new Error('use must be true or false');
  const cleanEnv = withoutToken(env);
  let cli = 'com';
  if (install === 'true') {
    if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required');
    const directory = join(env.RUNNER_TEMP, `com-docker-builder-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const script = join(directory, 'install.sh');
    await run('curl', ['-fsSL', '--max-time', '60', 'https://dl.composal.ai/install.sh', '-o', script], cleanEnv);
    await run('sh', [script], { ...cleanEnv, VEX_INSTALL_DIR: directory }, 300_000);
    cli = join(directory, 'com');
    if (!env.GITHUB_PATH) throw new Error('GITHUB_PATH is required');
    await appendFile(env.GITHUB_PATH, `${dirname(cli)}\n`);
  }
  const cliVersion = (await run(cli, ['--version'], cleanEnv, 10_000)).trim();
  if (!/^com(?:posal)? [0-9]+\.[0-9]+\.[0-9]+/.test(cliVersion)) throw new Error('Could not identify the Composal CLI version');
  stage(`Composal CLI available: ${cliVersion}`);
  if (!env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required');
  // The CLI keys supervisors by config home as well as builder identity.
  // A job must not reuse or disconnect a pre-existing local connection.
  const configHome = join(env.RUNNER_TEMP, `com-builder-state-${randomUUID()}`);
  await mkdir(configHome, { recursive: true, mode: 0o700 });
  const cliEnv = { ...cleanEnv, XDG_CONFIG_HOME: configHome, COMPOSAL_API_TOKEN: token, VEX_API_TOKEN: token, VEX_API_BASE_URL: api.origin };
  const options = ['--org', org, '--api-base-url', api.origin, '--json'];
  const inspect = async (selector, deadline = Date.now() + 30_000) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return JSON.parse(await run(cli, ['docker-builder', 'status', selector, ...options], cliEnv,
          Math.max(1, deadline - Date.now()))).docker_builder;
      } catch (error) {
        if (attempt >= 2 || Date.now() >= deadline ||
            !/\b50[0234]\b|timed out|connection reset|ECONNRESET|ETIMEDOUT/.test(error.message)) throw error;
        await wait(Math.min(250 * (attempt + 1), deadline - Date.now()));
      }
    }
  };
  // CI never creates a builder accidentally: members use an admin-provisioned cache.
  const resource = await inspect(builder);
  if (!/^org_[a-zA-Z0-9]+$/.test(resource?.organization_id) || !/^docker_builder_[a-zA-Z0-9]+$/.test(resource?.id)) {
    throw new Error('Composal CLI returned an unexpected builder identity');
  }
  // Read the new backend field directly until all released CLIs retain it.
  // Fail closed: a v2 action must never quietly build on Classic or locally.
  let backend;
  try {
    const response = await fetch(`${api.origin}/api/v1/organizations/${resource.organization_id}/docker_builders/${resource.id}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error('backend lookup refused');
    backend = (await response.json()).docker_builder;
  } catch {
    throw new Error('Could not verify Gen2 builder placement');
  }
  if (backend?.id !== resource.id || backend.organization_id !== resource.organization_id || backend.backend !== 'gen2') {
    throw new Error('docker-builder@2 requires an enabled Gen2 builder; select its builder name');
  }
  stage(`Builder resolved: ${resource.status || 'unknown state'}`);
  if (resource.status !== 'ready') {
    // Complete the control-plane wake before Docker opens its first HTTP
    // connection. Native ping/version clients can abandon that socket during
    // a long wake even though the VM subsequently becomes healthy.
    const gateway = new URL(resource.gateway_url);
    if (gateway.protocol !== 'wss:' || gateway.username || gateway.password || gateway.search || gateway.hash ||
        gateway.pathname !== `/v1/organizations/${resource.organization_id}/docker`) {
      throw new Error('Composal CLI returned an unexpected builder gateway');
    }
    gateway.protocol = 'https:';
    gateway.pathname = '/healthz';
    await run('curl', ['-fsS', '--max-time', '5', gateway.href], cleanEnv);
    const deadline = Date.now() + wakeTimeout * 1_000;
    let nextProgress = Date.now() + 15_000;
    let current = resource;
    let requestedWake = false;
    while (current.status !== 'ready') {
      if (current.status === 'failed' && requestedWake) {
        throw new Error(`Remote builder startup failed (generation=${current.generation ?? 'unknown'}, stage=${current.startup_stage || 'unknown'}): ${current.startup_failure || 'startup did not complete; retry the job to resume the same cache'}`);
      }
      if (Date.now() >= deadline) throw new Error(`Remote builder wake timed out after ${wakeTimeout}s (state=${current.status}, generation=${current.generation ?? 'unknown'}); the shared wake continues independently of this job`);
      if (current.status === 'sleeping' || (['starting', 'failed'].includes(current.status) && !requestedWake)) {
        await run(cli, ['docker-builder', 'wake', resource.id, ...options], cliEnv, Math.max(1, deadline - Date.now()));
        requestedWake = true;
      } else if (!['starting', 'stopping'].includes(current.status)) {
        throw new Error('Composal CLI returned an unexpected builder state');
      }
      if (Date.now() >= nextProgress) {
        stage(`Waiting for builder: state=${current.status}, generation=${current.generation ?? 'unknown'}, stage=${current.startup_stage || 'unknown'}`);
        nextProgress = Date.now() + 15_000;
      }
      await wait(Math.min(1_000, Math.max(1, deadline - Date.now())));
      current = await inspect(resource.id, deadline);
      if (current?.id !== resource.id || current.organization_id !== resource.organization_id) {
        throw new Error('Composal CLI returned an unexpected builder identity');
      }
    }
    stage('Remote builder wake completed');
  }
  const context = `com-ci-${randomUUID()}`;
  // Register cleanup before setup, including malformed responses or failed wake.
  for (const [name, value] of Object.entries({ context, cli, config_home: configHome, org: resource.organization_id, builder: resource.id, api: api.origin })) {
    await record(env.GITHUB_STATE, name, value);
  }
  const result = JSON.parse(await run(cli, ['docker-builder', 'setup', resource.id, '--context', context,
    '--org', resource.organization_id, '--api-base-url', api.origin, '--json'], cliEnv));
  if (result.context !== context || result.buildx_builder !== context || result.driver !== 'docker' || result.foreground !== false ||
      result.organization_id !== resource.organization_id || result.builder_id !== resource.id) {
    throw new Error('Composal CLI returned an unexpected builder connection');
  }
  stage('Local builder proxy configured');
  console.log('Checking remote Docker through the configured context.');
  const dockerEnv = { ...cleanEnv, DOCKER_CONTEXT: context, BUILDX_BUILDER: context };
  // A fresh private proxy can reset its first connection while establishing
  // the remote session. Retry this read only; never replay a build or push.
  // The control-plane wake is complete. Bound each native probe separately
  // so a stale connection cannot consume the entire readiness deadline.
  const readinessDeadline = Date.now() + 90_000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const version = await run('docker', ['--context', context, 'version', '--format', '{{.Server.Version}}'], dockerEnv,
        Math.max(1, Math.min(15_000, readinessDeadline - Date.now())));
      if (!/^\d+\.\d+\.\d+/.test(version.trim())) throw new Error('Remote Docker daemon is not ready');
      break;
    } catch (error) {
      const transient = /timed out after|connection reset by peer|connection refused|unexpected EOF|i\/o timeout|TLS handshake timeout|dial unix.*no such file or directory/.test(error.message);
      if (!transient || attempt === 4 || Date.now() >= readinessDeadline) throw error;
      await wait(Math.min(2_000, readinessDeadline - Date.now()));
    }
  }
  stage('Remote Docker ready');
  // Inspect alone can exit zero with a node error; version must succeed first.
  await run('docker', ['buildx', 'inspect', context, '--bootstrap'], dockerEnv, 300_000);
  if (use === 'true') {
    await record(env.GITHUB_STATE, 'selected', 'true');
    // The scoped gateway does not expose BuildKit content-record downloads.
    // These switches retain digest metadata without provenance/history exports.
    const selected = { DOCKER_CONTEXT: context, BUILDX_BUILDER: context,
      BUILDX_METADATA_PROVENANCE: 'disabled', DOCKER_BUILD_RECORD_UPLOAD: 'false', DOCKER_BUILD_SUMMARY: 'false' };
    for (const key of selectedKeys) {
      await record(env.GITHUB_STATE, `previous_${key}`, env[key] || '');
      await record(env.GITHUB_ENV, key, selected[key]);
    }
  }
  for (const [name, value] of Object.entries({ context, builder: context, driver: 'docker' })) {
    await record(env.GITHUB_OUTPUT, name, value);
  }
  stage('Composal Docker builder is ready.');
}

export async function cleanup(env = process.env, run = command) {
  const context = env.STATE_context;
  if (!/^com-ci-[a-f0-9-]{36}$/.test(context || '')) return;
  const cleanEnv = withoutToken(env);
  const failures = [];
  if (env.STATE_selected === 'true') {
    for (const key of selectedKeys) cleanEnv[key] = env[`STATE_previous_${key}`] || '';
    cleanEnv.DOCKER_CONTEXT ||= 'default';
  }
  if (env.STATE_builder && env.STATE_org && env.STATE_cli && env.STATE_api) {
    try {
      await run(env.STATE_cli, ['docker-builder', 'disconnect', env.STATE_builder, '--org', env.STATE_org, '--api-base-url', env.STATE_api],
        { ...cleanEnv, XDG_CONFIG_HOME: env.STATE_config_home, COMPOSAL_API_TOKEN: input(env, 'token'), VEX_API_TOKEN: input(env, 'token'), VEX_API_BASE_URL: env.STATE_api });
    } catch (error) { failures.push(error.message); }
  }
  try {
    await run('docker', ['context', 'rm', '--force', context], cleanEnv);
  } catch (error) { failures.push(error.message); }
  if (env.STATE_selected === 'true') {
    for (const key of selectedKeys) await record(env.GITHUB_ENV, key, env[`STATE_previous_${key}`] || '');
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log('Disconnected local builder context; remote cache and idle policy are retained.');
}

export function reportFailure(error, severity = 'error', env = process.env) {
  const token = input(env, 'token');
  const message = token ? String(error.message).replaceAll(token, '[redacted]') : String(error.message);
  console.log(`::${severity}::${escapeCommand(message)}`);
}
