import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IntegrityError,
  closedDirectories,
  placeProtectedFiles,
  verifyApprovedSources,
  verifyWorkspaceTests,
} from '../../src/controller/integrity.js';

const sha = (text) => createHash('sha256').update(text).digest('hex');
let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ade-integrity-'));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, 'ws'));
  await writeFile(join(dir, 'src', 'a.test.js'), 'A');
  await writeFile(join(dir, 'src', 'b.test.js'), 'B');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const files = () => [
  { source: join(dir, 'src', 'a.test.js'), target: 'acceptance/unit/a.test.js', sha256: sha('A') },
  { source: join(dir, 'src', 'b.test.js'), target: 'root.test.js', sha256: sha('B') },
];

describe('closedDirectories', () => {
  it('closes the directories holding approved tests, but never the workspace root', () => {
    assert.deepEqual(closedDirectories(files()), ['acceptance/unit']);
  });
});

describe('integrity checks', () => {
  it('places and verifies approved files, including one at the workspace root', async () => {
    await placeProtectedFiles(join(dir, 'ws'), files());
    const verified = await verifyWorkspaceTests(join(dir, 'ws'), files());
    assert.deepEqual(verified.map((f) => f.path), ['acceptance/unit/a.test.js', 'root.test.js']);
  });

  it('does not treat other root files as unexpected', async () => {
    await placeProtectedFiles(join(dir, 'ws'), files());
    await writeFile(join(dir, 'ws', 'app.js'), 'x');
    await mkdir(join(dir, 'ws', 'acceptance', 'other'), { recursive: true });
    await writeFile(join(dir, 'ws', 'acceptance', 'other', 'c.js'), 'x');
    await verifyWorkspaceTests(join(dir, 'ws'), files());
  });

  it('refuses to place files whose source changed, leaving the workspace untouched', async () => {
    await writeFile(join(dir, 'src', 'b.test.js'), 'B2');
    await assert.rejects(
      placeProtectedFiles(join(dir, 'ws'), files()),
      (e) => e instanceof IntegrityError && e.code === 'APPROVED_SOURCE_CHANGED' && e.details.problems[0].actual === sha('B2'),
    );
    await assert.rejects(verifyWorkspaceTests(join(dir, 'ws'), files()), IntegrityError);
  });

  it('reports every problem at once', async () => {
    await placeProtectedFiles(join(dir, 'ws'), files());
    await writeFile(join(dir, 'ws', 'root.test.js'), 'changed');
    await writeFile(join(dir, 'ws', 'acceptance', 'unit', 'z.test.js'), 'new');
    await rm(join(dir, 'ws', 'acceptance', 'unit', 'a.test.js'));
    await assert.rejects(verifyWorkspaceTests(join(dir, 'ws'), files()), (e) => {
      assert.deepEqual(e.details.problems.map((p) => `${p.path}:${p.problem}`).sort(), [
        'acceptance/unit/a.test.js:missing',
        'acceptance/unit/z.test.js:unexpected',
        'root.test.js:changed',
      ]);
      return true;
    });
  });

  it('accepts sources that still match', async () => {
    await verifyApprovedSources(files());
  });
});
