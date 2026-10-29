import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceError, leakingConfiguration, prepareWorkspace } from '../../src/controller/workspace.js';
import { deliver } from '../../src/controller/delivery.js';
import { loadSpec, prepareDelivery } from '../../src/controller/spec.js';
import { buildReport } from '../../src/report/report.js';

const ADE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hasCode = (code) => (e) => e instanceof WorkspaceError && e.code === code;
let dir;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ade-workspace-test-')));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('prepareWorkspace', () => {
  it('creates a fresh, empty directory under the temp root by default', async () => {
    const a = await prepareWorkspace(null, { runId: 'abcdef1234', tempRoot: dir });
    const b = await prepareWorkspace(null, { runId: 'abcdef1234', tempRoot: dir });
    assert.notEqual(a, b, 'every run gets its own directory');
    assert.equal(dirname(a), dir);
    assert.match(a, /ade-abcdef12-/);
  });

  it('accepts an empty or missing requested directory', async () => {
    assert.equal(await prepareWorkspace(join(dir, 'new', 'app')), join(dir, 'new', 'app'));
  });

  it('refuses a non-empty directory so earlier files cannot leak into a run', async () => {
    await mkdir(join(dir, 'app'));
    await writeFile(join(dir, 'app', 'todo.js'), 'old');
    await assert.rejects(prepareWorkspace(join(dir, 'app')), hasCode('WORKSPACE_NOT_EMPTY'));
  });

  for (const marker of ['package.json', 'CLAUDE.md', '.git', '.claude/settings.json', '.claude/CLAUDE.md']) {
    it(`refuses a workspace nested under ${marker}`, async () => {
      await mkdir(dirname(join(dir, 'project', marker)), { recursive: true });
      await writeFile(join(dir, 'project', marker), '{}');
      await assert.rejects(
        prepareWorkspace(join(dir, 'project', 'deep', 'app')),
        (e) => hasCode('WORKSPACE_NOT_ISOLATED')(e) && e.details.found.includes(join(dir, 'project', marker)),
      );
    });
  }

  it('refuses a workspace inside the ADE repository', async () => {
    const inside = join(ADE_ROOT, 'examples', 'todo-lib', `isolation-probe-${process.pid}`);
    try {
      await assert.rejects(prepareWorkspace(inside), (e) => {
        assert.ok(hasCode('WORKSPACE_NOT_ISOLATED')(e));
        assert.ok(e.details.found.some((f) => f.endsWith('package.json')));
        return true;
      });
    } finally {
      await rm(inside, { recursive: true, force: true });
    }
  });

  it('leaves no directories behind when it refuses a nested path', async () => {
    await mkdir(join(dir, 'project'));
    await writeFile(join(dir, 'project', 'package.json'), '{}');
    await assert.rejects(prepareWorkspace(join(dir, 'project', 'deep', 'app')), hasCode('WORKSPACE_NOT_ISOLATED'));
    assert.equal(await stat(join(dir, 'project', 'deep')).then(() => true, () => false), false);
  });

  it('resolves symlinks: a link that points into a project is refused without creating anything there', async () => {
    await mkdir(join(dir, 'project'));
    await writeFile(join(dir, 'project', '.git'), '');
    await mkdir(join(dir, 'outside'));
    await symlink(join(dir, 'project'), join(dir, 'outside', 'link'));
    await assert.rejects(
      prepareWorkspace(join(dir, 'outside', 'link', 'app')),
      (e) => hasCode('WORKSPACE_NOT_ISOLATED')(e) && e.details.workspace === join(dir, 'project', 'app'),
    );
    assert.equal(await stat(join(dir, 'project', 'app')).then(() => true, () => false), false);
  });

  it('resolves symlinks: a link to a non-empty directory is refused and returns the real path when empty', async () => {
    await mkdir(join(dir, 'real'));
    await symlink(join(dir, 'real'), join(dir, 'link'));
    assert.equal(await prepareWorkspace(join(dir, 'link')), join(dir, 'real'));
    await writeFile(join(dir, 'real', 'old.js'), 'old');
    await assert.rejects(prepareWorkspace(join(dir, 'link')), hasCode('WORKSPACE_NOT_EMPTY'));
  });

  it('ignores markers inside the workspace itself', async () => {
    const ws = await prepareWorkspace(join(dir, 'app'));
    await writeFile(join(ws, 'package.json'), '{}');
    assert.deepEqual(await leakingConfiguration(ws), []);
  });
});

