import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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
const WEAK = "require('node:test')('ok', () => {});\n";
const APPROVED_SHA = createHash('sha256').update(ACCEPTANCE).digest('hex');

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
    protectedFiles: [{ from: 'approved/math.test.js', to: 'acceptance/math.test.js', sha256: APPROVED_SHA }],
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
    const protectedFiles = [{ from: 'approved/math.test.js', to: '../escape.js', sha256: APPROVED_SHA }];
    assert.throws(() => prepareDelivery(spec({ protectedFiles }), dir), (e) => e.code === 'UNSAFE_PATH');
  });

  it('rejects protected files without an approved hash', () => {
    const protectedFiles = [{ from: 'approved/math.test.js', to: 'acceptance/math.test.js' }];
    assert.throws(() => prepareDelivery(spec({ protectedFiles }), dir), (e) => e.code === 'MISSING_HASH' && /sha256sum/.test(e.message));
  });

  it('rejects a malformed approved hash', () => {
    const protectedFiles = [{ from: 'approved/math.test.js', to: 'acceptance/math.test.js', sha256: APPROVED_SHA.toUpperCase() }];
    assert.throws(() => prepareDelivery(spec({ protectedFiles }), dir), (e) => e.code === 'MISSING_HASH');
  });

  it('rejects unknown spec fields', () => {
    assert.throws(() => prepareDelivery(spec({ shell: true }), dir), (e) => e.code === 'UNKNOWN_FIELD');
  });
});

describe('approval integrity', () => {
  const ws = (...parts) => join(dir, 'workspace', ...parts);
  const approved = () => join(dir, 'approved', 'math.test.js');

  it('accepts unmodified approved tests and records their approved hashes per round', async () => {
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([writeMath(GOOD)]) });
    assert.equal(result.outcome.delivered, true);
    assert.equal(result.integrityFailure, null);
    assert.deepEqual(result.protectedFiles[0].files, [{ path: 'acceptance/math.test.js', sha256: APPROVED_SHA }]);
  });

  it('rejects an approved test changed after approval, before any agent runs', async () => {
    await writeFile(approved(), WEAK);
    const agent = scriptedAgent([writeMath(GOOD)]);
    const result = await deliver(prepareDelivery(spec(), dir), { agent });
    assert.equal(result.outcome.delivered, false);
    assert.equal(result.run.status, 'failed');
    assert.equal(agent.prompts.length, 0);
    assert.equal(result.rounds.length, 0);
    assert.equal(result.integrityFailure.code, 'APPROVED_SOURCE_CHANGED');
    assert.equal(result.integrityFailure.problems[0].problem, 'changed');
    assert.match(result.outcome.reason, /approve again/);
  });

  it('rejects an approved test deleted after approval', async () => {
    await unlink(approved());
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([writeMath(GOOD)]) });
    assert.equal(result.integrityFailure.problems[0].problem, 'missing');
    assert.equal(result.outcome.delivered, false);
  });

  it('rejects a workspace test the agent modified, without running checks', async () => {
    const tamper = async (w) => {
      await writeMath(BAD)(w);
      await writeFile(join(w, 'acceptance', 'math.test.js'), WEAK);
    };
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([tamper]) });
    assert.equal(result.outcome.delivered, false);
    assert.equal(result.rounds.length, 0, 'no checks ran against the altered test');
    assert.equal(result.integrityFailure.code, 'WORKSPACE_TESTS_ALTERED');
    assert.equal(result.integrityFailure.round, 1);
    assert.deepEqual(result.integrityFailure.problems.map((p) => [p.path, p.problem]), [['acceptance/math.test.js', 'changed']]);
  });

  it('rejects a workspace test the agent deleted', async () => {
    const remove = async (w) => {
      await writeMath(GOOD)(w);
      await unlink(join(w, 'acceptance', 'math.test.js'));
    };
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([remove]) });
    assert.deepEqual(result.integrityFailure.problems.map((p) => p.problem), ['missing']);
  });

  it('rejects a workspace test replaced by a symlink', async () => {
    const swap = async (w) => {
      await writeMath(GOOD)(w);
      await unlink(join(w, 'acceptance', 'math.test.js'));
      await symlink(approved(), join(w, 'acceptance', 'math.test.js'));
    };
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([swap]) });
    assert.equal(result.outcome.delivered, false);
    assert.equal(result.integrityFailure.problems[0].problem, 'missing');
  });

  it('rejects an unexpected file added to the closed acceptance directory', async () => {
    const add = async (w) => {
      await writeMath(GOOD)(w);
      await mkdir(join(w, 'acceptance', 'nested'), { recursive: true });
      await writeFile(join(w, 'acceptance', 'nested', 'extra.test.js'), WEAK);
    };
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([add]) });
    assert.equal(result.outcome.delivered, false);
    assert.deepEqual(result.integrityFailure.problems, [{ path: 'acceptance/nested/extra.test.js', problem: 'unexpected' }]);
  });

  it('allows files outside the acceptance directory', async () => {
    const add = async (w) => {
      await writeMath(GOOD)(w);
      await writeFile(join(w, 'helper.js'), '// fine\n');
    };
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([add]) });
    assert.equal(result.outcome.delivered, true);
  });

  it('a repair attempt cannot weaken the tests, even by rewriting the approved source', async () => {
    const cheat = async (w) => {
      await writeFile(approved(), WEAK);
      await writeFile(join(w, 'acceptance', 'math.test.js'), WEAK);
    };
    const agent = scriptedAgent([writeMath(BAD), cheat]);
    const result = await deliver(prepareDelivery(spec(), dir), { agent });
    assert.equal(agent.prompts.length, 2, 'the repair session ran');
    assert.equal(result.outcome.delivered, false);
    assert.equal(result.rounds.length, 1, 'no verification round ran after the cheating repair');
    assert.equal(result.integrityFailure.round, 2);
    assert.equal(result.integrityFailure.code, 'APPROVED_SOURCE_CHANGED');
    assert.equal(result.run.requirements[0].status, 'failed', 'the requirement keeps its last real verdict');
  });

  it('a repair attempt cannot replace the workspace test alone', async () => {
    const cheat = (w) => writeFile(join(w, 'acceptance', 'math.test.js'), WEAK);
    const result = await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([writeMath(BAD), cheat]) });
    assert.equal(result.outcome.delivered, false);
    assert.equal(result.integrityFailure.code, 'WORKSPACE_TESTS_ALTERED');
  });

  it('tells the agent which tests and directories are read-only', async () => {
    const agent = scriptedAgent([writeMath(BAD), writeMath(GOOD)]);
    await deliver(prepareDelivery(spec(), dir), { agent });
    for (const prompt of agent.prompts) {
      assert.match(prompt, /acceptance\/math\.test\.js\) are read-only/);
      assert.match(prompt, /Do not add, change or delete any file in acceptance\//);
    }
  });

  it('reports the integrity failure', async () => {
    await writeFile(approved(), WEAK);
    const md = renderMarkdown(buildReport(await deliver(prepareDelivery(spec(), dir), { agent: scriptedAgent([]) })));
    assert.match(md, /## Integrity failure/);
    assert.match(md, /Before implementation \(`APPROVED_SOURCE_CHANGED`\)/);
    assert.match(md, /approved sha256 `[0-9a-f]{16}…`, found `[0-9a-f]{16}…`/);
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
