import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, cleanup, reportFailure, setup } from './builder.mjs';

async function fixture(t, inputs = {}, failure = '') {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ docker_builder: {
    id: 'docker_builder_456', organization_id: 'org_123', backend: 'gen2',
  } }) }));
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
    if (args[0] === '--version') return 'com 1.17.92\n';
    if (args[1] === 'status') return JSON.stringify({ docker_builder: { id: 'docker_builder_456', organization_id: 'org_123', status: 'ready' } });
    if (args[1] === 'setup') {
      const context = args[args.indexOf('--context') + 1];
      return JSON.stringify({ context, buildx_builder: context, driver: 'docker', foreground: false,
        organization_id: 'org_123', builder_id: 'docker_builder_456' });
    }
    if (args.includes('version')) return '28.5.2\n';
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
  assert.deepEqual(f.calls.map(c => c.args.slice(0, 2)), [['--version'], ['docker-builder', 'status'], ['docker-builder', 'setup'], ['--context', f.calls[3].args[1]]]);
  for (const call of f.calls.slice(1, 3)) {
    assert.equal(call.env.COMPOSAL_API_TOKEN, f.env.INPUT_TOKEN);
    assert.equal(call.env.VEX_API_TOKEN, f.env.INPUT_TOKEN);
    assert.ok(!call.args.join(' ').includes(f.env.INPUT_TOKEN));
  }
  assert.equal(f.calls[3].env.COMPOSAL_API_TOKEN, undefined);
  assert.equal(f.calls[3].env.DOCKER_CONTEXT, f.calls[3].args[1]);
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
  assert.equal(f.calls.at(-2).env.XDG_CONFIG_HOME, f.calls[1].env.XDG_CONFIG_HOME);
});

test('a cold builder reaches ready before any native Docker connection is configured', async t => {
  const f = await fixture(t);
  const states = ['sleeping', 'starting', 'ready'];
  const waits = [];
  let state;
  const run = async (exe, args, env, timeout) => {
    const result = await f.run(exe, args, env, timeout);
    if (args[1] === 'status') {
      state = states.shift();
      return JSON.stringify({ docker_builder: { id: 'docker_builder_456', organization_id: 'org_123',
        status: state, gateway_url: 'wss://builder.example/v1/organizations/org_123/docker' } });
    }
    if (args[1] === 'setup' || args.includes('version')) assert.equal(state, 'ready');
    return result;
  };
  await setup(f.env, run, async ms => waits.push(ms));
  assert.deepEqual(waits, [1_000, 1_000]);
  assert.equal(f.calls.filter(c => c.args[1] === 'wake').length, 1);
  const health = f.calls.findIndex(c => c.executable === 'curl');
  const wake = f.calls.findIndex(c => c.args[1] === 'wake');
  assert.ok(health < wake);
  assert.ok(f.calls[health].args.includes('https://builder.example/healthz'));
  assert.equal(f.calls[health].env.COMPOSAL_API_TOKEN, undefined);
});

test('an already starting builder requests one wake retry instead of only polling abandoned state', async t => {
  const f = await fixture(t);
  let statuses = 0;
  const run = async (exe, args, env, timeout) => {
    const result = await f.run(exe, args, env, timeout);
    if (args[1] === 'status') return JSON.stringify({ docker_builder: {
      id: 'docker_builder_456', organization_id: 'org_123', generation: 37,
      status: ++statuses < 4 ? 'starting' : 'ready',
      gateway_url: 'wss://builder.example/v1/organizations/org_123/docker',
    } });
    if (args[1] === 'setup') assert.equal(statuses, 4);
    return result;
  };
  await setup(f.env, run, async () => {});
  assert.equal(f.calls.filter(c => c.args[1] === 'wake').length, 1);
  assert.equal(f.calls.find(c => c.args[1] === 'wake').args[2], 'docker_builder_456');
});

