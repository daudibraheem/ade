import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckSuite } from '../../src/verification/check.js';
import { applyVerification, evaluateRequirement, runChecks, summarizeTestEvents, toCheckResult } from '../../src/verification/verify.js';
import { completionBlockers, createDeliveryRun, transitionRun, transitionRunTask } from '../../src/domain/delivery-run.js';
import { InvariantViolationError } from '../../src/domain/errors.js';

const completed = (exitCode) => ({ status: 'completed', exitCode, signal: null, timedOut: false, error: null });
const timedOut = { status: 'timed_out', exitCode: null, signal: 'SIGKILL', timedOut: true, error: null };
const notStarted = { status: 'could_not_start', exitCode: null, signal: null, timedOut: false, error: { code: 'ENOENT', message: 'spawn x ENOENT' } };

function fixture() {
  const run = createDeliveryRun({
    id: 'run-1',
    request: 'Todo app',
    requirements: [
      { id: 'req-add', description: 'Add todos', checkIds: ['unit-add'] },
      { id: 'req-list', description: 'List todos', checkIds: ['unit-list'] },
    ],
    tasks: [{ id: 't1', title: 'Build', description: 'Build it', requirementIds: ['req-add', 'req-list'] }],
  });
  const suite = createCheckSuite(
    [
      { id: 'unit-add', command: 'npm', args: ['test'], requirementIds: ['req-add'] },
      { id: 'unit-list', command: 'npm', args: ['test'], requirementIds: ['req-list'] },
      { id: 'smoke', command: 'node', args: ['smoke.js'], requirementIds: ['req-add', 'req-list'] },
    ],
    run.requirements,
  );
  return { run, suite };
}

function verifyingRun(run) {
  let r = transitionRun(transitionRun(run, 'planning'), 'executing');
  r = ['ready', 'in_progress', 'completed'].reduce((acc, s) => transitionRunTask(acc, 't1', s), r);
  return transitionRun(r, 'verifying');
}

const results = (suite, byCheck) => suite.map((c) => toCheckResult(c, byCheck[c.id], `res-${c.id}`));

describe('toCheckResult', () => {
  const { suite } = fixture();
  const check = suite[0];

  it('passes only on the expected exit code', () => {
    assert.equal(toCheckResult(check, completed(0), 'r').outcome, 'passed');
    assert.equal(toCheckResult(check, completed(1), 'r').outcome, 'failed');
  });

  it('treats a timeout as a failure', () => {
    assert.equal(toCheckResult(check, timedOut, 'r').outcome, 'failed');
  });

  it('treats a command that never started as an error, not a pass', () => {
    const result = toCheckResult(check, notStarted, 'r');
    assert.equal(result.outcome, 'error');
    assert.match(result.reason, /Could not start/);
  });

  it('keeps the raw execution record and requirement links', () => {
    const result = toCheckResult(check, completed(0), 'r');
    assert.deepEqual(result.requirementIds, ['req-add']);
    assert.equal(result.execution.exitCode, 0);
  });
});

describe('evaluateRequirement', () => {
  const { run, suite } = fixture();
  const [add] = run.requirements;

  it('is verified only when every relevant check passed', () => {
    const ev = evaluateRequirement(add, suite, results(suite, { 'unit-add': completed(0), 'unit-list': completed(1), smoke: completed(0) }));
    assert.equal(ev.verdict, 'verified');
    assert.deepEqual(ev.checkIds, ['unit-add', 'smoke']);
  });

  it('is failed when any relevant check failed', () => {
    const ev = evaluateRequirement(add, suite, results(suite, { 'unit-add': completed(0), 'unit-list': completed(0), smoke: completed(2) }));
    assert.equal(ev.verdict, 'failed');
    assert.match(ev.reasons[0], /smoke/);
  });

  it('is unverified when a relevant check has no result', () => {
    const partial = results(suite, { 'unit-add': completed(0), 'unit-list': completed(0), smoke: completed(0) }).filter(
      (r) => r.checkId !== 'smoke',
    );
    const ev = evaluateRequirement(add, suite, partial);
    assert.equal(ev.verdict, 'unverified');
    assert.match(ev.reasons[0], /no result/);
  });

  it('is unverified when a relevant check could not run', () => {
    const ev = evaluateRequirement(add, suite, results(suite, { 'unit-add': completed(0), 'unit-list': completed(0), smoke: notStarted }));
    assert.equal(ev.verdict, 'unverified');
  });

  it('is unverified when no checks are configured', () => {
    assert.equal(evaluateRequirement({ id: 'req-x', checkIds: [] }, suite, []).verdict, 'unverified');
  });

  it('uses the latest result when a check was re-run', () => {
    const first = results(suite, { 'unit-add': completed(1), 'unit-list': completed(0), smoke: completed(0) });
    const rerun = toCheckResult(suite[0], completed(0), 'res-rerun');
    assert.equal(evaluateRequirement(add, suite, [...first, rerun]).verdict, 'verified');
  });
});