describe('delivery workspace placement', () => {
  async function exampleSpec() {
    const prepared = await loadSpec(join(ADE_ROOT, 'examples', 'todo-lib', 'spec.json'));
    return prepared;
  }

  it('the example builds outside the ADE repository and the agent works there', async () => {
    const prepared = await exampleSpec();
    assert.equal(prepared.workspace, null, 'the example spec no longer pins a nested workspace');
    let agentWorkspace;
    const agent = {
      name: 'probe',
      async implement({ workspace }) {
        agentWorkspace = workspace;
        await writeFile(join(workspace, 'todo.js'), 'exports.createStore = () => ({});\n');
        return { ok: true, claim: '', execution: {} };
      },
    };
    const result = await deliver({ ...prepared, run: { ...prepared.run, maxRepairAttempts: 0 } }, { agent, tempRoot: dir });
    assert.equal(agentWorkspace, result.workspace);
    assert.equal(dirname(result.workspace), dir);
    assert.ok(relative(ADE_ROOT, result.workspace).startsWith('..'), 'workspace is outside ADE');
    assert.equal(await readFile(join(result.workspace, 'todo.js'), 'utf8'), 'exports.createStore = () => ({});\n');
    assert.equal(buildReport(result).workspace, result.workspace);
  });

  it('runs the app without inheriting ADE\'s "type": "module"', async () => {
    // CommonJS code with require(): this failed in round 1 when the workspace was nested in ADE.
    const prepared = await exampleSpec();
    const sources = { 'todo.js': `
exports.createStore = () => {
  const todos = []; let next = 1;
  return {
    add(title) { if (typeof title !== 'string' || !title.trim()) throw new Error('empty'); const t = { id: next++, title, done: false }; todos.push(t); return { ...t }; },
    list() { return todos.map((t) => ({ ...t })); },
    complete(id) { const t = todos.find((x) => x.id === id); if (!t) throw new Error('unknown'); t.done = true; return { ...t }; },
  };
};` };
    const agent = {
      name: 'cjs',
      async implement({ workspace }) {
        for (const [name, code] of Object.entries(sources)) await writeFile(join(workspace, name), code);
        return { ok: true, claim: '', execution: {} };
      },
    };
    const result = await deliver(prepared, { agent, tempRoot: dir });
    assert.equal(result.outcome.delivered, true, JSON.stringify(result.rounds[0]?.evaluations));
    assert.equal(result.rounds.length, 1, 'no repair was needed');
  });

  it('refuses a non-empty workspace before any agent runs', async () => {
    const spec = {
      request: 'x', workspace: './app',
      requirements: [{ id: 'FR1', description: 'x', checkIds: ['c'] }],
      tasks: [{ id: 'T1', title: 't', description: 't' }],
      checks: [{ id: 'c', command: process.execPath, args: ['-e', '0'], requirementIds: ['FR1'] }],
    };
    await mkdir(join(dir, 'app'));
    await writeFile(join(dir, 'app', 'stale.js'), 'old');
    let called = false;
    const agent = { name: 'x', async implement() { called = true; return { ok: true, claim: '', execution: {} }; } };
    await assert.rejects(deliver(prepareDelivery(spec, dir), { agent }), hasCode('WORKSPACE_NOT_EMPTY'));
    assert.equal(called, false);
  });
});
