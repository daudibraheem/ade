/**
 * Delivery reports and the evidence store.
 *
 * The report is built only from the run state and the check results the
 * verification engine recorded. Agent statements are shown separately and
 * labelled as unverified claims.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ValidationError } from '../domain/errors.js';

const LIMITATIONS = [
  'A passing check proves only what that check tests; untested behaviour is not verified.',
  'Checks run as the current user without a sandbox: no container, network or filesystem isolation.',
  'Approved test files are checked for changes before each round and after each check. This detects changed files; it does not stop application code from manipulating the test process it runs in.',
  'The coding agent had file tools only, but the code it wrote was executed by the checks.',
];

/** Writes run.json, one JSON file per check result, report.json and report.md. Returns the paths. */
export async function writeEvidence(outDir, delivery) {
  const resultsDir = resolve(outDir, 'results');
  // Every path is checked before anything is written.
  const files = delivery.rounds.flatMap((round) => round.results.map((result) => [evidencePath(resultsDir, result.id), result]));
  await mkdir(resultsDir, { recursive: true });
  for (const [path, result] of files) await writeJson(path, result);
  const report = buildReport(delivery);
  const paths = {
    run: join(outDir, 'run.json'),
    reportJson: join(outDir, 'report.json'),
    reportMarkdown: join(outDir, 'report.md'),
  };
  await writeJson(paths.run, delivery.run);
  await writeJson(paths.reportJson, report);
  await writeFile(paths.reportMarkdown, renderMarkdown(report));
  return paths;
}

export function buildReport({ run, workspace, rounds, agentSessions, protectedFiles, integrityFailure = null, outcome }) {
  // A round stopped by an integrity failure was never evaluated; requirement reasons come from the last evaluated one.
  const finalRound = rounds.filter((round) => !round.aborted).at(-1);
  const evaluationFor = (id) => finalRound?.evaluations.find((e) => e.requirementId === id);
  return {
    runId: run.id,
    request: run.request,
    workspace,
    decision: outcome.delivered ? 'DELIVERED' : 'NOT DELIVERED',
    reason: outcome.reason,
    blockers: outcome.blockers,
    integrityFailure,
    status: run.status,
    repairAttempts: run.repairAttempts,
    maxRepairAttempts: run.maxRepairAttempts,
    requirements: run.requirements.map((r) => ({
      id: r.id,
      description: r.description,
      required: r.required,
      acceptanceCriteria: r.acceptanceCriteria,
      status: r.status,
      reasons: evaluationFor(r.id)?.reasons ?? ['Never verified.'],
      evidence: r.evidence.map((e) => ({ checkId: e.checkId, passed: e.passed, resultId: e.resultId })),
    })),
    rounds: rounds.map((round) => ({
      round: round.round,
      startedAt: round.startedAt,
      aborted: Boolean(round.aborted),
      checks: round.results.map((r) => ({
        resultId: r.id,
        checkId: r.checkId,
        requirementIds: r.requirementIds,
        outcome: r.outcome,
        reason: r.reason,
        tests: r.tests,
        command: [r.execution.command, ...r.execution.args],
        cwd: r.execution.cwd,
        executionStatus: r.execution.status,
        exitCode: r.execution.exitCode,
        durationMs: r.execution.durationMs,
        startedAt: r.execution.startedAt,
        finishedAt: r.execution.finishedAt,
      })),
      protectedFiles: protectedFiles.find((p) => p.round === round.round)?.files ?? [],
    })),
    tasks: run.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, requirementIds: t.requirementIds })),
    agentClaims: agentSessions.map((s) => ({
      taskId: s.taskId,
      agent: s.agent,
      sessionSucceeded: s.ok,
      exitCode: s.execution.exitCode,
      durationMs: s.execution.durationMs,
      claim: s.claim,
    })),
    limitations: LIMITATIONS,
  };
}