describe('runChecks', () => {
  it('runs every check through the executor and passes its parameters', async () => {
    const { suite } = fixture();
    const calls = [];
    const execute = async (spec) => {
      calls.push(spec);
      return completed(0);
    };
    let n = 0;
    const out = await runChecks(suite, { workspace: '/ws', execute, makeId: () => `id-${++n}` });
    assert.equal(out.length, 3);
    assert.deepEqual(calls[2], { command: 'node', args: ['smoke.js'], workspace: '/ws', cwd: '.', timeoutMs: 60_000 });
    assert.deepEqual(out.map((r) => r.id), ['id-1', 'id-2', 'id-3']);
  });
});

describe('runChecks afterCheck', () => {
  it('runs the hook after each check and stops when it throws', async () => {
    const { suite } = fixture();
    const ran = [];
    const execute = async (spec) => (ran.push(spec.args.join(' ')), completed(0));
    const afterCheck = async (check) => {
      if (check.id === 'unit-add') throw new Error('stop');
    };
    await assert.rejects(runChecks(suite, { workspace: '/ws', execute, afterCheck }), /stop/);
    assert.equal(ran.length, 1, 'no further check started');
  });
});

describe('node --test evidence', () => {
  let ws;
  before(async () => {
    ws = await mkdtemp(join(tmpdir(), 'ade-node-test-'));
  });
  after(() => rm(ws, { recursive: true, force: true }));

  const TEST = "const test = require('node:test'); const assert = require('node:assert');\n";
  async function check(files, { args } = {}) {
    for (const [name, content] of Object.entries(files)) await writeFile(join(ws, name), content);
    const testFiles = Object.keys(files).filter((f) => f.endsWith('.test.js'));
    const suite = createCheckSuite(
      [{ id: 'acc', command: process.execPath, args: args ?? ['--test', ...testFiles], timeoutMs: 20_000, requirementIds: ['FR1'] }],
      [{ id: 'FR1', checkIds: ['acc'] }],
    );
    const [result] = await runChecks(suite, { workspace: ws });
    return result;
  }

  it('passes when a real test ran and passed', async () => {
    const result = await check({ 'a.cjs': 'exports.add = (a, b) => a + b;', 'ok.test.js': `${TEST}test('adds', () => assert.equal(require('./a.cjs').add(2, 2), 4));` });
    assert.equal(result.outcome, 'passed', result.reason);
    assert.equal(result.tests.passed, 1);
    assert.match(result.reason, /1 test\(s\) ran and passed/);
  });

  it('fails a wrong implementation that forces exit code 0 on import', async () => {
    const result = await check({ 'b.cjs': 'exports.add = () => 5; process.exit(0);', 'exit.test.js': `${TEST}test('adds', () => assert.equal(require('./b.cjs').add(2, 2), 4));` });
    assert.equal(result.execution.exitCode, 0, 'the process really exited 0');
    assert.equal(result.outcome, 'failed');
    assert.match(result.reason, /no test actually ran and passed/);
  });

  it('fails a test file that defines no tests', async () => {
    const result = await check({ 'zero.test.js': '// no tests\n' });
    assert.equal(result.execution.exitCode, 0);
    assert.equal(result.outcome, 'failed');
  });

  it('fails when every test was skipped', async () => {
    const result = await check({ 'skip.test.js': `${TEST}test.skip('adds', () => assert.fail());` });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.tests.skipped, 1);
  });

  it('fails when one of several test files ran no test', async () => {
    const result = await check({
      'c.cjs': 'exports.ok = true;',
      'good.test.js': `${TEST}test('ok', () => assert.ok(require('./c.cjs').ok));`,
      'early.test.js': `${TEST}process.exit(0); test('never', () => {});`,
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.tests.filesWithoutPassingTests.length, 1);
    assert.match(result.tests.filesWithoutPassingTests[0], /early\.test\.js$/);
  });

  it('ignores fake test results printed by application code', async () => {
    const fake = JSON.stringify({ event: 'test:pass', name: 'adds', nesting: 0, type: 'test' });
    const result = await check({
      'd.cjs': `console.log(${JSON.stringify(fake)}); console.log('# pass 5'); process.exit(0);`,
      'spoof.test.js': `${TEST}require('./d.cjs'); test('adds', () => {});`,
    });
    assert.equal(result.outcome, 'failed');
  });

  it('reports an error when the check replaces the test reporter', async () => {
    const result = await check({ 'own.test.js': `${TEST}test('ok', () => {});` }, { args: ['--test', '--test-reporter=tap', 'own.test.js'] });
    assert.equal(result.outcome, 'error');
    assert.match(result.reason, /cannot confirm which tests ran/);
  });

  it('does not count todo tests or the file itself', () => {
    const lines = [
      { event: 'test:pass', name: 'x.test.js', nesting: 0, file: '/w/x.test.js', type: 'test' },
      { event: 'test:fail', name: 'later', nesting: 0, file: '/w/x.test.js', type: 'test', todo: true },
    ].map((e) => JSON.stringify(e)).join('\n');
    assert.deepEqual(summarizeTestEvents(lines), { passed: 0, failed: 0, skipped: 1, filesWithoutPassingTests: ['/w/x.test.js'] });
    assert.ok(summarizeTestEvents(null).error);
  });
});

