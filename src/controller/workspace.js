/**
 * Application workspace placement.
 *
 * Every delivery builds the application in a fresh, empty directory that is
 * not nested under configuration that would silently change how the app runs
 * or how the coding agent behaves:
 *
 * - `package.json` in a parent directory: Node.js applies its settings (for
 *   example `"type": "module"`) to the generated app.
 * - `.git`: the workspace would be part of another repository.
 * - `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json`: Claude Code may
 *   load instructions or project settings from parent directories.
 *
 * By default the workspace is a new directory under the OS temp directory.
 * This is placement, not isolation: the app and its checks still run as the
 * current user with full filesystem and network access.
 */
import { lstat, mkdir, mkdtemp, readdir, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { DomainError } from '../domain/errors.js';

const ANCESTOR_MARKERS = ['package.json', '.git', 'CLAUDE.md', '.claude/CLAUDE.md', '.claude/settings.json'];
// The user's own Claude Code configuration applies wherever the agent runs, so it is not a placement problem.
const HOME_EXEMPT = ['CLAUDE.md', '.claude/CLAUDE.md', '.claude/settings.json'];

export class WorkspaceError extends DomainError {
  constructor(message, { code = 'WORKSPACE_ERROR', details } = {}) {
    super(message, { code, details });
  }
}

/**
 * Returns the absolute workspace for a run, creating it. With no `requested`
 * path, a fresh directory is created under the OS temp directory. A requested
 * path must be empty (or not exist) and must not sit under leaking configuration.
 *
 * @param {string|null} requested absolute path, or null for a fresh temp directory
 * @param {object} [options]
 * @param {string} [options.runId] used in the temp directory name
 * @param {string} [options.tempRoot] defaults to os.tmpdir() (injectable for tests)
 */
export async function prepareWorkspace(requested, { runId = 'run', tempRoot = tmpdir() } = {}) {
  let workspace;
  if (requested) {
    // Check placement before creating anything, so a rejected path leaves no directories behind.
    await rejectLeakingConfiguration(await resolveThroughExisting(requested));
    await mkdir(requested, { recursive: true });
    workspace = await realpath(requested);
    const entries = await readdir(workspace);
    if (entries.length) {
      throw new WorkspaceError(
        `Workspace ${workspace} is not empty. Each delivery starts from an empty directory so earlier ` +
          'files cannot affect implementation or verification. Remove it, choose another --workspace, or omit it to use a fresh temporary directory.',
        { code: 'WORKSPACE_NOT_EMPTY', details: { workspace, entries: entries.slice(0, 10) } },
      );
    }
  } else {
    workspace = await realpath(await mkdtemp(join(tempRoot, `ade-${runId.slice(0, 8)}-`)));
  }

  // Checked again on the created directory: a symlink may have appeared since the first check.
  await rejectLeakingConfiguration(workspace);
  return workspace;
}

async function rejectLeakingConfiguration(workspace) {
  const found = await leakingConfiguration(workspace);
  if (found.length) {
    throw new WorkspaceError(
      `Workspace ${workspace} is nested under configuration that would leak into the application or the coding agent: ` +
        `${found.join(', ')}. Use a directory outside any project or repository, or omit --workspace to use a fresh temporary directory.`,
      { code: 'WORKSPACE_NOT_ISOLATED', details: { workspace, found } },
    );
  }
}

/** The real path of `path`, resolving symlinks in the part that already exists. */
async function resolveThroughExisting(path) {
  const missing = [];
  let existing = resolve(path);
  for (;;) {
    try {
      return join(await realpath(existing), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT' || existing === parse(existing).root) throw error;
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
}

/** Configuration files in the workspace's parent directories (not the workspace itself). */
export async function leakingConfiguration(workspace) {
  const home = await realpath(homedir()).catch(() => homedir());
  const found = [];
  let dir = dirname(workspace);
  for (;;) {
    for (const marker of ANCESTOR_MARKERS) {
      if (dir === home && HOME_EXEMPT.includes(marker)) continue;
      const path = join(dir, marker);
      if (await lstat(path).then(() => true, () => false)) found.push(path);
    }
    if (dir === parse(dir).root) break;
    dir = dirname(dir);
  }
  return found;
}
