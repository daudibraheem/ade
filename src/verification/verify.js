/**
 * The verification engine: runs approved checks, turns execution records into
 * check results, and derives requirement verdicts from those results.
 *
 * Four separate questions, answered at separate levels:
 * 1. Did the command execute?            execution.status (runner.js)
 * 2. Did this check pass?                result.outcome
 * 3. Is this requirement verified?       evaluateRequirement(...).verdict
 * 4. Is the application deliverable?     domain completionBlockers(run)
 *
 * Missing results are never treated as success.
 *
 * For `node --test` checks that expect exit code 0, ADE also attaches its own
 * test reporter and requires every test file to report at least one test that
 * actually ran and passed, and none that failed. This catches a test file that
 * exits early with code 0 (for example application code calling
 * `process.exit(0)` on import) or defines no tests. It cannot catch code that
 * manipulates the test process in other ways, such as replacing `assert`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIREMENT_STATUS, RUN_STATUS } from '../domain/state-transitions.js';
import { recordRequirementEvidence, transitionRunRequirement } from '../domain/delivery-run.js';
import { InvariantViolationError } from '../domain/errors.js';
import { checksForRequirement } from './check.js';
import { EXECUTION_STATUS, runCommand } from './runner.js';

export const CHECK_OUTCOME = Object.freeze({
  PASSED: 'passed', // ran to completion with the expected exit code
  FAILED: 'failed', // ran, but exited with another code or exceeded its time limit
  ERROR: 'error', // could not be run, so it says nothing about the application
});

const NODE_TEST_REPORTER = fileURLToPath(new URL('./node-test-reporter.js', import.meta.url));
// Flags that would replace ADE's reporter or run application code in the reporter's process.
const CONFLICTING_TEST_FLAGS = ['--test-reporter', '--test-isolation'];

/**
 * Runs every check in order and returns one frozen result per check.
 *
 * @param {readonly object[]} suite from createCheckSuite
 * @param {object} options
 * @param {string} options.workspace absolute path of the application under test
 * @param {Function} [options.execute] command runner; defaults to runCommand (injectable for tests)
 * @param {Function} [options.makeId] result-id generator
 * @param {Function} [options.afterCheck] awaited after each check with (check, result) before the next
 *   one starts; if it throws, no further checks run and the error propagates
 * @param {Record<string,string>} [options.env]
 * @param {number} [options.maxOutputBytes]
 */
export async function runChecks(
  suite,
  { workspace, execute = runCommand, makeId = randomUUID, afterCheck = async () => {}, env, maxOutputBytes } = {},
) {
  const results = [];
  for (const check of suite) {
    const result = isNodeTestCheck(check)
      ? await runNodeTestCheck(check, { workspace, execute, makeId, env, maxOutputBytes })
      : toCheckResult(check, await execute(commandSpec(check, check.args, workspace), { env, maxOutputBytes }), makeId());
    results.push(result);
    await afterCheck(check, result);
  }
  return Object.freeze(results);
}

/** A `node --test` check expecting success: ADE confirms from test events that tests actually ran. */
export function isNodeTestCheck(check) {
  const node = ['node', 'node.exe'].includes(basename(check.command)) || check.command === process.execPath;
  return node && check.args.includes('--test') && check.expectExitCode === 0;
}