describe('applyVerification', () => {
  it('records evidence and lets the run complete when everything passed', () => {
    const { run, suite } = fixture();
    const res = results(suite, { 'unit-add': completed(0), 'unit-list': completed(0), smoke: completed(0) });
    const { run: next } = applyVerification(verifyingRun(run), suite, res);
    assert.deepEqual(next.requirements.map((r) => r.status), ['verified', 'verified']);
    assert.deepEqual(next.requirements[0].evidence.map((e) => e.resultId), ['res-unit-add', 'res-smoke']);
    assert.deepEqual(completionBlockers(next), []);
  });

  it('blocks completion when a check failed or could not run', () => {
    const { run, suite } = fixture();
    const res = results(suite, { 'unit-add': completed(1), 'unit-list': notStarted, smoke: completed(0) });
    const { run: next, evaluations } = applyVerification(verifyingRun(run), suite, res);
    assert.deepEqual(evaluations.map((e) => e.verdict), ['failed', 'unverified']);
    assert.throws(() => transitionRun(next, 'completed'), InvariantViolationError);
  });

  it('re-assesses requirements from a previous verification round', () => {
    const { run, suite } = fixture();
    const failing = results(suite, { 'unit-add': completed(1), 'unit-list': completed(0), smoke: completed(0) });
    let next = applyVerification(verifyingRun(run), suite, failing).run;
    next = transitionRun(transitionRun(next, 'repairing'), 'verifying');
    const passing = results(suite, { 'unit-add': completed(0), 'unit-list': completed(0), smoke: completed(0) });
    next = applyVerification(next, suite, passing).run;
    assert.equal(next.requirements[0].status, 'verified');
    assert.ok(next.requirements[0].evidence.every((e) => e.passed), 'stale failing evidence was discarded');
  });

  it('refuses to apply outside the verifying phase', () => {
    const { run, suite } = fixture();
    assert.throws(() => applyVerification(run, suite, []), InvariantViolationError);
  });
});
