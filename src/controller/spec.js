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
 *
 * `ade approve` also writes `"origin": "ade-plan"`. Checks in such a spec came
 * from a model, so they are restricted to `node --test <approved test files>`
 * (see assertPlannedChecks), at approval and again at delivery. Hand-written
 * specs have no `origin` and may use any command. `spec.json` itself is not
 * integrity-protected: anyone who can edit it can change its checks, hashes or origin.
 */
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { ValidationError } from '../domain/errors.js';
import { createDeliveryRun } from '../domain/delivery-run.js';
import { rejectUnknownKeys, requireNonEmptyString, requireObject } from '../domain/validation.js';
import { createCheckSuite } from '../verification/check.js';

const SPEC_FIELDS = ['request', 'origin', 'workspace', 'maxRepairAttempts', 'requirements', 'tasks', 'checks', 'protectedFiles'];
/** Marks a spec created by `ade approve` from a planner draft. */
export const PLANNED_ORIGIN = 'ade-plan';
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
  if (spec.origin !== undefined && spec.origin !== PLANNED_ORIGIN) {
    throw new ValidationError(`Spec "origin" must be "${PLANNED_ORIGIN}" or absent.`, { code: 'INVALID_FIELD', details: { field: 'origin' } });
  }
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
  if (spec.origin === PLANNED_ORIGIN) assertPlannedChecks(suite, protectedFiles);
  return { run, suite, workspace, protectedFiles };
}

/**
 * Planner-generated checks may only be `node --test` followed by approved test
 * files, run from the application directory and expecting exit code 0. No
 * other program, flag or file is accepted from model output.
 */
export function assertPlannedChecks(suite, protectedFiles) {
  const approved = new Set(protectedFiles.map((f) => f.target));
  for (const check of suite) {
    const [flag, ...files] = check.args;
    const supported =
      check.command === 'node' &&
      flag === '--test' &&
      files.length > 0 &&
      files.every((f) => approved.has(normalize(f))) &&
      check.cwd === '.' &&
      check.expectExitCode === 0;
    if (!supported) {
      throw new ValidationError(
        `Check "${check.id}" (\`${[check.command, ...check.args].join(' ')}\`) is not supported in a planned spec: ` +
          'it must be `node --test` followed only by approved acceptance test files, run from the application directory, expecting exit code 0.',
        { code: 'UNSUPPORTED_CHECK', details: { checkId: check.id } },
      );
    }
  }
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
