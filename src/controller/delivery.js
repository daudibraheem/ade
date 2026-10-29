/**
 * The delivery controller: drives one delivery run end to end.
 *
 *   plan -> execute tasks with the agent -> verify -> (repair -> verify)* -> decide
 *
 * The agent's success only moves a task to `completed`. Requirements are
 * decided solely by the verification engine's results, and the run can only
 * be completed when the domain model's delivery rules are satisfied.
 */
import {
  addTask,
  completionBlockers,
  transitionRun,
  transitionRunTask,
} from '../domain/delivery-run.js';
import { REQUIREMENT_STATUS, RUN_STATUS, TASK_STATUS } from '../domain/state-transitions.js';
import { applyVerification, runChecks } from '../verification/verify.js';
import { prepareWorkspace } from './workspace.js';
import { IntegrityError, closedDirectories, placeProtectedFiles, verifyApprovedSources, verifyWorkspaceTests } from './integrity.js';

const OUTPUT_TAIL = 3000;

/**
 * @param {object} prepared output of prepareDelivery / loadSpec
 * @param {object} deps
 * @param {{ implement: Function, name: string }} deps.agent
 * @param {Function} [deps.execute] command runner for checks (injectable for tests)
 * @param {Function} [deps.onEvent] progress callback: ({ type, ... }) => void
 * @param {string} [deps.tempRoot] where fresh workspaces are created (default: OS temp directory)
 * @throws {WorkspaceError} before anything runs, if the workspace is not empty or not isolated
 */
export async function deliver({ run, suite, workspace, protectedFiles = [] }, { agent, execute, onEvent = () => {}, tempRoot }) {
  workspace = await prepareWorkspace(workspace, { runId: run.id, tempRoot });
  const record = { workspace, rounds: [], agentSessions: [], protectedFiles: [], integrityFailure: null, outcome: null };
  onEvent({ type: 'workspace', workspace });
  // Place the approved tests once, so the agent can read what it will be judged by.
  try {
    await placeProtectedFiles(workspace, protectedFiles);
  } catch (error) {
    return integrityFailed(run, record, error, 0, onEvent);
  }

  run = transitionRun(transitionRun(run, RUN_STATUS.PLANNING), RUN_STATUS.EXECUTING);
  onEvent({ type: 'executing', tasks: run.tasks.length });

  for (const task of orderTasks(run.tasks)) {
    const prompt = implementationPrompt(run, task, suite, protectedFiles);
    const outcome = await runTask(run, task, agent, workspace, prompt, record, onEvent);
    run = outcome.run;
    if (!outcome.ok) return finish(run, record, `Coding agent did not complete task "${task.id}".`, onEvent);
  }

  run = transitionRun(run, RUN_STATUS.VERIFYING);
  for (;;) {
    try {
      run = await verificationRound(run, suite, workspace, protectedFiles, record, execute, onEvent);
    } catch (error) {
      return integrityFailed(run, record, error, record.rounds.length + 1, onEvent);
    }
    if (completionBlockers(run).length === 0) {
      return finish(transitionRun(run, RUN_STATUS.COMPLETED), record, 'All required requirements verified.', onEvent);
    }
    if (run.repairAttempts >= run.maxRepairAttempts) {
      return finish(run, record, `Requirements not verified after ${run.repairAttempts} repair attempt(s).`, onEvent);
    }

    run = transitionRun(run, RUN_STATUS.REPAIRING);
    const failing = run.requirements.filter((r) => r.status !== REQUIREMENT_STATUS.VERIFIED);
    const repairId = `repair-${run.repairAttempts}`;
    run = addTask(run, {
      id: repairId,
      title: `Repair attempt ${run.repairAttempts}`,
      description: `Fix failing verification for: ${failing.map((r) => r.id).join(', ')}`,
      requirementIds: failing.map((r) => r.id),
    });
    const task = run.tasks.at(-1);
    const prompt = repairPrompt(run, failing, suite, record.rounds.at(-1), protectedFiles);
    const outcome = await runTask(run, task, agent, workspace, prompt, record, onEvent);
    run = outcome.run;
    if (!outcome.ok) return finish(run, record, `Coding agent did not complete repair task "${repairId}".`, onEvent);
    run = transitionRun(run, RUN_STATUS.VERIFYING);
  }
}

async function runTask(run, task, agent, workspace, prompt, record, onEvent) {
  run = transitionRunTask(transitionRunTask(run, task.id, TASK_STATUS.READY), task.id, TASK_STATUS.IN_PROGRESS);
  onEvent({ type: 'task-started', taskId: task.id });
  const session = await agent.implement({ workspace, prompt });
  record.agentSessions.push({ taskId: task.id, agent: agent.name, ok: session.ok, claim: session.claim, execution: session.execution });
  const status = session.ok ? TASK_STATUS.COMPLETED : TASK_STATUS.FAILED;
  onEvent({ type: 'task-finished', taskId: task.id, status });
  return { run: transitionRunTask(run, task.id, status), ok: session.ok };
}

