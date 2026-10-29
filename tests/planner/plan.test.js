import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_REQUEST_LENGTH,
  PlanningError,
  approveDraft,
  createDraft,
  parseModelOutput,
  planApplication,
  validateRequest,
} from '../../src/planner/plan.js';
import { loadSpec, prepareDelivery } from '../../src/controller/spec.js';
import { deliver } from '../../src/controller/delivery.js';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const hasCode = (code) => (err) => err instanceof PlanningError && err.code === code;
const exists = (path) => access(path).then(() => true, () => false);

const TEST_FILE = `import test from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../greet.mjs';
test('greets by name', () => assert.equal(greet('Ada'), 'Hello, Ada!'));
`;

/** A valid model plan; `overrides` replace top-level fields. */
function modelPlan(overrides = {}) {
  return {
    summary: 'A greeting module.',
    assumptions: ['Greeting text is English.'],
    openQuestions: [],
    requirements: [{ id: 'FR1', description: 'Greets a user by name', acceptanceCriteria: ['greet("Ada") returns "Hello, Ada!"'], checkIds: ['acceptance-fr1'] }],
    tasks: [{ id: 'T1', title: 'Implement greet', description: 'Create greet.mjs exporting greet(name).', dependsOn: [], requirementIds: ['FR1'] }],
    checks: [{ id: 'acceptance-fr1', description: 'Runs the greeting test', command: 'node', args: ['--test', 'acceptance/fr1.test.mjs'], timeoutMs: 30000, requirementIds: ['FR1'] }],
    testFiles: [{ path: 'acceptance/fr1.test.mjs', content: TEST_FILE }],
    ...overrides,
  };
}

/** A mocked planning agent. It has no `implement`, so any attempt to build would throw. */
function planner(reply, { ok = true } = {}) {
  const calls = [];
  return {
    name: 'mock-planner',
    calls,
    async plan(input) {
      calls.push(input);
      return { ok, text: typeof reply === 'string' ? reply : JSON.stringify(reply), execution: {} };
    },
  };
}

let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ade-plan-test-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('validateRequest', () => {
  for (const [label, value] of [['empty', ''], ['whitespace', '   \n'], ['non-string', 42], ['missing', undefined]]) {
    it(`rejects a ${label} request`, () => {
      assert.throws(() => validateRequest(value), hasCode('INVALID_REQUEST'));
    });
  }

  it('rejects an oversized request', () => {
    assert.throws(() => validateRequest('x'.repeat(MAX_REQUEST_LENGTH + 1)), hasCode('INVALID_REQUEST'));
  });

  it('trims a valid request', () => {
    assert.equal(validateRequest('  Build a greeter  '), 'Build a greeter');
  });
});

describe('parseModelOutput', () => {
  it('parses a bare JSON object and a fenced one', () => {
    assert.equal(parseModelOutput('{"summary":"x"}').summary, 'x');
    assert.equal(parseModelOutput('```json\n{"summary":"y"}\n```').summary, 'y');
  });

  for (const [label, text] of [
    ['prose', 'Sure! Here is your plan: ...'],
    ['truncated JSON', '{"summary": "x", "requirements": ['],
    ['a JSON array', '[1, 2]'],
    ['empty output', ''],
    ['JSON wrapped in prose', 'Here you go: {"summary":"x"}'],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() => parseModelOutput(text), hasCode('MALFORMED_OUTPUT'));
    });
  }
});

