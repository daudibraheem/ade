import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckSuite } from '../../src/verification/check.js';
import { applyVerification, evaluateRequirement, runChecks, toCheckResult } from '../../src/verification/verify.js';
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
