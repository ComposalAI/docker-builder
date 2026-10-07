import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, reportFailure, setup } from './builder.mjs';

async function fixture(t, inputs = {}, failure = '') {
  const directory = await mkdtemp(join(tmpdir(), 'com-builder-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    INPUT_TOKEN: 'secret-test-token', INPUT_ORG: 'acme', 'INPUT_INSTALL-CLI': 'false',
    GITHUB_PATH: join(directory, 'path'), GITHUB_ENV: join(directory, 'env'), GITHUB_STATE: join(directory, 'state'), GITHUB_OUTPUT: join(directory, 'output'), RUNNER_TEMP: directory, ...inputs,
  };
  const calls = [];
  const run = async (executable, args, childEnv) => {
    calls.push({ executable, args, env: childEnv });
    if (args.includes(failure)) throw new Error(`refused ${env.INPUT_TOKEN}`);
    if (args[1] === 'status') return JSON.stringify({ docker_builder: { id: 'docker_builder_456', organization_id: 'org_123' } });
    if (args[1] === 'setup') {
      const context = args[args.indexOf('--context') + 1];
      return JSON.stringify({ context, buildx_builder: context, driver: 'docker', foreground: false,
        organization_id: 'org_123', builder_id: 'docker_builder_456' });
    }
    return '';
  };
  const state = async () => {
    const lines = (await readFile(env.GITHUB_STATE, 'utf8')).trim().split('\n');
    const values = {};
    for (let index = 0; index < lines.length; index += 3) {
      values[`STATE_${lines[index].split('<<')[0]}`] = lines[index + 1];
    }
    return values;
  };
  return { env, run, calls, state };
}

test('setup returns a ready explicit builder and selects it for subsequent steps without persisting its token', async t => {
  const f = await fixture(t);
  await setup(f.env, f.run);
  assert.deepEqual(f.calls.map(c => c.args.slice(0, 2)), [['docker-builder', 'status'], ['docker-builder', 'setup'], ['buildx', 'inspect']]);
  for (const call of f.calls.slice(0, 2)) {
    assert.equal(call.env.VEX_API_TOKEN, f.env.INPUT_TOKEN);
    assert.ok(!call.args.join(' ').includes(f.env.INPUT_TOKEN));
  }
  assert.equal(f.calls[2].env.VEX_API_TOKEN, undefined);
  const environment = await readFile(f.env.GITHUB_ENV, 'utf8');
  assert.ok(environment.includes('DOCKER_CONTEXT<<'));
  assert.ok(environment.includes('BUILDX_METADATA_PROVENANCE<<'));
  assert.ok(environment.includes('\ndisabled\n'));
  assert.ok(environment.includes('DOCKER_BUILD_RECORD_UPLOAD<<'));
  assert.ok(environment.includes('DOCKER_BUILD_SUMMARY<<'));
  const output = await readFile(f.env.GITHUB_OUTPUT, 'utf8');
  assert.ok(output.includes('builder<<'));
  const state = await f.state();
  assert.ok(!JSON.stringify(state).includes(f.env.INPUT_TOKEN));
  await cleanup({ ...f.env, ...state }, f.run);
  assert.deepEqual(f.calls.slice(-2).map(c => c.args.slice(0, 2)), [['docker-builder', 'disconnect'], ['context', 'rm']]);
  assert.ok(!f.calls.some(c => c.args.includes('sleep') || c.args.includes('recover')));
});

test('bootstrap failure retains cleanup state and emits no usable builder', async t => {
  const f = await fixture(t, {}, '--bootstrap');
  await assert.rejects(setup(f.env, f.run), /refused/);
  await assert.rejects(readFile(f.env.GITHUB_OUTPUT), { code: 'ENOENT' });
  await cleanup({ ...f.env, ...await f.state() }, f.run);
  assert.equal(f.calls.at(-2).args[1], 'disconnect');
});

test('missing builder fails before setup; CI cannot silently create a misspelled cache', async t => {
  const f = await fixture(t, {}, 'status');
  await assert.rejects(setup(f.env, f.run), /refused/);
  assert.equal(f.calls.length, 1);
});

test('installer cannot inherit the API token and the installed CLI is retained for post cleanup', async t => {
  const f = await fixture(t, { 'INPUT_INSTALL-CLI': 'true', VEX_API_TOKEN: 'unrelated-token' });
  await setup(f.env, f.run);
  for (const call of f.calls.slice(0, 2)) {
    assert.equal(call.env.VEX_API_TOKEN, undefined);
    assert.equal(call.env.INPUT_TOKEN, undefined);
  }
  const cli = (await f.state()).STATE_cli;
  assert.match(cli, /com-docker-builder-.*\/com$/);
  assert.equal((await readFile(f.env.GITHUB_PATH, 'utf8')).trim() + '/com', cli);
});

test('cleanup still removes its context when disconnect fails', async t => {
  const f = await fixture(t, {}, 'disconnect');
  await setup(f.env, f.run);
  await assert.rejects(cleanup({ ...f.env, ...await f.state() }, f.run), /refused/);
  assert.equal(f.calls.at(-1).args[1], 'rm');
});

test('cleanup without action state leaves other contexts and supervisors alone', async () => {
  await cleanup({}, () => assert.fail('must not run'));
});

test('invalid credentials and origins fail before executing any command', async t => {
  for (const inputs of [{ INPUT_TOKEN: '' }, { INPUT_ORG: '' }, { 'INPUT_API-URL': 'http://example.com' },
    { 'INPUT_API-URL': 'https://example.com/path' }, { 'INPUT_API-URL': 'https://user:pass@example.com' },
    { INPUT_BUILDER: '--flag' }, { 'INPUT_INSTALL-CLI': 'yes' }]) {
    const f = await fixture(t, inputs);
    await assert.rejects(setup(f.env, f.run));
    assert.equal(f.calls.length, 0);
  }
});

test('failure reporting redacts the token and escapes annotation injection', t => {
  let output;
  t.mock.method(console, 'log', message => { output = message; });
  reportFailure(new Error('secret-test-token\n::error::injected'), 'error', { INPUT_TOKEN: 'secret-test-token' });
  assert.equal(output, '::error::[redacted]%0A::error::injected');
});


test('malformed setup response still disconnects the resolved builder without emitting outputs', async t => {
  const f = await fixture(t);
  const run = (executable, args, env) => args[1] === 'setup' ? 'invalid-json' : f.run(executable, args, env);
  await assert.rejects(setup(f.env, run), SyntaxError);
  await assert.rejects(readFile(f.env.GITHUB_OUTPUT), { code: 'ENOENT' });
  await cleanup({ ...f.env, ...await f.state() }, f.run);
  assert.equal(f.calls.at(-2).args[2], 'docker_builder_456');
});


test('explicit-output mode leaves Docker environment untouched', async t => {
  const f = await fixture(t, { INPUT_USE: 'false' });
  await setup(f.env, f.run);
  await assert.rejects(readFile(f.env.GITHUB_ENV), { code: 'ENOENT' });
  await cleanup({ ...f.env, ...await f.state() }, f.run);
  await assert.rejects(readFile(f.env.GITHUB_ENV), { code: 'ENOENT' });
});

test('cleanup restores a previous job context before removing its remote context', async t => {
  const f = await fixture(t, { DOCKER_CONTEXT: 'previous', BUILDX_BUILDER: 'previous-builder', BUILDX_METADATA_PROVENANCE: 'max', DOCKER_BUILD_RECORD_UPLOAD: 'true' });
  await setup(f.env, f.run);
  await cleanup({ ...f.env, DOCKER_CONTEXT: 'remote', ...await f.state() }, f.run);
  assert.equal(f.calls.at(-1).env.DOCKER_CONTEXT, 'previous');
  assert.equal(f.calls.at(-1).env.BUILDX_BUILDER, 'previous-builder');
  assert.equal(f.calls.at(-1).env.BUILDX_METADATA_PROVENANCE, 'max');
  assert.equal(f.calls.at(-1).env.DOCKER_BUILD_RECORD_UPLOAD, 'true');
  const exported = await readFile(f.env.GITHUB_ENV, 'utf8');
  assert.ok(exported.includes('\nprevious\n'));
  assert.ok(exported.includes('\nprevious-builder\n'));
});


test('local invocation never prints a token-bearing GitHub masking command', async t => {
  const output = [];
  t.mock.method(console, 'log', message => output.push(message));
  const f = await fixture(t);
  await setup(f.env, f.run);
  assert.ok(output.every(message => !message.includes(f.env.INPUT_TOKEN)));
});
