import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliver, orderTasks } from '../../src/controller/delivery.js';
import { prepareDelivery } from '../../src/controller/spec.js';
import { buildReport, renderMarkdown, writeEvidence } from '../../src/report/report.js';
import { ValidationError } from '../../src/domain/errors.js';

const GOOD = 'exports.add = (a, b) => a + b;\n';
const BAD = 'exports.add = (a, b) => a - b;\n';
const ACCEPTANCE = `const test = require('node:test');
const assert = require('node:assert');
const { add } = require('../math.js');
test('adds', () => assert.equal(add(2, 3), 5));
`;

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ade-delivery-'));
  await mkdir(join(dir, 'approved'));
  await writeFile(join(dir, 'approved', 'math.test.js'), ACCEPTANCE);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function spec(overrides = {}) {
  return {
    request: 'A math library with add',
    workspace: './workspace',
    maxRepairAttempts: 2,
    requirements: [{ id: 'FR1', description: 'add returns the sum', acceptanceCriteria: ['add(2,3) is 5'], checkIds: ['acceptance'] }],
    tasks: [{ id: 'T1', title: 'Implement add', description: 'Create math.js', requirementIds: ['FR1'] }],
    checks: [{ id: 'acceptance', command: process.execPath, args: ['--test', 'acceptance/**/*.test.js'], timeoutMs: 20_000, requirementIds: ['FR1'] }],
    protectedFiles: [{ from: 'approved/math.test.js', to: 'acceptance/math.test.js' }],
    ...overrides,
  };
}

/** A fake agent that performs one scripted action per session and records its prompts. */
function scriptedAgent(actions) {
  const prompts = [];
  return {
    name: 'fake',
    prompts,
    async implement({ workspace, prompt }) {
      prompts.push(prompt);
      const action = actions[prompts.length - 1] ?? (() => {});
      const ok = (await action(workspace)) !== false;
      return { ok, claim: 'All done, everything works!', execution: { status: 'completed', exitCode: ok ? 0 : 1, durationMs: 1 } };
    },
  };
}

const writeMath = (code) => (ws) => writeFile(join(ws, 'math.js'), code);

describe('deliver', () => {
  it('delivers when independent checks pass on the first round', async () => {
    const agent = scriptedAgent([writeMath(GOOD)]);
    const result = await deliver(prepareDelivery(spec(), dir), { agent });
    assert.equal(result.outcome.delivered, true);
    assert.equal(result.run.status, 'completed');
    assert.equal(result.rounds.length, 1);
    assert.equal(result.rounds[0].results[0].execution.exitCode, 0);
    assert.equal(result.run.requirements[0].evidence[0].resultId, 'round1-acceptance');
  });

  it('repairs a failing implementation and re-verifies it', async () => {
    const agent = scriptedAgent([writeMath(BAD), writeMath(GOOD)]);
    const result = await deliver(prepareDelivery(spec(), dir), { agent });
    assert.equal(result.outcome.delivered, true);
    assert.equal(result.run.repairAttempts, 1);
    assert.deepEqual(result.rounds.map((r) => r.evaluations[0].verdict), ['failed', 'verified']);
    assert.match(agent.prompts[1], /Check acceptance: Exited with code 1/);
    assert.match(agent.prompts[1], /node:test|assert|fail/i, 'repair prompt includes actual check output');
    assert.deepEqual(result.run.tasks.map((t) => t.id), ['T1', 'repair-1']);
  });

  it('stops after the repair limit and does not deliver, despite the agent claiming success', async () => {
    const agent = scriptedAgent([writeMath(BAD), writeMath(BAD), writeMath(BAD)]);
    const result = await deliver(prepareDelivery(spec(), dir), { agent });
    assert.equal(result.outcome.delivered, false);
    assert.equal(result.run.status, 'failed');
    assert.equal(result.rounds.length, 3);
    assert.equal(agent.prompts.length, 3);
    assert.match(result.outcome.reason, /after 2 repair attempt/);
  });

  it('restores protected acceptance tests that the agent weakened', async () => {
    const tamper = async (ws) => {
      await writeMath(BAD)(ws);
      await mkdir(join(ws, 'acceptance'), { recursive: true });
      await writeFile(join(ws, 'acceptance', 'math.test.js'), "require('node:test')('ok', () => {});\n");
    };
    const result = await deliver(prepareDelivery(spec({ maxRepairAttempts: 0 }), dir), { agent: scriptedAgent([tamper]) });
    assert.equal(result.outcome.delivered, false);
    assert.equal(await readFile(join(dir, 'workspace', 'acceptance', 'math.test.js'), 'utf8'), ACCEPTANCE);
    assert.equal(result.protectedFiles[0].files[0].path, 'acceptance/math.test.js');
  });

  it('gives the agent the acceptance tests to read before it starts', async () => {
    let seen;
    const peek = async (ws) => {
      seen = await readFile(join(ws, 'acceptance', 'math.test.js'), 'utf8');
      await writeMath(GOOD)(ws);
    };
    await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([peek]) });
    assert.equal(seen, ACCEPTANCE);
  });

  it('does not verify or deliver when the agent session fails', async () => {
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([() => false]) });
    assert.equal(result.outcome.delivered, false);
    assert.equal(result.rounds.length, 0);
    assert.equal(result.run.tasks[0].status, 'failed');
  });

  it('treats a check that cannot start as unverified, never as passed', async () => {
    const checks = [{ id: 'acceptance', command: 'ade-missing-tool', requirementIds: ['FR1'] }];
    const result = await deliver(prepareDelivery(spec({ checks, maxRepairAttempts: 0 }), dir), {
      agent: scriptedAgent([writeMath(GOOD)]),
    });
    assert.equal(result.outcome.delivered, false);
    assert.equal(result.rounds[0].evaluations[0].verdict, 'unverified');
  });
});

