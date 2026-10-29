/**
 * A delivery run is one attempt to fulfil a user's application request.
 *
 * Runs are immutable: every operation validates first and then returns a new
 * frozen run, so a rejected operation leaves the caller's run untouched.
 * The run builds its own requirements and tasks from plain input specs, so
 * callers cannot inject a requirement that is already marked `verified`.
 */
import { randomUUID } from 'node:crypto';
import { InvalidTransitionError, InvariantViolationError, ValidationError } from './errors.js';
import { createRequirement, recordEvidence, transitionRequirement } from './requirement.js';
import { RUN_STATUS, RUN_TRANSITIONS, TASK_STATUS, REQUIREMENT_STATUS, assertTransition } from './state-transitions.js';
import { assertValidDependencyGraph, createTask, transitionTask } from './task.js';
import {
  assertUniqueIds,
  rejectUnknownKeys,
  requireNonEmptyString,
  requireObject,
  toTimestamp,
} from './validation.js';

const RUN_FIELDS = ['id', 'request', 'requirements', 'tasks', 'maxRepairAttempts'];
const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

// Which run statuses permit which kinds of change.
const CAN_ADD_REQUIREMENTS = [RUN_STATUS.CREATED, RUN_STATUS.PLANNING];
const CAN_ADD_TASKS = [RUN_STATUS.CREATED, RUN_STATUS.PLANNING, RUN_STATUS.REPAIRING];
const CAN_CHANGE_TASKS = [RUN_STATUS.EXECUTING, RUN_STATUS.REPAIRING];
const CAN_ASSESS_REQUIREMENTS = [RUN_STATUS.VERIFYING];
const CAN_RESET_REQUIREMENTS = [RUN_STATUS.VERIFYING, RUN_STATUS.REPAIRING];

/**
 * @param {object} input
 * @param {string} [input.id] defaults to a random UUID
 * @param {string} input.request the user's original request
 * @param {object[]} [input.requirements] requirement specs (see createRequirement)
 * @param {object[]} [input.tasks] task specs (see createTask)
 * @param {number} [input.maxRepairAttempts] how many times the run may enter `repairing`; defaults to 2
 * @param {object} [options]
 * @param {Date|string|number} [options.now] creation time; defaults to the current time
 */
