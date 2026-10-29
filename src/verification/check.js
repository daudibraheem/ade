/**
 * A check is one approved, executable verification step: a program, its
 * arguments, where to run it, and the requirements it provides evidence for.
 *
 * Checks come from human-approved configuration, never from the coding agent.
 * They are immutable plain objects, like the domain model.
 */
import { isAbsolute, normalize, sep } from 'node:path';
import { ValidationError } from '../domain/errors.js';
import {
  assertUniqueIds,
  optionalNonEmptyString,
  rejectUnknownKeys,
  requireNonEmptyString,
  requireObject,
  stringList,
} from '../domain/validation.js';

const CHECK_FIELDS = ['id', 'description', 'command', 'args', 'cwd', 'timeoutMs', 'expectExitCode', 'requirementIds'];
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;

export function createCheck(input) {
  requireObject(input, 'Check');
  rejectUnknownKeys(input, CHECK_FIELDS, 'Check');
  const id = requireNonEmptyString(input.id, 'id', 'Check');
  const requirementIds = stringList(input.requirementIds, 'requirementIds', 'Check');
  if (requirementIds.length === 0) {
    throw new ValidationError(`Check "${id}" must name at least one requirement it verifies.`, {
      code: 'INVALID_FIELD',
      details: { entity: 'Check', field: 'requirementIds', checkId: id },
    });
  }
  assertUniqueIds(requirementIds, `requirement reference of check "${id}"`);

  const check = {
    id,
    command: requireNonEmptyString(input.command, 'command', 'Check'),
    args: stringList(input.args, 'args', 'Check'),
    cwd: relativeCwd(input.cwd, id),
    timeoutMs: integerInRange(input.timeoutMs, 'timeoutMs', id, 1, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    expectExitCode: integerInRange(input.expectExitCode, 'expectExitCode', id, 0, 255, 0),
    requirementIds,
  };
  const description = optionalNonEmptyString(input.description, 'description', 'Check');
  if (description !== undefined) check.description = description;
  return Object.freeze({ ...check, args: Object.freeze(check.args), requirementIds: Object.freeze(requirementIds) });
}

/**
 * Builds the check suite for a set of requirements and validates traceability
 * in both directions: every check targets known requirements, and every
 * requirement's declared `checkIds` exist and point back at it.
 *
 * @param {object[]} checkSpecs
 * @param {object[]} requirements domain requirements (with `id` and `checkIds`)
 */
export function createCheckSuite(checkSpecs, requirements) {
  if (!Array.isArray(checkSpecs)) {
    throw new ValidationError('Check suite must be an array of checks.', { code: 'INVALID_INPUT' });
  }
  const checks = checkSpecs.map(createCheck);
  assertUniqueIds(checks.map((c) => c.id), 'check');

  const byId = new Map(checks.map((c) => [c.id, c]));
  const requirementIds = new Set(requirements.map((r) => r.id));
  for (const check of checks) {
    for (const reqId of check.requirementIds) {
      if (!requirementIds.has(reqId)) {
        throw new ValidationError(`Check "${check.id}" references unknown requirement "${reqId}".`, {
          code: 'UNKNOWN_REQUIREMENT',
          details: { checkId: check.id, requirementId: reqId },
        });
      }
    }
  }
  for (const req of requirements) {
    for (const checkId of req.checkIds) {
      const check = byId.get(checkId);
      if (!check) {
        throw new ValidationError(`Requirement "${req.id}" declares unknown check "${checkId}".`, {
          code: 'UNKNOWN_CHECK',
          details: { requirementId: req.id, checkId },
        });
      }
      if (!check.requirementIds.includes(req.id)) {
        throw new ValidationError(`Requirement "${req.id}" declares check "${checkId}", which does not list it.`, {
          code: 'TRACEABILITY_MISMATCH',
          details: { requirementId: req.id, checkId },
        });
      }
    }
  }
  return Object.freeze(checks);
}

/** The checks that provide evidence for a requirement: its declared ones plus any that name it. */
export function checksForRequirement(suite, requirement) {
  return suite.filter((c) => requirement.checkIds.includes(c.id) || c.requirementIds.includes(requirement.id));
}

// A check's working directory is always relative to the workspace and may not
// climb out of it. The runner re-checks this against the real filesystem.
function relativeCwd(value, checkId) {
  if (value === undefined) return '.';
  const cwd = requireNonEmptyString(value, 'cwd', 'Check');
  const normalized = normalize(cwd);
  if (isAbsolute(cwd) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new ValidationError(`Check "${checkId}" cwd must be a relative path inside the workspace.`, {
      code: 'UNSAFE_PATH',
      details: { checkId, cwd },
    });
  }
  return normalized;
}

function integerInRange(value, field, checkId, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`Check "${checkId}" ${field} must be an integer from ${min} to ${max}.`, {
      code: 'INVALID_FIELD',
      details: { entity: 'Check', field, checkId },
    });
  }
  return value;
}
