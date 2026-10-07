import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

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
    throw new Error(`${executable.split('/').at(-1)} ${args[0]} failed: ${error.stderr || error.code || 'command failed'}`);
  }
}

function withoutToken(env) {
  const copy = { ...env };
  delete copy.INPUT_TOKEN;
  delete copy.VEX_API_TOKEN;
  return copy;
}

export async function setup(env = process.env, run = command) {
  const token = input(env, 'token');
  if (!token) throw new Error('token is required');
  if (env.GITHUB_ACTIONS === 'true') console.log(`::add-mask::${escapeCommand(token)}`);
  const org = input(env, 'org');
  const builder = input(env, 'builder', 'main');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(org)) throw new Error('org is required and must be a slug or public ID');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(builder)) throw new Error('builder must be a slug or public ID');
  const api = new URL(input(env, 'api-url', 'https://composal.ai'));
  if (api.protocol !== 'https:' || api.username || api.password || api.pathname !== '/' || api.search || api.hash) {
    throw new Error('api-url must be an HTTPS origin');
  }
  if (process.platform !== 'linux') throw new Error('This action requires a Linux runner');
  const install = input(env, 'install-cli', 'true');
  if (!['true', 'false'].includes(install)) throw new Error('install-cli must be true or false');
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
  const cliEnv = { ...cleanEnv, VEX_API_TOKEN: token, VEX_API_BASE_URL: api.origin };
  const options = ['--org', org, '--api-base-url', api.origin, '--json'];
  // CI never creates a builder accidentally: members use an admin-provisioned cache.
  const resource = JSON.parse(await run(cli, ['docker-builder', 'status', builder, ...options], cliEnv)).docker_builder;
  if (!/^org_[a-zA-Z0-9]+$/.test(resource?.organization_id) || !/^docker_builder_[a-zA-Z0-9]+$/.test(resource?.id)) {
    throw new Error('Composal CLI returned an unexpected builder identity');
  }
  const context = `com-ci-${randomUUID()}`;
  // Register cleanup before setup, including malformed responses or failed wake.
  for (const [name, value] of Object.entries({ context, cli, org: resource.organization_id, builder: resource.id, api: api.origin })) {
    await record(env.GITHUB_STATE, name, value);
  }
  const result = JSON.parse(await run(cli, ['docker-builder', 'setup', resource.id, '--context', context,
    '--org', resource.organization_id, '--api-base-url', api.origin, '--json'], cliEnv));
  if (result.context !== context || result.buildx_builder !== context || result.driver !== 'docker' || result.foreground !== false ||
      result.organization_id !== resource.organization_id || result.builder_id !== resource.id) {
    throw new Error('Composal CLI returned an unexpected builder connection');
  }
  await run('docker', ['buildx', 'inspect', context, '--bootstrap'], cleanEnv, 300_000);
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
  console.log('Composal Docker builder is ready.');
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
        { ...cleanEnv, VEX_API_TOKEN: input(env, 'token'), VEX_API_BASE_URL: env.STATE_api });
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