describe('prepareDelivery', () => {
  it('rejects a spec whose requirement declares a missing check before anything runs', () => {
    assert.throws(() => prepareDelivery(spec({ checks: [] }), dir), (e) => e instanceof ValidationError && e.code === 'UNKNOWN_CHECK');
  });

  it('rejects protected files that target outside the workspace', () => {
    const protectedFiles = [{ from: 'approved/math.test.js', to: '../escape.js' }];
    assert.throws(() => prepareDelivery(spec({ protectedFiles }), dir), (e) => e.code === 'UNSAFE_PATH');
  });

  it('rejects unknown spec fields', () => {
    assert.throws(() => prepareDelivery(spec({ shell: true }), dir), (e) => e.code === 'UNKNOWN_FIELD');
  });
});

describe('orderTasks', () => {
  it('orders tasks after their dependencies', () => {
    const tasks = [{ id: 'b', dependsOn: ['a'] }, { id: 'a', dependsOn: [] }];
    assert.deepEqual(orderTasks(tasks).map((t) => t.id), ['a', 'b']);
  });
});

describe('delivery report', () => {
  it('reports the decision from evidence and labels agent claims as not evidence', async () => {
    const agent = scriptedAgent([writeMath(BAD), writeMath(BAD), writeMath(BAD)]);
    const delivery = await deliver(prepareDelivery(spec(), dir), { agent });
    const report = buildReport(delivery);
    assert.equal(report.decision, 'NOT DELIVERED');
    assert.equal(report.requirements[0].status, 'failed');
    assert.equal(report.rounds.length, 3);
    const md = renderMarkdown(report);
    assert.match(md, /# ADE delivery report: NOT DELIVERED/);
    assert.match(md, /Agent claims \(not evidence\)/);
    assert.match(md, /All done, everything works!/);

    const paths = await writeEvidence(join(dir, 'out'), delivery);
    const saved = JSON.parse(await readFile(join(dir, 'out', 'results', 'round1-acceptance.json'), 'utf8'));
    assert.equal(saved.execution.exitCode, 1);
    assert.match(await readFile(paths.reportMarkdown, 'utf8'), /round1-acceptance/);
  });
});