test('an unreachable gateway does not wake compute or configure Docker', async t => {
  const f = await fixture(t);
  const run = async (exe, args, env, timeout) => {
    if (exe === 'curl') throw new Error('gateway unavailable');
    const result = await f.run(exe, args, env, timeout);
    if (args[1] === 'status') return JSON.stringify({ docker_builder: {
      id: 'docker_builder_456', organization_id: 'org_123', status: 'sleeping',
      gateway_url: 'wss://builder.example/v1/organizations/org_123/docker',
    } });
    return result;
  };
  await assert.rejects(setup(f.env, run), /gateway unavailable/);
  assert.ok(!f.calls.some(c => ['wake', 'setup'].includes(c.args[1])));
});

test('a failed startup stops polling immediately and reports its generation and stage', async t => {
  const f = await fixture(t);
  let statuses = 0;
  const run = async (exe, args, env, timeout) => {
    const result = await f.run(exe, args, env, timeout);
    if (args[1] === 'status') return JSON.stringify({ docker_builder: {
      id: 'docker_builder_456', organization_id: 'org_123', generation: 39,
      status: ++statuses === 1 ? 'starting' : 'failed', startup_stage: 'runtime_create',
      startup_failure: 'allocation timed out', gateway_url: 'wss://builder.example/v1/organizations/org_123/docker',
    } });
    return result;
  };
  await assert.rejects(setup(f.env, run, async () => {}), /startup failed.*generation=39.*runtime_create.*allocation timed out/);
  assert.equal(statuses, 2);
  assert.ok(!f.calls.some(c => c.args[1] === 'setup'));
});

test('a fresh job can explicitly retry a failed startup once using the same builder', async t => {
  const f = await fixture(t);
  let statuses = 0;
  const run = async (exe, args, env, timeout) => {
    const result = await f.run(exe, args, env, timeout);
    if (args[1] === 'status') return JSON.stringify({ docker_builder: {
      id: 'docker_builder_456', organization_id: 'org_123', generation: 39,
      status: ++statuses === 1 ? 'failed' : 'ready', gateway_url: 'wss://builder.example/v1/organizations/org_123/docker',
    } });
    return result;
  };
  await setup(f.env, run, async () => {});
  assert.equal(f.calls.filter(c => c.args[1] === 'wake').length, 1);
});

test('transient status failures are retried before configuring the native proxy', async t => {
  const f = await fixture(t);
  const waits = [];
  let statuses = 0;
  const run = async (exe, args, env, timeout) => {
    if (args[1] === 'status' && statuses++ === 0) throw new Error('500 Internal Server Error');
    return f.run(exe, args, env, timeout);
  };
  await setup(f.env, run, async ms => waits.push(ms));
  assert.equal(statuses, 2);
  assert.deepEqual(waits, [250]);
});

test('a stalled control-plane wake has one bounded deadline and publishes no context', async t => {
  const f = await fixture(t);
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const run = async (exe, args, env, timeout) => {
    const result = await f.run(exe, args, env, timeout);
    if (args[1] === 'status') return JSON.stringify({ docker_builder: {
      id: 'docker_builder_456', organization_id: 'org_123', status: 'starting',
      gateway_url: 'wss://builder.example/v1/organizations/org_123/docker',
    } });
    return result;
  };
  await assert.rejects(setup(f.env, run, async () => { now = 900_001; }), /wake timed out after 900s/);
  assert.ok(!f.calls.some(c => c.args[1] === 'setup'));
  await assert.rejects(readFile(f.env.GITHUB_OUTPUT), { code: 'ENOENT' });
});

test('missing builder fails before setup; CI cannot silently create a misspelled cache', async t => {
  const f = await fixture(t, {}, 'status');
  await assert.rejects(setup(f.env, f.run), /refused/);
  assert.equal(f.calls.length, 2);
});

