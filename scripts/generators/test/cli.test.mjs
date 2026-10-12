import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const configUrl = new URL('../lib/config.mjs', import.meta.url).href;
const dbUrl = new URL('../lib/db.mjs', import.meta.url).href;
const aiUrl = new URL('../lib/ai.mjs', import.meta.url).href;
const runUrl = new URL('../lib/run.mjs', import.meta.url).href;

function invoke(task, args) {
  const env = { ...process.env };
  for (const name of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'CLOUDFLARE_API_TOKEN']) delete env[name];
  return Bun.spawnSync({ cmd: [process.execPath,
    fileURLToPath(new URL(`../populate-${task}.mjs`, import.meta.url)), ...args], cwd: root, env });
}

test('both CLI entry points show help without credentials or reading configuration', () => {
  for (const task of ['transcriptions', 'respellings']) {
    const result = invoke(task, ['--help', '--config', '/missing-sapo-config.yml']);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.match(result.stdout.toString(), new RegExp(`scripts/generators/populate-${task}\\.mjs`));
    assert.match(result.stdout.toString(), /TURSO_DATABASE_URL/);
    assert.equal(result.stderr.toString(), '');
    assert.equal(result.stdout.toString().includes('knownCostUSD'), false);
  }
});

test('both CLI entry points report configuration failures with a nonzero exit status', () => {
  for (const task of ['transcriptions', 'respellings']) {
    const result = invoke(task, ['--config', '/missing-sapo-config.yml']);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr.toString(), /^Stopped: .*missing-sapo-config/);
    assert.equal(result.stdout.toString(), '');
  }
});

test('CLI orchestration closes the database and reports costs on success and startup/read failures', () => {
  // Isolate module mocks in a child process so other tests keep real adapters.
  for (const scenario of ['success', 'config', 'connect', 'ai', 'read']) {
    const script = `
      import { mock } from 'bun:test';
      const scenario = ${JSON.stringify(scenario)};
      const events = [];
      mock.module(${JSON.stringify(configUrl)}, () => ({ configuration: () => {
        events.push('config');
        if (scenario === 'config') throw new Error('config failed');
        return { batchSize: 1, batchSizeMultiplicity: 1, write: true };
      }, help: () => '' }));
      mock.module(${JSON.stringify(dbUrl)}, () => ({ connect: () => {
        events.push('connect');
        if (scenario === 'connect') throw new Error('connect failed');
        return { languages: async () => {
          events.push('read');
          if (scenario === 'read') throw new Error('read failed');
          return [];
        }, close: () => events.push('close') };
      } }));
      mock.module(${JSON.stringify(aiUrl)}, () => ({ createAI: () => {
        events.push('ai');
        if (scenario === 'ai') throw new Error('ai failed');
        return { totals: () => ({ known: 7000000000, uncertain: 2000000000, committed: 9000000000, usage: { input: 3 } }) };
      } }));
      const { main } = await import(${JSON.stringify(runUrl)});
      await main('transcriptions');
      console.log(JSON.stringify({ events }));
    `;
    const result = Bun.spawnSync({ cmd: [process.execPath, '--eval', script], cwd: root });
    const stdout = result.stdout.toString();
    assert.equal(result.exitCode, scenario === 'success' ? 0 : 1, result.stderr.toString());
    const metadata = JSON.parse(stdout.trim().split('\n').at(-1));
    const expected = {
      success: ['config', 'connect', 'ai', 'read', 'close'],
      config: ['config'], connect: ['config', 'connect'],
      ai: ['config', 'connect', 'ai', 'close'], read: ['config', 'connect', 'ai', 'read', 'close'],
    };
    assert.deepEqual(metadata.events, expected[scenario]);
    if (scenario === 'success' || scenario === 'read') {
      const summary = stdout.split('\n').find((line) => line.startsWith('{"knownCostUSD"'));
      assert.deepEqual(JSON.parse(summary), { knownCostUSD: 7, uncertainUpperBoundUSD: 2,
        budgetCommittedUSD: 9, usage: { input: 3 } });
    } else assert.equal(stdout.includes('knownCostUSD'), false);
    if (scenario === 'success') assert.equal(result.stderr.toString(), '');
    else assert.equal(result.stderr.toString(), `Stopped: ${scenario} failed\n`);
  }
});
