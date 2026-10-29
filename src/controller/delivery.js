/**
 * The delivery controller: drives one delivery run end to end.
 *
 *   plan -> execute tasks with the agent -> verify -> (repair -> verify)* -> decide
 *
 * The agent's success only moves a task to `completed`. Requirements are
 * decided solely by the verification engine's results, and the run can only
 * be completed when the domain model's delivery rules are satisfied.
 */
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import {
  addTask,
  completionBlockers,
  transitionRun,
  transitionRunTask,
} from '../domain/delivery-run.js';
import { REQUIREMENT_STATUS, RUN_STATUS, TASK_STATUS } from '../domain/state-transitions.js';
import { applyVerification, runChecks } from '../verification/verify.js';

const OUTPUT_TAIL = 3000;

/**
 * @param {object} prepared output of prepareDelivery / loadSpec
 * @param {object} deps
 * @param {{ implement: Function, name: string }} deps.agent
 * @param {Function} [deps.execute] command runner for checks (injectable for tests)
 * @param {Function} [deps.onEvent] progress callback: ({ type, ... }) => void
 */
export async function deliver({ run, suite, workspace, protectedFiles = [] }, { agent, execute, onEvent = () => {} }) {
  const record = { rounds: [], agentSessions: [], protectedFiles: [], outcome: null };
  await mkdir(workspace, { recursive: true });
  // Let the agent read the acceptance tests it will be judged by; they are restored again before each round.
  await restoreProtectedFiles(workspace, protectedFiles);

  run = transitionRun(transitionRun(run, RUN_STATUS.PLANNING), RUN_STATUS.EXECUTING);
  onEvent({ type: 'executing', tasks: run.tasks.length });

  for (const task of orderTasks(run.tasks)) {
    const outcome = await runTask(run, task, agent, workspace, implementationPrompt(run, task, suite), record, onEvent);
    run = outcome.run;
    if (!outcome.ok) return finish(run, record, `Coding agent did not complete task "${task.id}".`, onEvent);
  }

  run = transitionRun(run, RUN_STATUS.VERIFYING);
  for (;;) {
    run = await verificationRound(run, suite, workspace, protectedFiles, record, execute, onEvent);
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
    const prompt = repairPrompt(run, failing, suite, record.rounds.at(-1));
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
  const restored = await restoreProtectedFiles(workspace, protectedFiles);
  const round = record.rounds.length + 1;
  onEvent({ type: 'verifying', round, checks: suite.length });
  const startedAt = new Date().toISOString();
  const results = await runChecks(suite, {
    workspace,
    execute,
    makeId: (() => {
      let n = 0;
      return () => `round${round}-${suite[n++].id}`;
    })(),
  });
  const applied = applyVerification(run, suite, results);
  record.protectedFiles.push({ round, files: restored });
  record.rounds.push({ round, startedAt, results, evaluations: applied.evaluations });
  onEvent({ type: 'verified', round, verdicts: applied.evaluations.map((e) => [e.requirementId, e.verdict]) });
  return applied.run;
}

/**
 * Copies approved acceptance files into the workspace before each round, so
 * an agent cannot weaken the tests it is judged by. A symlink placed at or
 * above the target is not followed out of the workspace.
 */
async function restoreProtectedFiles(workspace, files) {
  const restored = [];
  const root = await realpath(workspace);
  for (const { source, target } of files) {
    const destination = join(root, target);
    await mkdir(dirname(destination), { recursive: true });
    const parent = await realpath(dirname(destination));
    const rel = relative(root, parent);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Protected file "${target}" resolves outside the workspace.`);
    }
    const existing = await lstat(destination).catch(() => null);
    if (existing) await unlink(destination); // replaces a modified file or a planted symlink
    await copyFile(source, destination);
    const sha256 = createHash('sha256').update(await readFile(destination)).digest('hex');
    restored.push({ path: target, sha256 });
  }
  return restored;
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

function implementationPrompt(run, task, suite) {
  const related = run.requirements.filter((r) => task.requirementIds.includes(r.id));
  return [
    `You are implementing part of this application request:\n${run.request}`,
    `Your task (${task.id}): ${task.title}\n${task.description}`,
    `Requirements this task contributes to:\n${describeRequirements(related.length ? related : run.requirements)}`,
    `After you finish, these checks will be run independently in this directory:\n${describeChecks(suite)}`,
    'Write the code in the current directory. You may read the acceptance tests but do not modify them; they are restored before verification. You cannot run commands.',
  ].join('\n\n');
}

function repairPrompt(run, failing, suite, lastRound) {
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
    'Fix the application code so these checks pass. Do not modify the acceptance tests; they are restored before verification. You cannot run commands.',
  ].join('\n\n');
}
