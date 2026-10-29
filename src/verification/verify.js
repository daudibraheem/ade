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
 */
import { randomUUID } from 'node:crypto';
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

/**
 * Runs every check in order and returns one frozen result per check.
 *
 * @param {readonly object[]} suite from createCheckSuite
 * @param {object} options
 * @param {string} options.workspace absolute path of the application under test
 * @param {Function} [options.execute] command runner; defaults to runCommand (injectable for tests)
 * @param {Function} [options.makeId] result-id generator
 * @param {Record<string,string>} [options.env]
 * @param {number} [options.maxOutputBytes]
 */
export async function runChecks(suite, { workspace, execute = runCommand, makeId = randomUUID, env, maxOutputBytes } = {}) {
  const results = [];
  for (const check of suite) {
    const execution = await execute(
      { command: check.command, args: check.args, workspace, cwd: check.cwd, timeoutMs: check.timeoutMs },
      { env, maxOutputBytes },
    );
    results.push(toCheckResult(check, execution, makeId()));
  }
  return Object.freeze(results);
}

export function toCheckResult(check, execution, id) {
  const { outcome, reason } = judge(check, execution);
  return Object.freeze({
    id,
    checkId: check.id,
    requirementIds: check.requirementIds,
    outcome,
    reason,
    expectExitCode: check.expectExitCode,
    execution,
  });
}

function judge(check, execution) {
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