async function verificationRound(run, suite, workspace, protectedFiles, record, execute, onEvent) {
  // Throws IntegrityError: no check starts against tests that differ from the approved ones.
  const verified = await verifyIntegrity(workspace, protectedFiles);
  const round = record.rounds.length + 1;
  onEvent({ type: 'verifying', round, checks: suite.length });
  const startedAt = new Date().toISOString();
  const completed = [];
  let results;
  try {
    results = await runChecks(suite, {
      workspace,
      execute,
      makeId: (() => {
        let n = 0;
        return () => `round${round}-${suite[n++].id}`;
      })(),
      // Code run by a check can change files while it runs, so the next check only starts if nothing changed.
      afterCheck: async (check, result) => {
        completed.push(result);
        try {
          await verifyIntegrity(workspace, protectedFiles);
        } catch (error) {
          if (!(error instanceof IntegrityError)) throw error;
          throw new IntegrityError(`${error.message} Detected after check "${check.id}" ran; no further checks were run.`, {
            code: error.code,
            details: { ...error.details, round, afterCheck: { checkId: check.id, resultId: result.id } },
          });
        }
      },
    });
  } catch (error) {
    // Keep the results of the checks that did run as evidence; the round is not evaluated.
    if (error instanceof IntegrityError) record.rounds.push({ round, startedAt, results: completed, evaluations: [], aborted: true });
    throw error;
  }
  const applied = applyVerification(run, suite, results);
  record.protectedFiles.push({ round, files: verified });
  record.rounds.push({ round, startedAt, results, evaluations: applied.evaluations });
  onEvent({ type: 'verified', round, verdicts: applied.evaluations.map((e) => [e.requirementId, e.verdict]) });
  return applied.run;
}

async function verifyIntegrity(workspace, protectedFiles) {
  await verifyApprovedSources(protectedFiles);
  return verifyWorkspaceTests(workspace, protectedFiles);
}

/** Ends the run because approved tests failed integrity; anything else is a real error and is re-thrown. */
function integrityFailed(run, record, error, round, onEvent) {
  if (!(error instanceof IntegrityError)) throw error;
  const { afterCheck = null, problems } = error.details;
  round = error.details.round ?? round;
  record.integrityFailure = { round, afterCheck, code: error.code, message: error.message, problems };
  onEvent({ type: 'integrity-failed', round, afterCheck, code: error.code });
  return finish(run, record, `Integrity check failed: ${error.message}`, onEvent);
}

function finish(run, record, reason, onEvent) {
  if (run.status !== RUN_STATUS.COMPLETED && run.status !== RUN_STATUS.FAILED) {
    run = transitionRun(run, RUN_STATUS.FAILED);
  }
  record.outcome = { delivered: run.status === RUN_STATUS.COMPLETED, reason, blockers: completionBlockers(run) };
  onEvent({ type: 'finished', ...record.outcome });
  return { run, ...record };
}

/** Dependency order (the domain model has already rejected cycles). */
export function orderTasks(tasks) {
  const done = new Set();
  const ordered = [];
  while (ordered.length < tasks.length) {
    const next = tasks.find((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d)));
    done.add(next.id);
    ordered.push(next);
  }
  return ordered;
}

function describeRequirements(requirements) {
  return requirements
    .map((r) => {
      const criteria = r.acceptanceCriteria.map((c) => `    - ${c}`).join('\n');
      return `- ${r.id}: ${r.description}${criteria ? `\n  Acceptance criteria:\n${criteria}` : ''}`;
    })
    .join('\n');
}

function describeChecks(suite) {
  return suite.map((c) => `- ${c.id}: \`${[c.command, ...c.args].join(' ')}\` (in ${c.cwd})`).join('\n');
}

function protectedNote(protectedFiles) {
  if (protectedFiles.length === 0) return 'You cannot run commands.';
  const dirs = closedDirectories(protectedFiles);
  const where = dirs.length ? ` Do not add, change or delete any file in ${dirs.map((d) => `${d}/`).join(', ')}.` : '';
  return (
    `The approved acceptance tests (${protectedFiles.map((f) => f.target).join(', ')}) are read-only: read them, ` +
    `but do not modify or delete them.${where} Any such change fails the delivery. You cannot run commands.`
  );
}

function implementationPrompt(run, task, suite, protectedFiles) {
  const related = run.requirements.filter((r) => task.requirementIds.includes(r.id));
  return [
    `You are implementing part of this application request:\n${run.request}`,
    `Your task (${task.id}): ${task.title}\n${task.description}`,
    `Requirements this task contributes to:\n${describeRequirements(related.length ? related : run.requirements)}`,
    `After you finish, these checks will be run independently in this directory:\n${describeChecks(suite)}`,
    `Write the code in the current directory. ${protectedNote(protectedFiles)}`,
  ].join('\n\n');
}

function repairPrompt(run, failing, suite, lastRound, protectedFiles) {
  const failures = lastRound.results
    .filter((r) => r.outcome !== 'passed')
    .map((r) => {
      const e = r.execution;
      const output = `${e.stdout}\n${e.stderr}`.trim().slice(-OUTPUT_TAIL);
      return `### Check ${r.checkId}: ${r.reason}\nCommand: ${[e.command, ...e.args].join(' ')}\nOutput (tail):\n${output || '(none)'}`;
    })
    .join('\n\n');
  return [
    `Independent verification of this application failed. Request:\n${run.request}`,
    `Requirements not yet verified:\n${describeRequirements(failing)}`,
    `Failing checks and their actual output:\n${failures}`,
    `All checks that will be re-run:\n${describeChecks(suite)}`,
    `Fix the application code so these checks pass. ${protectedNote(protectedFiles)}`,
  ].join('\n\n');
}