async function runNodeTestCheck(check, { workspace, execute, makeId, env, maxOutputBytes }) {
  if (check.args.some((a) => CONFLICTING_TEST_FLAGS.some((flag) => a.startsWith(flag)))) {
    const execution = await execute(commandSpec(check, check.args, workspace), { env, maxOutputBytes });
    return toCheckResult(check, execution, makeId(), {
      error: `The check sets ${CONFLICTING_TEST_FLAGS.join(' or ')}, so ADE cannot confirm which tests ran.`,
    });
  }
  // A private directory outside the workspace; removed again below.
  const dir = await mkdtemp(join(tmpdir(), 'ade-test-events-'));
  try {
    const eventsFile = join(dir, 'events.ndjson');
    const args = [
      '--test-reporter=spec', '--test-reporter-destination=stdout',
      `--test-reporter=${NODE_TEST_REPORTER}`, `--test-reporter-destination=${eventsFile}`,
      ...check.args,
    ];
    const execution = await execute(commandSpec(check, args, workspace), { env, maxOutputBytes });
    return toCheckResult(check, execution, makeId(), summarizeTestEvents(await readFile(eventsFile, 'utf8').catch(() => null)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function commandSpec(check, args, workspace) {
  return { command: check.command, args, workspace, cwd: check.cwd, timeoutMs: check.timeoutMs };
}

/**
 * Counts real tests from the reporter's events. The test runner reports a file
 * that finished without running any test (it exited early, or defines none)
 * as one test named after the file; that is not counted as a passing test.
 *
 * @param {string|null} text the events file, or null if it was never written
 */
export function summarizeTestEvents(text) {
  if (text === null) return { error: 'The test runner recorded no test results.' };
  const summary = { passed: 0, failed: 0, skipped: 0, filesWithoutPassingTests: [] };
  const passesPerFile = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      return { error: 'The test results could not be read.' };
    }
    if (e.type !== 'test') continue;
    if (e.skip || e.todo) {
      summary.skipped++;
      continue;
    }
    if (!passesPerFile.has(e.file)) passesPerFile.set(e.file, 0);
    if (e.event === 'test:fail') summary.failed++;
    else if (!isFileItself(e)) {
      summary.passed++;
      passesPerFile.set(e.file, passesPerFile.get(e.file) + 1);
    }
  }
  summary.filesWithoutPassingTests = [...passesPerFile].filter(([, n]) => n === 0).map(([file]) => file);
  return summary;
}

function isFileItself(event) {
  const slash = (p) => String(p ?? '').replaceAll('\\', '/');
  return event.nesting === 0 && (slash(event.file) === slash(event.name) || slash(event.file).endsWith(`/${slash(event.name)}`));
}

/**
 * @param {object} [tests] test-run summary for `node --test` checks (see summarizeTestEvents);
 *   when given, a passing exit code is only accepted with evidence that tests ran and passed
 */
export function toCheckResult(check, execution, id, tests) {
  const { outcome, reason } = judge(check, execution, tests);
  return Object.freeze({
    id,
    checkId: check.id,
    requirementIds: check.requirementIds,
    outcome,
    reason,
    expectExitCode: check.expectExitCode,
    ...(tests && { tests: Object.freeze(tests) }),
    execution,
  });
}

function judge(check, execution, tests) {
  const exit = judgeExit(check, execution);
  if (exit.outcome !== CHECK_OUTCOME.PASSED || tests === undefined) return exit;
  if (tests.error) return { outcome: CHECK_OUTCOME.ERROR, reason: `Exited with code 0, but ${tests.error}` };
  if (tests.failed) return { outcome: CHECK_OUTCOME.FAILED, reason: `Exited with code 0, but ${tests.failed} test(s) failed.` };
  if (tests.passed === 0) {
    return {
      outcome: CHECK_OUTCOME.FAILED,
      reason: 'Exited with code 0, but no test actually ran and passed (a test file exited early or defines no tests).',
    };
  }
  if (tests.filesWithoutPassingTests.length) {
    return {
      outcome: CHECK_OUTCOME.FAILED,
      reason: `Exited with code 0, but no test ran and passed in: ${tests.filesWithoutPassingTests.join(', ')}.`,
    };
  }
  return { outcome: CHECK_OUTCOME.PASSED, reason: `Exited with expected code 0; ${tests.passed} test(s) ran and passed.` };
}

function judgeExit(check, execution) {
  switch (execution.status) {
    case EXECUTION_STATUS.COULD_NOT_START:
      return { outcome: CHECK_OUTCOME.ERROR, reason: `Could not start: ${execution.error?.message ?? 'unknown error'}` };
    case EXECUTION_STATUS.TIMED_OUT:
      return { outcome: CHECK_OUTCOME.FAILED, reason: `Timed out after ${check.timeoutMs} ms.` };
    case EXECUTION_STATUS.COMPLETED:
      if (execution.exitCode === check.expectExitCode) {
        return { outcome: CHECK_OUTCOME.PASSED, reason: `Exited with expected code ${check.expectExitCode}.` };
      }
      return {
        outcome: CHECK_OUTCOME.FAILED,
        reason:
          execution.exitCode === null
            ? `Terminated by signal ${execution.signal}.`
            : `Exited with code ${execution.exitCode}, expected ${check.expectExitCode}.`,
      };
    default:
      return { outcome: CHECK_OUTCOME.ERROR, reason: `Unknown execution status "${execution.status}".` };
  }
}

/**
 * Derives a requirement's verdict from check results. Every check that
 * targets the requirement must have a passing latest result for `verified`.
 * Any failing check makes it `failed`; otherwise any missing or errored check
 * makes it `unverified`.
 */
export function evaluateRequirement(requirement, suite, results) {
  const checks = checksForRequirement(suite, requirement);
  const latest = new Map();
  for (const result of results) latest.set(result.checkId, result);

  const reasons = [];
  const used = [];
  let failed = false;
  let incomplete = checks.length === 0;
  if (checks.length === 0) reasons.push('No verification checks are configured for this requirement.');

  for (const check of checks) {
    const result = latest.get(check.id);
    if (!result) {
      incomplete = true;
      reasons.push(`Check "${check.id}" has no result.`);
      continue;
    }
    used.push(result);
    if (result.outcome === CHECK_OUTCOME.FAILED) failed = true;
    if (result.outcome === CHECK_OUTCOME.ERROR) incomplete = true;
    if (result.outcome !== CHECK_OUTCOME.PASSED) reasons.push(`Check "${check.id}": ${result.reason}`);
  }

  let verdict = REQUIREMENT_STATUS.VERIFIED;
  if (failed) verdict = REQUIREMENT_STATUS.FAILED;
  else if (incomplete) verdict = REQUIREMENT_STATUS.UNVERIFIED;

  return Object.freeze({
    requirementId: requirement.id,
    verdict,
    reasons: Object.freeze(reasons),
    checkIds: Object.freeze(checks.map((c) => c.id)),
    resultIds: Object.freeze(used.map((r) => r.id)),
  });
}

/**
 * Records check results as evidence on a `verifying` run and moves every
 * requirement to its derived verdict. The domain re-checks each verdict
 * against the recorded evidence, so the engine cannot over-claim.
 *
 * @returns {{ run: object, evaluations: object[] }}
 */
export function applyVerification(run, suite, results, { now } = {}) {
  if (run.status !== RUN_STATUS.VERIFYING) {
    throw new InvariantViolationError(`Verification can only be applied while the run is "verifying".`, {
      code: 'RUN_STATUS_DISALLOWS',
      details: { runId: run.id, status: run.status },
    });
  }
  const evaluations = [];
  let next = run;
  for (const requirement of run.requirements) {
    if (requirement.status !== REQUIREMENT_STATUS.PENDING) {
      next = transitionRunRequirement(next, requirement.id, REQUIREMENT_STATUS.PENDING, { now });
    }
    const evaluation = evaluateRequirement(requirement, suite, results);
    for (const resultId of evaluation.resultIds) {
      const result = results.find((r) => r.id === resultId);
      next = recordRequirementEvidence(
        next,
        requirement.id,
        { checkId: result.checkId, passed: result.outcome === CHECK_OUTCOME.PASSED, summary: result.reason, resultId },
        { now },
      );
    }
    next = transitionRunRequirement(next, requirement.id, evaluation.verdict, { now });
    evaluations.push(evaluation);
  }
  return { run: next, evaluations: Object.freeze(evaluations) };
}
