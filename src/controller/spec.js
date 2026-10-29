/**
 * A delivery spec is the human-approved input to a delivery: the request,
 * requirements with acceptance criteria, the task plan, the verification
 * checks, and any protected acceptance-test files.
 *
 * Example (paths are relative to the spec file):
 * {
 *   "request": "A todo library",
 *   "workspace": "./app",            (optional; default: a fresh temporary directory per run)
 *   "maxRepairAttempts": 2,
 *   "requirements": [{ "id": "FR1", "description": "...", "acceptanceCriteria": ["..."], "checkIds": ["acceptance"] }],
 *   "tasks": [{ "id": "T1", "title": "...", "description": "...", "requirementIds": ["FR1"] }],
 *   "checks": [{ "id": "acceptance", "command": "node", "args": ["--test", "acceptance/*.test.js"], "requirementIds": ["FR1"] }],
 *   "protectedFiles": [{ "from": "approved/todo.test.js", "to": "acceptance/todo.test.js", "sha256": "<64 hex chars>" }]
 * }
 *
 * `sha256` is the approved hash of the `from` file; `ade approve` writes it.
 * Delivery refuses to verify against a file that no longer matches it.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { ValidationError } from '../domain/errors.js';
import { createDeliveryRun } from '../domain/delivery-run.js';
import { rejectUnknownKeys, requireNonEmptyString, requireObject } from '../domain/validation.js';
import { createCheckSuite } from '../verification/check.js';

const SPEC_FIELDS = ['request', 'workspace', 'maxRepairAttempts', 'requirements', 'tasks', 'checks', 'protectedFiles'];
/** Marks a model-generated draft (see src/planner). Drafts are never delivered. */
export const DRAFT_KIND = 'ade-draft-spec';

/**
 * Validates a spec and builds the initial run and check suite, so any
 * problem is reported before an agent is started or a command is run.
 *
 * @param {object} spec parsed spec
 * @param {string} baseDir directory that relative paths are resolved against
 */
export function prepareDelivery(spec, baseDir) {
  requireObject(spec, 'Spec');
  if (spec.kind === DRAFT_KIND) {
    throw new ValidationError('This is an unapproved draft spec. Review it, then run `ade approve` to create spec.json.', {
      code: 'DRAFT_NOT_APPROVED',
    });
  }
  rejectUnknownKeys(spec, SPEC_FIELDS, 'Spec');
  const workspace =
    spec.workspace === undefined ? null : resolve(baseDir, requireNonEmptyString(spec.workspace, 'workspace', 'Spec'));
  const run = createDeliveryRun({
    request: spec.request,
    requirements: spec.requirements,
    tasks: spec.tasks,
    maxRepairAttempts: spec.maxRepairAttempts,
  });
  const suite = createCheckSuite(spec.checks ?? [], run.requirements);
  const protectedFiles = (spec.protectedFiles ?? []).map((entry, i) => protectedFile(entry, i, baseDir));
  return { run, suite, workspace, protectedFiles };
}

export async function loadSpec(path) {
  const text = await readFile(path, 'utf8');
  let spec;
  try {
    spec = JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`Spec ${path} is not valid JSON: ${error.message}`, { code: 'INVALID_SPEC' });
  }
  return prepareDelivery(spec, dirname(resolve(path)));
}

function protectedFile(entry, index, baseDir) {
  requireObject(entry, `protectedFiles[${index}]`);
  rejectUnknownKeys(entry, ['from', 'to', 'sha256'], 'Protected file');
  const from = requireNonEmptyString(entry.from, 'from', 'Protected file');
  if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    throw new ValidationError(
      `Protected file "${from}" needs its approved SHA-256 as 64 lowercase hex characters in "sha256". ` +
        'Specs from `ade approve` include it; for a hand-written spec, review the file and add the output of `sha256sum <file>`.',
      { code: 'MISSING_HASH', details: { from } },
    );
  }
  const to = requireNonEmptyString(entry.to, 'to', 'Protected file');
  const target = normalize(to);
  if (isAbsolute(to) || target === '..' || target.startsWith(`..${sep}`)) {
    throw new ValidationError(`Protected file target "${to}" must be a relative path inside the workspace.`, {
      code: 'UNSAFE_PATH',
      details: { to },
    });
  }
  return Object.freeze({ source: resolve(baseDir, from), target, sha256: entry.sha256 });
}