test('installer cannot inherit the API token and the installed CLI is retained for post cleanup', async t => {
  const f = await fixture(t, { 'INPUT_INSTALL-CLI': 'true', COMPOSAL_API_TOKEN: 'unrelated-token', VEX_API_TOKEN: 'legacy-unrelated-token' });
  await setup(f.env, f.run);
  for (const call of f.calls.slice(0, 2)) {
    assert.equal(call.env.COMPOSAL_API_TOKEN, undefined);
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


test('a non-Docker driver is refused before publishing outputs and remains cleanable', async t => {
  const f = await fixture(t);
  const run = async (executable, args, env) => {
    const result = await f.run(executable, args, env);
    return args[1] === 'setup' ? JSON.stringify({ ...JSON.parse(result), driver: 'docker-container' }) : result;
  };
  await assert.rejects(setup(f.env, run), /unexpected builder connection/);
  await assert.rejects(readFile(f.env.GITHUB_OUTPUT), { code: 'ENOENT' });
  await cleanup({ ...f.env, ...await f.state() }, f.run);
  assert.equal(f.calls.at(-2).args[1], 'disconnect');
  assert.equal(f.calls.at(-1).args[1], 'rm');
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


test('daemon failure retains cleanup state and refuses to publish a usable builder', async t => {
  const f = await fixture(t, {}, 'version');
  await assert.rejects(setup(f.env, f.run), /refused/);
  await assert.rejects(readFile(f.env.GITHUB_OUTPUT), { code: 'ENOENT' });
  await cleanup({ ...f.env, ...await f.state() }, f.run);
  assert.equal(f.calls.at(-2).args[1], 'disconnect');
});

test('empty daemon version cannot pass readiness', async t => {
  const f = await fixture(t);
  const run = (exe, args, env) => args.includes('version') ? '' : f.run(exe, args, env);
  await assert.rejects(setup(f.env, run), /not ready/);
});

test('jobs sharing a builder have separate local supervisor identities', async t => {
  const first = await fixture(t, { XDG_CONFIG_HOME: '/previous-config' });
  const second = await fixture(t, { XDG_CONFIG_HOME: '/previous-config' });
  await setup(first.env, first.run);
  await setup(second.env, second.run);
  assert.notEqual(first.calls[1].env.XDG_CONFIG_HOME, '/previous-config');
  assert.notEqual(first.calls[1].env.XDG_CONFIG_HOME, second.calls[1].env.XDG_CONFIG_HOME);
});


test('fresh proxy connection resets are retried before publishing a ready context', async t => {
  const f = await fixture(t);
  let probes = 0;
  const waits = [];
  const run = (exe, args, env, timeout) => {
    if (args.includes('version') && ++probes < 3) throw new Error('read unix: connection reset by peer');
    return f.run(exe, args, env, timeout);
  };
  await setup(f.env, run, async ms => waits.push(ms));
  assert.equal(probes, 3);
  assert.deepEqual(waits, [2000, 2000]);
  assert.ok((await readFile(f.env.GITHUB_OUTPUT, 'utf8')).includes('driver<<'));
});

test('persistent proxy failure exhausts bounded readiness probes without usable outputs', async t => {
  const f = await fixture(t);
  let probes = 0;
  const waits = [];
  const run = (exe, args, env, timeout) => {
    if (args.includes('version')) { probes++; throw new Error('connection reset by peer'); }
    return f.run(exe, args, env, timeout);
  };
  await assert.rejects(setup(f.env, run, async ms => waits.push(ms)), /connection reset/);
  assert.equal(probes, 5);
  assert.deepEqual(waits, [2000, 2000, 2000, 2000]);
  await assert.rejects(readFile(f.env.GITHUB_OUTPUT), { code: 'ENOENT' });
  await cleanup({ ...f.env, ...await f.state() }, f.run);
});

test('authorization failures are not retried as proxy startup races', async t => {
  const f = await fixture(t);
  let probes = 0;
  const waits = [];
  const run = (exe, args, env, timeout) => {
    if (args.includes('version')) { probes++; throw new Error('unauthorized'); }
    return f.run(exe, args, env, timeout);
  };
  await assert.rejects(setup(f.env, run, async ms => waits.push(ms)), /unauthorized/);
  assert.equal(probes, 1);
  assert.deepEqual(waits, []);
});

test('a stalled native connection uses one readiness budget and cannot restart that budget on failure', async t => {
  const f = await fixture(t);
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const timeouts = [];
  const waits = [];
  const run = (exe, args, env, timeout) => {
    if (args.includes('version')) {
      timeouts.push(timeout);
      now = 300_001;
      throw new Error('connection reset by peer');
    }
    return f.run(exe, args, env, timeout);
  };
  await assert.rejects(setup(f.env, run, async ms => waits.push(ms)), /connection reset/);
  assert.deepEqual(timeouts, [45_000]);
  assert.deepEqual(waits, []);
  await assert.rejects(readFile(f.env.GITHUB_OUTPUT), { code: 'ENOENT' });
});


test('a long shared wake completes before opening short-lived Docker probes', async t => {
  const f = await fixture(t);
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const run = async (exe, args, env, timeout) => {
    const result = await f.run(exe, args, env, timeout);
    if (args[1] === 'status') return JSON.stringify({ docker_builder: {
      id: 'docker_builder_456', organization_id: 'org_123', status: now < 760_000 ? 'starting' : 'ready',
      gateway_url: 'wss://builder.example/v1/organizations/org_123/docker',
    } });
    if (args.includes('version')) {
      assert.equal(now, 760_000);
      assert.equal(timeout, 45_000);
    }
    return result;
  };
  await setup(f.env, run, async () => { now = 760_000; });
  assert.ok((await readFile(f.env.GITHUB_OUTPUT, 'utf8')).includes('driver<<'));
});

test('native probe timeouts are retried without repeating setup or a build', async t => {
  const f = await fixture(t);
  let probes = 0;
  const run = (exe, args, env, timeout) => {
    if (args.includes('version') && probes++ === 0) throw new Error('timed out after 15s');
    return f.run(exe, args, env, timeout);
  };
  await setup(f.env, run, async () => {});
  assert.equal(probes, 2);
  assert.equal(f.calls.filter(c => c.args[1] === 'setup').length, 1);
});

test('slow native negotiation can finish and retries share the remaining readiness budget', async t => {
  const f = await fixture(t);
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const timeouts = [];
  const run = async (exe, args, env, timeout) => {
    if (args.includes('version')) {
      timeouts.push(timeout);
      if (timeouts.length === 1) {
        now += timeout;
        throw new Error('timed out after 45s');
      }
      // A healthy negotiation may take longer than the former 15s limit.
      now += 25_000;
    }
    return f.run(exe, args, env, timeout);
  };
  await setup(f.env, run, async ms => { now += ms; });
  assert.deepEqual(timeouts, [45_000, 43_000]);
  assert.ok((await readFile(f.env.GITHUB_OUTPUT, 'utf8')).includes('driver<<'));
});

test('command failures preserve timeout and signal details without stdout or environment', async () => {
  await assert.rejects(command(process.execPath, ['-e', "console.log('private-stdout'); setInterval(() => {}, 1000)"],
    { PRIVATE_TOKEN: 'private-env' }, 100), error => {
    assert.match(error.message, /timed out after 0.1s/);
    assert.match(error.message, /signal=SIGTERM, killed=true/);
    assert.ok(!error.message.includes('private-stdout'));
    assert.ok(!error.message.includes('private-env'));
    return true;
  });
});


test('v2 refuses a Classic builder before waking or connecting Docker', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => ({ok: true, json: async () => ({docker_builder: {
    id: 'docker_builder_456', organization_id: 'org_123', backend: 'classic',
  }})}));
  await assert.rejects(setup(f.env, f.run), /requires an enabled Gen2 builder/);
  assert.ok(!f.calls.some(c => c.args[1] === 'wake' || c.args[1] === 'setup'));
});

for (const version of ['com 1.17.92', 'com 1.18.0']) {
  test(`automatic setup reuses compatible installed ${version} without downloading`, async t => {
    const f = await fixture(t, { 'INPUT_INSTALL-CLI': '' });
    const run = (exe, args, env) => args[0] === '--version' ? version : f.run(exe, args, env);
    await setup(f.env, run);
    assert.equal((await f.state()).STATE_cli, 'com');
    assert.ok(!f.calls.some(c => c.executable === 'curl' || c.executable === 'sh'));
    await cleanup({ ...f.env, ...await f.state() }, f.run);
    assert.equal(f.calls.at(-2).executable, 'com');
  });
}

for (const version of [null, 'com 1.17.91', 'com 2.0.0', 'com 1.17.92-dev', 'other 1.17.92']) {
  test(`automatic setup installs a private CLI when installed version is ${version}`, async t => {
    const f = await fixture(t, { 'INPUT_INSTALL-CLI': 'auto', COMPOSAL_API_TOKEN: 'ambient', VEX_API_TOKEN: 'ambient' });
    const run = async (exe, args, env) => {
      if (exe === 'com' && args[0] === '--version') {
        assert.equal(env.INPUT_TOKEN, undefined);
        assert.equal(env.COMPOSAL_API_TOKEN, undefined);
        assert.equal(env.VEX_API_TOKEN, undefined);
        if (version === null) throw new Error('ENOENT');
        return version;
      }
      return f.run(exe, args, env);
    };
    await setup(f.env, run);
    assert.match((await f.state()).STATE_cli, /com-docker-builder-.*\/com$/);
    assert.equal(f.calls.filter(c => c.executable === 'curl').length, 1);
    assert.equal(f.calls.filter(c => c.executable === 'sh').length, 1);
  });
}

test('explicit preinstalled mode rejects an unsupported CLI without installing', async t => {
  const f = await fixture(t);
  const run = (exe, args, env) => args[0] === '--version' ? 'com 1.17.91' : f.run(exe, args, env);
  await assert.rejects(setup(f.env, run), /1.17.92 or newer/);
  assert.equal(f.calls.length, 0);
});


test('installation and CLI calls follow the selected hosted API', async t => {
  for (const [api, cdn] of [
    ['https://composal.com', 'https://dl.composal.com'],
    ['https://composal.ai', 'https://dl.composal.ai'],
    ['https://private.example', 'https://dl.composal.com'],
  ]) {
    const f = await fixture(t, { 'INPUT_INSTALL-CLI': 'true', 'INPUT_API-URL': api });
    await setup(f.env, f.run);
    const download = f.calls.find(c => c.executable === 'curl');
    assert.ok(download.args.includes(`${cdn}/install.sh`));
    assert.equal(f.calls.find(c => c.executable === 'sh').env.VEX_API_BASE_URL, api);
    assert.equal(f.calls.find(c => c.args[1] === 'status').env.VEX_API_BASE_URL, api);
  }
});

test('deadline kills remain retryable when the child shuts down with SIGPIPE', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(command('/bin/sh', ['-c',
    "trap 'kill -PIPE $$' TERM; while :; do sleep 0.05; done"],
  {}, 300), error => {
    assert.match(error.message, /timed out after 0.3s/);
    assert.match(error.message, /signal=SIGPIPE, killed=true/);
    return true;
  });
});

test('a child exiting on SIGPIPE without a deadline kill is not reported as a timeout', { skip: process.platform === 'win32' }, async () => {
  await assert.rejects(command('/bin/sh', ['-c', 'kill -PIPE $$'], {}), error => {
    assert.match(error.message, /command failed/);
    assert.doesNotMatch(error.message, /timed out/);
    return true;
  });
});