describe('createDraft', () => {
  const draftOf = (plan) => createDraft(plan, { request: 'Build a greeter', generator: 'mock', now: '2026-10-29T00:00:00Z' });

  it('builds an unapproved draft with proposed (not approved) checks', () => {
    const { draft, testFiles } = draftOf(modelPlan());
    assert.equal(draft.kind, 'ade-draft-spec');
    assert.equal(draft.approval.status, 'draft');
    assert.match(draft.approval.note, /NOT approved/);
    assert.equal(draft.checks, undefined, 'checks are only ever "proposedChecks" in a draft');
    assert.equal(draft.proposedChecks[0].id, 'acceptance-fr1');
    assert.deepEqual(draft.assumptions, ['Greeting text is English.']);
    assert.equal(draft.proposedTestFiles[0].file, 'proposed-tests/acceptance/fr1.test.mjs');
    assert.equal(draft.proposedTestFiles[0].sha256.length, 64);
    assert.equal(testFiles[0].content, TEST_FILE);
  });

  it('a draft cannot be delivered directly', () => {
    const { draft } = draftOf(modelPlan());
    assert.throws(() => prepareDelivery(draft, dir), (e) => e.code === 'DRAFT_NOT_APPROVED');
  });

  for (const [label, overrides, code] of [
    ['an unknown field', { deliverNow: true }, 'INVALID_PLAN'],
    ['a missing summary', { summary: '' }, 'INVALID_PLAN'],
    ['no requirements', { requirements: [] }, 'INVALID_PLAN'],
    ['a requirement without acceptance criteria', { requirements: [{ id: 'FR1', description: 'x', checkIds: ['acceptance-fr1'] }] }, 'INVALID_PLAN'],
    ['a requirement without checks', { requirements: [{ id: 'FR1', description: 'x', acceptanceCriteria: ['y'] }] }, 'INVALID_PLAN'],
    ['a check for an unknown requirement', { checks: [{ ...modelPlan().checks[0], requirementIds: ['FR9'] }] }, 'INVALID_PLAN'],
    ['a check with a shell field', { checks: [{ ...modelPlan().checks[0], shell: true }] }, 'INVALID_PLAN'],
    ['a dependency cycle', { tasks: [
      { id: 'T1', title: 'a', description: 'a', dependsOn: ['T2'], requirementIds: ['FR1'] },
      { id: 'T2', title: 'b', description: 'b', dependsOn: ['T1'] },
    ] }, 'INVALID_PLAN'],
    ['a test file outside the application', { testFiles: [{ path: '../../evil.mjs', content: 'x' }] }, 'UNSAFE_PATH'],
    ['an absolute test file path', { testFiles: [{ path: '/etc/evil.mjs', content: 'x' }] }, 'UNSAFE_PATH'],
    ['an empty test file', { testFiles: [{ path: 'acceptance/a.test.mjs', content: ' ' }] }, 'INVALID_PLAN'],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() => draftOf(modelPlan(overrides)), hasCode(code));
    });
  }
});

describe('planApplication', () => {
  it('writes a draft and proposed tests, and sends the request to the planner', async () => {
    const agent = planner(modelPlan());
    const outDir = join(dir, 'draft');
    const { draftPath, draft } = await planApplication('Build a greeter', { agent, outDir });
    assert.match(agent.calls[0].prompt, /Build a greeter/);
    const saved = JSON.parse(await readFile(draftPath, 'utf8'));
    assert.deepEqual(saved, JSON.parse(JSON.stringify(draft)));
    assert.equal(await readFile(join(outDir, 'proposed-tests', 'acceptance', 'fr1.test.mjs'), 'utf8'), TEST_FILE);
    assert.equal(await exists(agent.calls[0].workspace), false, 'the scratch directory is removed');
  });

  it('does not implement, verify or deliver anything', async () => {
    const marker = join(dir, 'CHECK-RAN');
    const check = { ...modelPlan().checks[0], command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] };
    const outDir = join(dir, 'draft');
    await planApplication('Build a greeter', { agent: planner(modelPlan({ checks: [check] })), outDir });
    assert.equal(await exists(marker), false, 'the proposed check was not executed');
    assert.deepEqual((await readdir(outDir)).sort(), ['draft.json', 'proposed-tests']);
  });

  it('writes nothing when the model output is malformed', async () => {
    const outDir = join(dir, 'draft');
    await assert.rejects(planApplication('Build a greeter', { agent: planner('not json'), outDir }), hasCode('MALFORMED_OUTPUT'));
    assert.equal(await exists(outDir), false);
  });

  it('writes nothing when the planning session fails', async () => {
    const outDir = join(dir, 'draft');
    await assert.rejects(
      planApplication('Build a greeter', { agent: planner('boom', { ok: false }), outDir }),
      hasCode('AGENT_FAILED'),
    );
    assert.equal(await exists(outDir), false);
  });

  it('rejects an empty request without calling the planner', async () => {
    const agent = planner(modelPlan());
    await assert.rejects(planApplication(' ', { agent, outDir: join(dir, 'd') }), hasCode('INVALID_REQUEST'));
    assert.equal(agent.calls.length, 0);
  });

  it('refuses to overwrite an existing draft', async () => {
    const outDir = join(dir, 'draft');
    const { draftPath } = await planApplication('Build a greeter', { agent: planner(modelPlan()), outDir });
    const before = await readFile(draftPath, 'utf8');
    await assert.rejects(
      planApplication('Something else', { agent: planner(modelPlan({ summary: 'Other' })), outDir }),
      hasCode('FILE_EXISTS'),
    );
    assert.equal(await readFile(draftPath, 'utf8'), before);
  });
});

