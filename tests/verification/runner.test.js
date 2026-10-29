import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../src/verification/runner.js';

const NODE = process.execPath;
let workspace;
let outside;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'ade-runner-'));
  outside = await mkdtemp(join(tmpdir(), 'ade-outside-'));
  await mkdir(join(workspace, 'sub'));
  await writeFile(join(workspace, 'sub', 'marker.txt'), 'here');
  await symlink(outside, join(workspace, 'escape'));
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const run = (args, overrides = {}, options) =>
  runCommand({ command: NODE, args, workspace, timeoutMs: 5_000, ...overrides }, options);

describe('runCommand', () => {
  it('records a successful execution with output and timestamps', async () => {
    const rec = await run(['-e', 'console.log("hello"); console.error("warn")']);
    assert.equal(rec.status, 'completed');
    assert.equal(rec.exitCode, 0);
    assert.equal(rec.stdout, 'hello\n');
    assert.equal(rec.stderr, 'warn\n');
    assert.equal(rec.timedOut, false);
    assert.equal(rec.error, null);
    assert.ok(Date.parse(rec.finishedAt) >= Date.parse(rec.startedAt));
    assert.ok(Object.isFrozen(rec));
  });

  it('records a non-zero exit code as a completed execution', async () => {
    const rec = await run(['-e', 'process.exit(3)']);
    assert.equal(rec.status, 'completed');
    assert.equal(rec.exitCode, 3);
  });

  it('kills a command that exceeds its timeout', async () => {
    const rec = await run(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 200 });
    assert.equal(rec.status, 'timed_out');
    assert.equal(rec.timedOut, true);
    assert.equal(rec.signal, 'SIGKILL');
    assert.ok(rec.durationMs < 4_000);
  });

  it('kills child processes of a timed-out command', async () => {
    const script = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)`;
    const rec = await run(['-e', script], { timeoutMs: 300 });
    assert.equal(rec.status, 'timed_out'); // returning at all proves the grandchild released the pipes
  });

  it('reports a missing program as could_not_start', async () => {
    const rec = await runCommand({ command: 'ade-no-such-program', workspace, timeoutMs: 1_000 });
    assert.equal(rec.status, 'could_not_start');
    assert.equal(rec.error.code, 'ENOENT');
    assert.equal(rec.exitCode, null);
  });

  it('does not interpret shell syntax in arguments', async () => {
    const rec = await run(['-e', 'console.log(process.argv[1])', '$(echo hacked); rm -rf /']);
    assert.equal(rec.stdout, '$(echo hacked); rm -rf /\n');
  });

  it('runs in the requested sub-directory', async () => {
    const rec = await run(['-e', 'console.log(require("fs").readFileSync("marker.txt","utf8"))'], { cwd: 'sub' });
    assert.equal(rec.stdout, 'here\n');
  });

  it('refuses a cwd that escapes the workspace through a symlink', async () => {
    const rec = await run(['-e', '0'], { cwd: 'escape' });
    assert.equal(rec.status, 'could_not_start');
    assert.equal(rec.error.code, 'UNSAFE_PATH');
  });

  it('refuses a cwd that does not exist', async () => {
    const rec = await run(['-e', '0'], { cwd: 'missing' });
    assert.equal(rec.status, 'could_not_start');
  });

  it('passes only allowlisted and explicit environment variables', async () => {
    process.env.ADE_TEST_SECRET = 'secret';
    try {
      const rec = await run(['-e', 'console.log(JSON.stringify([process.env.ADE_TEST_SECRET, process.env.EXTRA]))'], {}, {
        env: { EXTRA: 'yes' },
      });
      assert.equal(rec.stdout, '[null,"yes"]\n');
    } finally {
      delete process.env.ADE_TEST_SECRET;
    }
  });

  it('caps captured output and marks it truncated', async () => {
    const rec = await run(['-e', 'process.stdout.write("x".repeat(5000))'], {}, { maxOutputBytes: 100 });
    assert.equal(rec.stdout.length, 100);
    assert.equal(rec.stdoutTruncated, true);
    assert.equal(rec.stderrTruncated, false);
  });
});