export function renderMarkdown(report) {
  const lines = [
    `# ADE delivery report: ${report.decision}`,
    '',
    `- Run: \`${report.runId}\``,
    `- Request: ${report.request}`,
    `- Workspace: \`${report.workspace}\``,
    `- Decision: **${report.decision}**: ${report.reason}`,
    `- Repair attempts: ${report.repairAttempts} of ${report.maxRepairAttempts}`,
  ];
  if (report.integrityFailure) {
    const f = report.integrityFailure;
    const when = f.afterCheck
      ? `After check \`${f.afterCheck.checkId}\` in verification round ${f.round} (later checks were not run)`
      : `Before ${f.round === 0 ? 'implementation' : `verification round ${f.round}`}`;
    lines.push('', '## Integrity failure', '', `${when} (\`${f.code}\`):`, '');
    lines.push(...f.problems.map((p) => `- \`${p.path}\`: ${p.problem}${p.expected ? ` (approved sha256 \`${p.expected.slice(0, 16)}…\`${p.actual ? `, found \`${p.actual.slice(0, 16)}…\`` : ''})` : ''}`));
  }
  if (report.blockers.length) {
    lines.push('', '## Blockers', '', ...report.blockers.map((b) => `- ${b}`));
  }

  lines.push('', '## Requirements', '', '| Requirement | Required | Status | Evidence (result ids) |', '|---|---|---|---|');
  for (const r of report.requirements) {
    const evidence = r.evidence.map((e) => `${e.passed ? 'pass' : 'FAIL'} \`${e.resultId ?? e.checkId}\``).join(', ') || 'none';
    lines.push(`| ${r.id}: ${escape(r.description)} | ${r.required ? 'yes' : 'no'} | ${r.status} | ${evidence} |`);
  }
  for (const r of report.requirements.filter((x) => x.status !== 'verified')) {
    lines.push('', `**${r.id} not verified:**`, ...r.reasons.map((reason) => `- ${escape(reason)}`));
  }

  for (const round of report.rounds) {
    lines.push('', `## Verification round ${round.round}${round.aborted ? ' (stopped: integrity failure)' : ''}`, '', '| Check | Outcome | Command | Exit | Duration | Result id |', '|---|---|---|---|---|---|');
    for (const c of round.checks) {
      lines.push(
        `| ${c.checkId} | ${c.outcome} | \`${escape(c.command.join(' '))}\` | ${c.exitCode ?? c.executionStatus} | ${c.durationMs} ms | \`${c.resultId}\` |`,
      );
    }
    if (round.protectedFiles.length) {
      lines.push('', 'Approved acceptance tests verified unchanged before this round and after each completed check (sha256):');
      lines.push(...round.protectedFiles.map((f) => `- \`${f.path}\` sha256 \`${f.sha256.slice(0, 16)}…\``));
    }
  }

  lines.push('', '## Agent claims (not evidence)', '', 'These are what the coding agent reported. They did not influence the decision.', '');
  for (const a of report.agentClaims) {
    lines.push(`- **${a.taskId}** (${a.agent}, session ${a.sessionSucceeded ? 'succeeded' : 'failed'}): ${escape(oneLine(a.claim))}`);
  }

  lines.push('', '## Limitations', '', ...report.limitations.map((l) => `- ${l}`), '');
  return lines.join('\n');
}

// A result file directly inside the results directory, named only with safe characters; anything else is refused.
function evidencePath(resultsDir, id) {
  const path = resolve(resultsDir, `${id}.json`);
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || dirname(path) !== resultsDir) {
    throw new ValidationError(`Refusing to write evidence for result id ${JSON.stringify(id)} outside ${resultsDir}.`, {
      code: 'UNSAFE_PATH',
      details: { id },
    });
  }
  return path;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function oneLine(text, max = 400) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat || '(no message)';
}

function escape(text) {
  return String(text).replace(/\|/g, '\\|');
}
