/**
 * A requirement is a behaviour the delivered application must exhibit.
 *
 * Requirements are immutable: every operation returns a new frozen object.
 * A requirement's verification status can only be changed through
 * `transitionRequirement`, which checks the recorded evidence first.
 */
import { InvariantViolationError, ValidationError } from './errors.js';
import { REQUIREMENT_STATUS, REQUIREMENT_TRANSITIONS, assertTransition } from './state-transitions.js';
import {
  optionalNonEmptyString,
  rejectUnknownKeys,
  requireNonEmptyString,
  requireObject,
  stringList,
} from './validation.js';

const REQUIREMENT_FIELDS = ['id', 'description', 'acceptanceCriteria', 'required'];
// Future milestones are expected to extend this (timestamp, command, exitCode,
// logs, revision) in one place.
const EVIDENCE_FIELDS = ['checkId', 'passed', 'summary'];

/**
 * Builds a validated, frozen evidence record: the outcome of one check.
 * Evidence states what ran and whether it passed. It does not decide which
 * checks are sufficient for a requirement; that is the verification engine's job.
 */
export function createEvidence(input) {
  requireObject(input, 'Evidence');
  rejectUnknownKeys(input, EVIDENCE_FIELDS, 'Evidence');
  const checkId = requireNonEmptyString(input.checkId, 'checkId', 'Evidence');
  if (typeof input.passed !== 'boolean') {
    throw new ValidationError('Evidence "passed" must be a boolean (true or false).', {
      code: 'INVALID_FIELD',
      details: { entity: 'Evidence', field: 'passed' },
    });
  }
  const evidence = { checkId, passed: input.passed };
  const summary = optionalNonEmptyString(input.summary, 'summary', 'Evidence');
  if (summary !== undefined) evidence.summary = summary;
  return Object.freeze(evidence);
}

export function createRequirement(input) {
  requireObject(input, 'Requirement');
  rejectUnknownKeys(input, REQUIREMENT_FIELDS, 'Requirement');
  if (input.required !== undefined && typeof input.required !== 'boolean') {
    throw new ValidationError('Requirement "required" must be a boolean when provided.', {
      code: 'INVALID_FIELD',
      details: { entity: 'Requirement', field: 'required' },
    });
  }
  return freezeRequirement({
    id: requireNonEmptyString(input.id, 'id', 'Requirement'),
    description: requireNonEmptyString(input.description, 'description', 'Requirement'),
    acceptanceCriteria: stringList(input.acceptanceCriteria, 'acceptanceCriteria', 'Requirement'),
    required: input.required ?? true,
    status: REQUIREMENT_STATUS.PENDING,
    evidence: [],
  });
}

/** Appends evidence. Only allowed while the requirement is being assessed (`pending`). */
export function recordEvidence(requirement, evidenceInput) {
  if (requirement.status !== REQUIREMENT_STATUS.PENDING) {
    throw new InvariantViolationError(
      `Cannot record evidence on requirement "${requirement.id}" while it is "${requirement.status}". ` +
        'Reset it to "pending" first.',
      { code: 'EVIDENCE_NOT_ACCEPTED', details: { requirementId: requirement.id, status: requirement.status } },
    );
  }
  const evidence = createEvidence(evidenceInput);
  return freezeRequirement({ ...requirement, evidence: [...requirement.evidence, evidence] });
}

/**
 * The latest result for each distinct check. A check that failed and was
 * re-run successfully counts as passed.
 */
export function latestResultsByCheck(requirement) {
  const latest = new Map();
  for (const item of requirement.evidence) latest.set(item.checkId, item);
  return latest;
}

/**
 * Changes verification status, enforcing the minimal evidence rules:
 * - `verified`: at least one check recorded, and the latest result of every check passed.
 * - `failed`: the latest result of at least one check failed.
 * - `unverified`: verification could not be performed; no evidence needed.
 * - `pending`: discards evidence so a new assessment starts clean.
 */
export function transitionRequirement(requirement, nextStatus) {
  assertTransition(REQUIREMENT_TRANSITIONS, requirement.status, nextStatus, 'requirement');
  const latest = [...latestResultsByCheck(requirement).values()];

  if (nextStatus === REQUIREMENT_STATUS.VERIFIED) {
    if (latest.length === 0) {
      throw new InvariantViolationError(
        `Requirement "${requirement.id}" cannot be verified: no verification evidence has been recorded.`,
        { code: 'MISSING_EVIDENCE', details: { requirementId: requirement.id } },
      );
    }
    const failing = latest.filter((item) => !item.passed).map((item) => item.checkId);
    if (failing.length) {
      throw new InvariantViolationError(
        `Requirement "${requirement.id}" cannot be verified: check(s) ${failing.join(', ')} did not pass.`,
        { code: 'FAILING_EVIDENCE', details: { requirementId: requirement.id, failingChecks: failing } },
      );
    }
  }

  if (nextStatus === REQUIREMENT_STATUS.FAILED && !latest.some((item) => !item.passed)) {
    throw new InvariantViolationError(
      `Requirement "${requirement.id}" cannot be marked failed without evidence of a failing check.`,
      { code: 'MISSING_EVIDENCE', details: { requirementId: requirement.id } },
    );
  }

  const evidence = nextStatus === REQUIREMENT_STATUS.PENDING ? [] : requirement.evidence;
  return freezeRequirement({ ...requirement, status: nextStatus, evidence });
}

function freezeRequirement(requirement) {
  return Object.freeze({
    ...requirement,
    acceptanceCriteria: Object.freeze([...requirement.acceptanceCriteria]),
    evidence: Object.freeze([...requirement.evidence]),
  });
}
