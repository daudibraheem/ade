import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOLS, createClaudeCodeAgent } from '../../src/agent/claude-code.js';

const execution = (overrides) => ({ status: 'completed', exitCode: 0, stdout: '', stderr: '', args: [], ...overrides });

describe('createClaudeCodeAgent', () => {
  it('runs Claude Code headless with file tools only, in the workspace', async () => {
    let call;
    const agent = createClaudeCodeAgent({
      execute: async (spec, options) => {
        call = { spec, options };
        return execution({ stdout: JSON.stringify({ result: 'Implemented.', is_error: false }) });
      },
    });
    const session = await agent.implement({ workspace: '/ws', prompt: 'Build it' });
    assert.equal(call.spec.command, 'claude');
    assert.equal(call.spec.workspace, '/ws');
    assert.deepEqual(call.spec.args.slice(0, 2), ['-p', 'Build it']);
    assert.deepEqual(call.spec.args.slice(call.spec.args.indexOf('--tools') + 1), [...AGENT_TOOLS]);
    assert.ok(!call.spec.args.includes('Bash'));
    assert.equal(call.spec.args[call.spec.args.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.equal(session.ok, true);
    assert.equal(session.claim, 'Implemented.');
    assert.equal(session.execution.args[1], '<prompt>');
  });

  it('passes only Claude/Anthropic variables from the environment', async () => {
    process.env.ADE_TEST_SECRET = 'x';
    process.env.ANTHROPIC_TEST_VAR = 'y';
    try {
      let env;
      const agent = createClaudeCodeAgent({ execute: async (_s, o) => ((env = o.env), execution({})) });
      await agent.implement({ workspace: '/ws', prompt: 'p' });
      assert.equal(env.ANTHROPIC_TEST_VAR, 'y');
      assert.equal(env.ADE_TEST_SECRET, undefined);
    } finally {
      delete process.env.ADE_TEST_SECRET;
      delete process.env.ANTHROPIC_TEST_VAR;
    }
  });

  for (const [label, result] of [
    ['a non-zero exit', execution({ exitCode: 1 })],
    ['a reported error', execution({ stdout: JSON.stringify({ is_error: true, result: 'Failed' }) })],
    ['a timeout', execution({ status: 'timed_out', exitCode: null })],
    ['a missing executable', execution({ status: 'could_not_start', exitCode: null })],
  ]) {
    it(`treats ${label} as a failed session`, async () => {
      const agent = createClaudeCodeAgent({ execute: async () => result });
      assert.equal((await agent.implement({ workspace: '/ws', prompt: 'p' })).ok, false);
    });
  }
});

describe('createClaudeCodeAgent plan', () => {
  it('plans with every tool disabled and no edit permission', async () => {
    let call;
    const agent = createClaudeCodeAgent({
      execute: async (spec) => ((call = spec), execution({ stdout: JSON.stringify({ result: '{"summary":"x"}' }) })),
    });
    const session = await agent.plan({ workspace: '/scratch', prompt: 'Plan it' });
    assert.deepEqual(call.args.slice(call.args.indexOf('--tools')), ['--tools', '']);
    assert.ok(!call.args.includes('--permission-mode'));
    assert.equal(session.ok, true);
    assert.equal(session.text, '{"summary":"x"}');
  });
});

describe('createClaudeCodeAgent settings', () => {
  it('loads only user settings, so project settings written into the workspace are ignored', async () => {
    const calls = [];
    const agent = createClaudeCodeAgent({ execute: async (spec) => (calls.push(spec.args), execution({})) });
    await agent.implement({ workspace: '/ws', prompt: 'p' });
    await agent.plan({ workspace: '/ws', prompt: 'p' });
    for (const args of calls) assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
  });
});
