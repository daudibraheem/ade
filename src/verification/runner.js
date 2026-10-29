/**
 * Controlled command execution. Runs one program and reports what actually
 * happened: it never decides whether a check passed.
 *
 * Controls applied:
 * - No shell: the program and its arguments are passed directly, so shell
 *   metacharacters in arguments have no effect.
 * - The working directory must resolve (following symlinks) inside the workspace.
 * - A minimal environment: only the variables in ENV_ALLOWLIST plus any
 *   explicitly supplied ones. Secrets in ADE's own environment are not passed on.
 * - A hard timeout that kills the whole process group.
 * - When the program exits, anything it left running in its process group
 *   (e.g. a background child) is killed too.
 * - Captured output is capped per stream.
 *
 * Process-group termination only reaches processes that stay in the group. A
 * process that moves itself into another session or group (setsid, a detached
 * spawn) escapes it and keeps running.
 *
 * This is NOT a sandbox. The program runs as the current user with full
 * filesystem and network access. Isolation needs a container or separate user.
 */
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const EXECUTION_STATUS = Object.freeze({
  COMPLETED: 'completed', // the program ran and exited (with any exit code)
  TIMED_OUT: 'timed_out', // killed after exceeding its time limit
  COULD_NOT_START: 'could_not_start', // never ran: missing program, bad cwd, etc.
});

export const ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']);
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * @param {object} spec
 * @param {string} spec.command program to execute (looked up on PATH if not a path)
 * @param {string[]} [spec.args]
 * @param {string} spec.workspace absolute path of the directory commands are confined to
 * @param {string} [spec.cwd] working directory relative to the workspace
 * @param {number} spec.timeoutMs
 * @param {object} [options]
 * @param {Record<string,string>} [options.env] extra variables, added to the allowlisted ones
 * @param {number} [options.maxOutputBytes] cap per stream
 * @returns {Promise<object>} a frozen execution record
 */
export async function runCommand(spec, { env = {}, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  const { command, args = [], workspace, cwd = '.', timeoutMs } = spec;
  const startedAt = new Date();
  const base = { command, args: [...args], cwd, startedAt: startedAt.toISOString() };

  let resolvedCwd;
  try {
    resolvedCwd = await confinedCwd(workspace, cwd);
  } catch (error) {
    return notStarted(base, startedAt, error.code ?? 'INVALID_CWD', error.message);
  }

  return new Promise((done) => {
    const stdout = capture(maxOutputBytes);
    const stderr = capture(maxOutputBytes);
    let exitCode = null;
    let signal = null;
    let timedOut = false;
    let settled = false;

    let child;
    try {
      child = spawn(command, args, {
        cwd: resolvedCwd,
        env: buildEnv(env),
        shell: false,
        detached: true, // own process group, so a timeout can kill its children too
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      done(notStarted(base, startedAt, error.code ?? 'SPAWN_FAILED', error.message));
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, timeoutMs);

    const finish = (record) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(record);
    };

    child.stdout.on('data', stdout.push);
    child.stderr.on('data', stderr.push);
    child.on('error', (error) => {
      // Emitted when the program cannot be started (e.g. ENOENT, EACCES).
      if (child.pid === undefined) finish(notStarted(base, startedAt, error.code ?? 'SPAWN_FAILED', error.message));
    });
    child.on('exit', (code, sig) => {
      exitCode = code;
      signal = sig;
    });
    child.on('close', () => {
      if (child.pid === undefined) return; // handled by 'error'
      stopRemainingGroup(child.pid);
      const finishedAt = new Date();
      finish(
        Object.freeze({
          ...base,
          status: timedOut ? EXECUTION_STATUS.TIMED_OUT : EXECUTION_STATUS.COMPLETED,
          exitCode,
          signal,
          timedOut,
          error: null,
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt - startedAt,
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated(),
          stderrTruncated: stderr.truncated(),
        }),
      );
    });
  });
}

async function confinedCwd(workspace, cwd) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
    throw Object.assign(new Error('Workspace must be an absolute path.'), { code: 'INVALID_WORKSPACE' });
  }
  const root = await realpath(workspace);
  const target = await realpath(resolve(root, cwd));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw Object.assign(new Error(`Working directory "${cwd}" resolves outside the workspace.`), {
      code: 'UNSAFE_PATH',
    });
  }
  return target;
}

function buildEnv(extra) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL'); // group already gone or not supported; kill the direct child
  }
}

// The direct child has exited; kill whatever it left behind in its process group.
// ESRCH (nothing left) is the normal case and does not affect the recorded result.
function stopRemainingGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Group already gone, or process groups are not supported on this platform.
  }
}

function capture(limit) {
  const chunks = [];
  let kept = 0;
  let total = 0;
  return {
    push: (chunk) => {
      total += chunk.length;
      if (kept < limit) {
        const slice = chunk.subarray(0, limit - kept);
        chunks.push(slice);
        kept += slice.length;
      }
    },
    text: () => Buffer.concat(chunks).toString('utf8'),
    truncated: () => total > kept,
  };
}

function notStarted(base, startedAt, code, message) {
  const finishedAt = new Date();
  return Object.freeze({
    ...base,
    status: EXECUTION_STATUS.COULD_NOT_START,
    exitCode: null,
    signal: null,
    timedOut: false,
    error: Object.freeze({ code, message }),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  });
}
