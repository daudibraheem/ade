#!/usr/bin/env node
/**
 * ADE command line.
 *
 *   ade plan "<request>" [--out <dir>] [--agent-command <path>]   draft a spec for review
 *   ade approve <draft.json> [--allow-open-questions]             turn a reviewed draft into spec.json
 *   ade deliver <spec.json> [--out <dir>] [--agent-command <path>]
 *
 * Exit codes: 0 success / delivered, 1 not delivered, 2 usage, spec or planning error.
 */
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createClaudeCodeAgent } from '../src/agent/claude-code.js';
import { deliver } from '../src/controller/delivery.js';
import { loadSpec } from '../src/controller/spec.js';
import { writeEvidence } from '../src/report/report.js';
import { approveDraft, planApplication } from '../src/planner/plan.js';

const USAGE = `Usage:
  ade plan "<request>" [--out <dir>] [--agent-command <path>]
  ade approve <draft.json> [--allow-open-questions]
  ade deliver <spec.json> [--out <dir>] [--agent-command <path>]`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'agent-command': { type: 'string' },
      'allow-open-questions': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const [command, target] = positionals;
  if (values.help || !target || positionals.length > 2) {
    console.error(USAGE);
    return 2;
  }
  if (command === 'plan') return plan(target, values);
  if (command === 'approve') return approve(target, values);
  if (command === 'deliver') return deliverSpec(target, values);
  console.error(USAGE);
  return 2;
}

async function plan(request, values) {
  const outDir = resolve(values.out ?? join('ade-drafts', draftName(request)));
  const agent = createClaudeCodeAgent({ command: values['agent-command'] });
  console.log(`Planning (model has no tools; nothing is implemented or executed)...`);
  let result;
  try {
    result = await planApplication(request, { agent, outDir });
  } catch (error) {
    console.error(`Planning failed [${error.code}]: ${error.message}`);
    return 2;
  }
  const { draft, draftPath } = result;
  console.log(`\nDraft spec: ${draftPath}`);
  console.log(`Summary: ${draft.summary}`);
  console.log(`${draft.requirements.length} requirement(s), ${draft.tasks.length} task(s), ` +
    `${draft.proposedChecks.length} proposed check(s), ${draft.proposedTestFiles.length} proposed test file(s).`);
  for (const a of draft.assumptions) console.log(`  assumption: ${a}`);
  for (const q of draft.openQuestions) console.log(`  OPEN QUESTION: ${q}`);
  console.log('\nThis draft is NOT approved. Review the requirements, every proposed check command and every file');
  console.log(`under ${join(outDir, 'proposed-tests')}, then run:\n  ade approve ${draftPath}`);
  return 0;
}

async function approve(draftPath, values) {
  try {
    const { specPath, spec } = await approveDraft(draftPath, { allowOpenQuestions: values['allow-open-questions'] });
    console.log(`Approved. These commands will run during delivery:`);
    for (const c of spec.checks) console.log(`  ${c.id}: ${[c.command, ...(c.args ?? [])].join(' ')}`);
    console.log(`Spec: ${specPath}\nNext: ade deliver ${specPath}`);
    return 0;
  } catch (error) {
    console.error(`Not approved [${error.code}]: ${error.message}`);
    return 2;
  }
}

async function deliverSpec(specPath, values) {

  let prepared;
  try {
    prepared = await loadSpec(specPath);
  } catch (error) {
    console.error(`Invalid spec: ${error.message}`);
    return 2;
  }
  const outDir = resolve(values.out ?? join(dirname(resolve(specPath)), '.ade-runs', prepared.run.id));
  const agent = createClaudeCodeAgent({ command: values['agent-command'] });

  console.log(`ADE run ${prepared.run.id}\nWorkspace: ${prepared.workspace}\nEvidence:  ${outDir}`);
  const delivery = await deliver(prepared, { agent, onEvent: log });
  const paths = await writeEvidence(outDir, delivery);
  console.log(`\n${delivery.outcome.delivered ? 'DELIVERED' : 'NOT DELIVERED'}: ${delivery.outcome.reason}`);
  console.log(`Report: ${paths.reportMarkdown}`);
  return delivery.outcome.delivered ? 0 : 1;
}

function draftName(request) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const slug = request.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'app';
  return `${stamp}-${slug}`;
}

function log(event) {
  const at = new Date().toISOString().slice(11, 19);
  switch (event.type) {
    case 'executing': return console.log(`[${at}] executing ${event.tasks} task(s)`);
    case 'task-started': return console.log(`[${at}] agent working on ${event.taskId}...`);
    case 'task-finished': return console.log(`[${at}] ${event.taskId}: agent session ${event.status}`);
    case 'verifying': return console.log(`[${at}] verification round ${event.round}: ${event.checks} check(s)`);
    case 'verified': return console.log(`[${at}] ${event.verdicts.map(([id, v]) => `${id}=${v}`).join(' ')}`);
    default: return undefined;
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => { console.error(`ADE error: ${error.stack ?? error.message}`); process.exitCode = 2; },
);