describe('approveDraft', () => {
  const plan = (overrides) => planApplication('Build a greeter', { agent: planner(modelPlan(overrides)), outDir: join(dir, 'draft') });

  it('turns a reviewed draft into a deliverable spec with the tests protected', async () => {
    const { draftPath } = await plan();
    const { specPath, spec, editedTests } = await approveDraft(draftPath);
    assert.deepEqual(spec.protectedFiles, [
      { from: 'proposed-tests/acceptance/fr1.test.mjs', to: 'acceptance/fr1.test.mjs', sha256: sha256(TEST_FILE) },
    ]);
    assert.deepEqual(editedTests, []);
    const prepared = await loadSpec(specPath);
    assert.equal(prepared.suite[0].id, 'acceptance-fr1');
  });

  it('approves the exact bytes on disk, including edits made during review', async () => {
    const { draftPath } = await plan();
    const reviewed = `${TEST_FILE}test('reviewer addition', () => assert.equal(greet('Bo'), 'Hello, Bo!'));\n`;
    await writeFile(join(dir, 'draft', 'proposed-tests', 'acceptance', 'fr1.test.mjs'), reviewed);
    const { spec, editedTests } = await approveDraft(draftPath);
    assert.equal(spec.protectedFiles[0].sha256, sha256(reviewed));
    assert.deepEqual(editedTests, ['acceptance/fr1.test.mjs']);
  });

  it('refuses while open questions remain, unless explicitly allowed', async () => {
    const { draftPath } = await plan({ openQuestions: ['Which languages?'] });
    await assert.rejects(approveDraft(draftPath), hasCode('OPEN_QUESTIONS'));
    assert.equal(await exists(join(dir, 'draft', 'spec.json')), false);
    await approveDraft(draftPath, { allowOpenQuestions: true });
    assert.equal(await exists(join(dir, 'draft', 'spec.json')), true);
  });

  it('refuses to overwrite an existing spec', async () => {
    const { draftPath } = await plan();
    await approveDraft(draftPath);
    await assert.rejects(approveDraft(draftPath), hasCode('FILE_EXISTS'));
  });

  it('refuses when a proposed test file has been removed', async () => {
    const { draftPath } = await plan();
    await rm(join(dir, 'draft', 'proposed-tests'), { recursive: true });
    await assert.rejects(approveDraft(draftPath), hasCode('INVALID_DRAFT'));
  });

  it('re-validates a hand-edited draft', async () => {
    const { draftPath } = await plan();
    const draft = JSON.parse(await readFile(draftPath, 'utf8'));
    draft.proposedChecks[0].requirementIds = ['FR404'];
    await writeFile(draftPath, JSON.stringify(draft));
    await assert.rejects(approveDraft(draftPath), hasCode('INVALID_DRAFT'));
  });

  it('refuses files that are not drafts', async () => {
    const path = join(dir, 'other.json');
    await writeFile(path, '{"request":"x"}');
    await assert.rejects(approveDraft(path), hasCode('INVALID_DRAFT'));
  });

  it('deliver refuses the draft file itself', async () => {
    const { draftPath } = await plan();
    await assert.rejects(loadSpec(draftPath), (e) => e.code === 'DRAFT_NOT_APPROVED');
  });
});

describe('plan -> approve -> deliver', () => {
  it('refuses to verify when an approved test is edited after approval', async () => {
    const outDir = join(dir, 'draft');
    const { draftPath } = await planApplication('Build a greeter', { agent: planner(modelPlan()), outDir });
    const { specPath } = await approveDraft(draftPath);
    await writeFile(join(outDir, 'proposed-tests', 'acceptance', 'fr1.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
    let built = false;
    const builder = { name: 'mock-builder', async implement() { built = true; return { ok: true, claim: '', execution: {} }; } };
    const result = await deliver(await loadSpec(specPath), { agent: builder });
    assert.equal(result.outcome.delivered, false);
    assert.equal(built, false);
    assert.equal(result.integrityFailure.code, 'APPROVED_SOURCE_CHANGED');
  });

  it('delivers an approved plan when the implementation passes the approved tests', async () => {
    const outDir = join(dir, 'draft');
    const { draftPath } = await planApplication('Build a greeter', { agent: planner(modelPlan()), outDir });
    const { specPath } = await approveDraft(draftPath);
    const builder = {
      name: 'mock-builder',
      async implement({ workspace }) {
        await writeFile(join(workspace, 'greet.mjs'), 'export const greet = (name) => `Hello, ${name}!`;\n');
        return { ok: true, claim: 'Done.', execution: { status: 'completed', exitCode: 0 } };
      },
    };
    const result = await deliver(await loadSpec(specPath), { agent: builder });
    assert.equal(result.outcome.delivered, true);
    assert.equal(result.rounds[0].results[0].execution.exitCode, 0);
  });
});
