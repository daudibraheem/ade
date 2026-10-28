/**
 * Lifecycle definitions. These tables only say which status changes are
 * structurally allowed. Contextual guards (dependencies finished, evidence
 * present, requirements verified) live in the owning modules.
 */
import { InvalidTransitionError, ValidationError } from './errors.js';

function freezeTable(table) {
  for (const key of Object.keys(table)) Object.freeze(table[key]);
  return Object.freeze(table);
}

export const RUN_STATUS = Object.freeze({
  CREATED: 'created',
  PLANNING: 'planning',
  EXECUTING: 'executing',
  VERIFYING: 'verifying',
  REPAIRING: 'repairing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

// `blocked` may only resume to the status it was blocked from; that rule is
// enforced in delivery-run.js because it depends on the run's history.
export const RUN_TRANSITIONS = freezeTable({
  created: ['planning', 'failed', 'blocked'],
  planning: ['executing', 'failed', 'blocked'],
  executing: ['verifying', 'failed', 'blocked'],
  verifying: ['completed', 'repairing', 'failed', 'blocked'],
  repairing: ['verifying', 'failed', 'blocked'],
  blocked: ['planning', 'executing', 'verifying', 'repairing', 'failed'],
  completed: [],
  failed: [],
});

export const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  BLOCKED: 'blocked',
});

export const TASK_TRANSITIONS = freezeTable({
  pending: ['ready', 'blocked'],
  ready: ['in_progress', 'blocked'],
  in_progress: ['completed', 'failed', 'blocked'],
  failed: ['pending'],
  blocked: ['pending'],
  completed: [],
});

export const REQUIREMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  VERIFIED: 'verified',
  FAILED: 'failed',
  UNVERIFIED: 'unverified',
});

// Every outcome returns to `pending` (and discards evidence) before it can be
// re-assessed, so stale evidence never carries over into a new verdict.
export const REQUIREMENT_TRANSITIONS = freezeTable({
  pending: ['verified', 'failed', 'unverified'],
  verified: ['pending'],
  failed: ['pending'],
  unverified: ['pending'],
});

export function canTransition(table, from, to) {
  return Object.hasOwn(table, from) && table[from].includes(to);
}

/**
 * Throws if `to` is not a known status or the table forbids `from -> to`.
 * `entity` is used only for error messages (e.g. "run", "task").
 */
export function assertTransition(table, from, to, entity) {
  if (!Object.hasOwn(table, to)) {
    throw new ValidationError(
      `Unknown ${entity} status "${to}". Expected one of: ${Object.keys(table).join(', ')}.`,
      { code: 'UNKNOWN_STATUS', details: { entity, status: to } },
    );
  }
  if (!canTransition(table, from, to)) {
    const allowed = table[from] ?? [];
    throw new InvalidTransitionError(
      `Cannot move ${entity} from "${from}" to "${to}". ` +
        (allowed.length ? `Allowed next statuses: ${allowed.join(', ')}.` : `"${from}" is terminal.`),
      { details: { entity, from, to, allowed: [...allowed] } },
    );
  }
}