export function createDeliveryRun(input, { now } = {}) {
  requireObject(input, 'Delivery run');
  rejectUnknownKeys(input, RUN_FIELDS, 'Delivery run');
  const id = input.id === undefined ? randomUUID() : requireNonEmptyString(input.id, 'id', 'Delivery run');
  const request = requireNonEmptyString(input.request, 'request', 'Delivery run');
  const requirements = specList(input.requirements, 'requirements').map(createRequirement);
  const tasks = specList(input.tasks, 'tasks').map(createTask);
  const maxRepairAttempts = repairLimit(input.maxRepairAttempts);
  const timestamp = toTimestamp(now);

  const run = {
    id,
    request,
    status: RUN_STATUS.CREATED,
    blockedFrom: null,
    repairAttempts: 0,
    maxRepairAttempts,
    requirements,
    tasks,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  assertCollectionsValid(run);
  return freezeRun(run);
}

export function addRequirement(run, spec, { now } = {}) {
  assertRunStatusIn(run, CAN_ADD_REQUIREMENTS, 'add requirements');
  const requirements = [...run.requirements, createRequirement(spec)];
  return commit(run, { requirements }, now);
}

export function addTask(run, spec, { now } = {}) {
  assertRunStatusIn(run, CAN_ADD_TASKS, 'add tasks');
  const tasks = [...run.tasks, createTask(spec)];
  return commit(run, { tasks }, now);
}

/** Moves the run through its lifecycle, enforcing transition and delivery rules. */
export function transitionRun(run, nextStatus, { now } = {}) {
  assertTransition(RUN_TRANSITIONS, run.status, nextStatus, 'run');

  if (run.status === RUN_STATUS.BLOCKED && nextStatus !== RUN_STATUS.FAILED && nextStatus !== run.blockedFrom) {
    throw new InvalidTransitionError(
      `Blocked run can only resume to "${run.blockedFrom}" (where it was blocked) or move to "failed".`,
      { code: 'INVALID_RESUME', details: { from: run.status, to: nextStatus, blockedFrom: run.blockedFrom } },
    );
  }
  if (nextStatus === RUN_STATUS.EXECUTING && run.status === RUN_STATUS.PLANNING) {
    assertPlanReady(run);
  }
  if (nextStatus === RUN_STATUS.COMPLETED) {
    assertDeliverable(run);
  }
  // Only a new repair counts against the limit; resuming a blocked repair does not.
  const startsRepair = nextStatus === RUN_STATUS.REPAIRING && run.status === RUN_STATUS.VERIFYING;
  if (startsRepair && run.repairAttempts >= run.maxRepairAttempts) {
    throw new InvariantViolationError(
      `Run "${run.id}" cannot start another repair: limit of ${run.maxRepairAttempts} reached.`,
      { code: 'REPAIR_LIMIT_REACHED', details: { runId: run.id, repairAttempts: run.repairAttempts } },
    );
  }

  const blockedFrom = nextStatus === RUN_STATUS.BLOCKED ? run.status : null;
  const repairAttempts = run.repairAttempts + (startsRepair ? 1 : 0);
  return commit(run, { status: nextStatus, blockedFrom, repairAttempts }, now);
}

export function transitionRunTask(run, taskId, nextStatus, { now } = {}) {
  assertRunStatusIn(run, CAN_CHANGE_TASKS, 'change task status');
  const index = findIndexById(run.tasks, taskId, 'task');
  const updated = transitionTask(run.tasks[index], nextStatus, run.tasks);
  return commit(run, { tasks: replaceAt(run.tasks, index, updated) }, now);
}

export function recordRequirementEvidence(run, requirementId, evidence, { now } = {}) {
  assertRunStatusIn(run, CAN_ASSESS_REQUIREMENTS, 'record verification evidence');
  const index = findIndexById(run.requirements, requirementId, 'requirement');
  const updated = recordEvidence(run.requirements[index], evidence);
  return commit(run, { requirements: replaceAt(run.requirements, index, updated) }, now);
}

export function transitionRunRequirement(run, requirementId, nextStatus, { now } = {}) {
  const allowedIn = nextStatus === REQUIREMENT_STATUS.PENDING ? CAN_RESET_REQUIREMENTS : CAN_ASSESS_REQUIREMENTS;
  assertRunStatusIn(run, allowedIn, `move a requirement to "${nextStatus}"`);
  const index = findIndexById(run.requirements, requirementId, 'requirement');
  const updated = transitionRequirement(run.requirements[index], nextStatus);
  return commit(run, { requirements: replaceAt(run.requirements, index, updated) }, now);
}

/**
 * Lists the reasons the run cannot be completed yet; an empty list means the
 * minimal delivery rules of this milestone are satisfied.
 */
export function completionBlockers(run) {
  const blockers = [];
  if (run.requirements.length === 0) blockers.push('The run has no requirements.');
  for (const req of run.requirements) {
    if (req.required && req.status !== REQUIREMENT_STATUS.VERIFIED) {
      blockers.push(`Required requirement "${req.id}" is "${req.status}", not "verified".`);
    }
  }
  for (const task of run.tasks) {
    if (task.status !== TASK_STATUS.COMPLETED) {
      blockers.push(`Task "${task.id}" is "${task.status}", not "completed".`);
    }
  }
  return blockers;
}

function assertDeliverable(run) {
  const blockers = completionBlockers(run);
  if (blockers.length) {
    throw new InvariantViolationError(`Run "${run.id}" cannot be completed: ${blockers.join(' ')}`, {
      code: 'COMPLETION_BLOCKED',
      details: { runId: run.id, blockers },
    });
  }
}

function assertPlanReady(run) {
  if (run.requirements.length === 0 || run.tasks.length === 0) {
    throw new InvariantViolationError(
      `Run "${run.id}" cannot start executing: it needs at least one requirement and one task.`,
      { code: 'PLAN_INCOMPLETE', details: { requirements: run.requirements.length, tasks: run.tasks.length } },
    );
  }
}

function assertCollectionsValid(run) {
  assertUniqueIds(run.requirements.map((r) => r.id), 'requirement');
  assertUniqueIds(run.tasks.map((t) => t.id), 'task');
  assertValidDependencyGraph(run.tasks);
  const requirementIds = new Set(run.requirements.map((r) => r.id));
  for (const task of run.tasks) {
    for (const reqId of task.requirementIds) {
      if (!requirementIds.has(reqId)) {
        throw new ValidationError(`Task "${task.id}" references unknown requirement "${reqId}".`, {
          code: 'UNKNOWN_REQUIREMENT',
          details: { taskId: task.id, requirementId: reqId },
        });
      }
    }
  }
}

function assertRunStatusIn(run, statuses, action) {
  if (!statuses.includes(run.status)) {
    throw new InvariantViolationError(
      `Cannot ${action} while run is "${run.status}". Allowed in: ${statuses.join(', ')}.`,
      { code: 'RUN_STATUS_DISALLOWS', details: { runId: run.id, status: run.status, action } },
    );
  }
}

/** Validates the proposed next state and returns it frozen with a new `updatedAt`. */
function commit(run, changes, now) {
  const next = { ...run, ...changes, updatedAt: toTimestamp(now) };
  assertCollectionsValid(next);
  return freezeRun(next);
}

function freezeRun(run) {
  return Object.freeze({
    ...run,
    requirements: Object.freeze([...run.requirements]),
    tasks: Object.freeze([...run.tasks]),
  });
}

function findIndexById(items, id, entity) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) {
    throw new ValidationError(`Unknown ${entity} id "${id}".`, {
      code: 'NOT_FOUND',
      details: { entity, id },
    });
  }
  return index;
}

function replaceAt(items, index, item) {
  return items.map((existing, i) => (i === index ? item : existing));
}

function repairLimit(value) {
  if (value === undefined) return DEFAULT_MAX_REPAIR_ATTEMPTS;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError('Delivery run "maxRepairAttempts" must be a non-negative integer.', {
      code: 'INVALID_FIELD',
      details: { entity: 'Delivery run', field: 'maxRepairAttempts' },
    });
  }
  return value;
}

function specList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`Delivery run "${field}" must be an array.`, {
      code: 'INVALID_FIELD',
      details: { entity: 'Delivery run', field },
    });
  }
  return value;
}
