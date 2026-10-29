/**
 * Coding-agent adapter for Claude Code in headless mode (`claude -p`).
 *
 * The agent runs inside the application workspace with file tools only
 * (no Bash), so it can write code but cannot execute anything. Only the
 * verification engine executes commands, and only approved checks.
 *
 * What the agent says about its work is recorded as a claim, never as evidence.
 */
import { runCommand } from '../verification/runner.js';

export const AGENT_TOOLS = Object.freeze(['Read', 'Write', 'Edit', 'Glob', 'Grep']);
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;
// Authentication and provider settings Claude Code may need; everything else is withheld.
const AGENT_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_'];

/**
 * @param {object} [options]
 * @param {string} [options.command] the Claude Code executable
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.execute] command runner (injectable for tests)
 * @returns {{ name: string, implement: Function, plan: Function }}
 */
export function createClaudeCodeAgent({ command = 'claude', timeoutMs = DEFAULT_AGENT_TIMEOUT_MS, execute = runCommand } = {}) {
  async function invoke(prompt, workspace, toolArgs) {
    const args = ['-p', prompt, '--output-format', 'json', ...toolArgs];
    const execution = await execute(
      { command, args, workspace, cwd: '.', timeoutMs },
      { env: agentEnv(), maxOutputBytes: 256 * 1024 },
    );
    const parsed = parseJson(execution.stdout);
    const ok = execution.status === 'completed' && execution.exitCode === 0 && parsed?.is_error !== true;
    const text = typeof parsed?.result === 'string' ? parsed.result : execution.stdout.slice(-2000);
    // The prompt is long and stored elsewhere; keep the record readable.
    return { ok, text, execution: { ...execution, args: ['-p', '<prompt>', ...args.slice(2)] } };
  }

  return {
    name: 'claude-code',
    /** @returns {Promise<{ ok: boolean, claim: string, execution: object }>} */
    async implement({ workspace, prompt }) {
      const { ok, text, execution } = await invoke(prompt, workspace, ['--permission-mode', 'acceptEdits', '--tools', ...AGENT_TOOLS]);
      return { ok, claim: text, execution };
    },
    /**
     * Text-only session for planning: every tool is disabled, so the model
     * can neither read nor write files nor run commands.
     * @returns {Promise<{ ok: boolean, text: string, execution: object }>}
     */
    async plan({ workspace, prompt }) {
      return invoke(prompt, workspace, ['--tools', '']);
    },
  };
}

function agentEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (AGENT_ENV_PREFIXES.some((p) => key.startsWith(p))) env[key] = value;
  }
  return env;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
