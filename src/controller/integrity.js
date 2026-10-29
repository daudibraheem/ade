/**
 * Approval integrity for acceptance tests.
 *
 * `ade approve` records the SHA-256 of every approved test file in the spec's
 * `protectedFiles`. Delivery checks those bytes at fixed points (before
 * implementation, before every verification round and after every individual
 * check) and fails the run on any difference:
 *
 * 1. Approved sources: each `from` file must still match its approved hash.
 * 2. Workspace copies: ADE places the files once, before implementation. The
 *    directories that hold them are a closed set: every approved file must be
 *    present, unchanged and a regular file, no other file may exist there, and
 *    none of those directories may be a symlink. Changes are reported, never
 *    repaired silently and never accepted.
 *
 * These are detection checks at those points, not prevention: code run by a
 * check executes as the current user and can change files while it runs, and
 * it can manipulate the test process it runs in without changing any file.
 *
 * A test placed directly in the workspace root is hash-checked, but the root
 * itself is not treated as a closed directory.
 */
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { DomainError } from '../domain/errors.js';

export class IntegrityError extends DomainError {
  constructor(message, { code = 'INTEGRITY_FAILED', details } = {}) {
    super(message, { code, details });
  }
}

export async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/** Checks every approved source file against its approved hash. */
export async function verifyApprovedSources(protectedFiles) {
  const problems = [];
  for (const file of protectedFiles) {
    const problem = await fileProblem(file.source, file.sha256);
    if (problem) problems.push({ path: file.source, ...problem });
  }
  if (problems.length) {
    throw new IntegrityError(
      `Approved acceptance test source(s) no longer match their approval: ${summarize(problems)}. ` +
        'Restore the approved files, or review the change and approve again (approval records the hash of each test file).',
      { code: 'APPROVED_SOURCE_CHANGED', details: { problems } },
    );
  }
}

/**
 * Copies the approved files into the workspace (after checking the sources)
 * and confirms each copy has the approved hash.
 */
export async function placeProtectedFiles(workspace, protectedFiles) {
  await verifyApprovedSources(protectedFiles);
  const root = await realpath(workspace);
  for (const file of protectedFiles) {
    const destination = join(root, file.target);
    await mkdir(dirname(destination), { recursive: true });
    assertInside(root, await realpath(dirname(destination)), file.target);
    if (await lstat(destination).catch(() => null)) await unlink(destination);
    await copyFile(file.source, destination);
  }
  await verifyWorkspaceTests(workspace, protectedFiles);
}

/**
 * Confirms the workspace holds exactly the approved test files, unchanged,
 * in the directories that contain them. Returns the verified files.
 */
export async function verifyWorkspaceTests(workspace, protectedFiles) {
  const root = await realpath(workspace);
  const problems = [];
  const expected = new Map(protectedFiles.map((f) => [f.target, f.sha256]));

  for (const dir of await symlinkedDirectories(root, protectedFiles)) {
    problems.push({ path: dir, problem: 'symlinked directory' });
  }
  for (const [target, sha256] of expected) {
    const problem = await fileProblem(join(root, target), sha256);
    if (problem) problems.push({ path: target, ...problem });
  }
  for (const dir of closedDirectories(protectedFiles)) {
    for (const path of await listEntries(root, dir)) {
      if (!expected.has(path)) problems.push({ path, problem: 'unexpected' });
    }
  }

  if (problems.length) {
    throw new IntegrityError(
      `The workspace's approved acceptance tests were altered: ${summarize(problems)}. ` +
        'Approved tests are read-only for the coding agent; ADE will not verify against altered tests. ' +
        'Inspect the workspace, then start a new delivery.',
      { code: 'WORKSPACE_TESTS_ALTERED', details: { problems } },
    );
  }
  return protectedFiles.map((f) => ({ path: f.target, sha256: f.sha256 }));
}

/** Directories (relative to the workspace) that may hold only approved files. */
export function closedDirectories(protectedFiles) {
  const dirs = new Set(protectedFiles.map((f) => dirname(f.target)).filter((d) => d !== '.'));
  return [...dirs].sort();
}

// What is wrong with an approved file: missing, a symlink, not a regular file, or changed. Null if it matches.
async function fileProblem(path, expected) {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return { problem: 'missing', expected };
  if (stat.isSymbolicLink()) return { problem: 'symlink', expected };
  if (!stat.isFile()) return { problem: 'not a regular file', expected };
  const actual = await sha256File(path);
  return actual === expected ? null : { problem: 'changed', expected, actual };
}

// Directories on the way to an approved file that were replaced by symlinks (which could point at other copies).
async function symlinkedDirectories(root, protectedFiles) {
  const found = new Set();
  for (const file of protectedFiles) {
    const parts = dirname(file.target).split(sep).filter((p) => p !== '.');
    for (let i = 1; i <= parts.length; i++) {
      const dir = join(...parts.slice(0, i));
      const stat = await lstat(join(root, dir)).catch(() => null);
      if (stat?.isSymbolicLink()) found.add(dir);
    }
  }
  return [...found].sort();
}

// Every non-directory entry under `dir`, as workspace-relative paths.
async function listEntries(root, dir) {
  const entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(root, join(entry.parentPath ?? entry.path, entry.name)));
}

function assertInside(root, path, target) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new IntegrityError(`Protected file "${target}" resolves outside the workspace.`, {
      code: 'WORKSPACE_TESTS_ALTERED',
      details: { problems: [{ path: target, problem: 'escapes workspace' }] },
    });
  }
}

function summarize(problems) {
  return problems.map((p) => `${p.path} (${p.problem})`).join(', ');
}
