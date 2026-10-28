/**
 * A task is a unit of implementation work. Tasks are immutable; every
 * operation returns a new frozen object.
 */
import { InvariantViolationError, ValidationError } from './errors.js';
import { TASK_STATUS, TASK_TRANSITIONS, assertTransition } from './state-transitions.js';
import {
  assertUniqueIds,
  rejectUnknownKeys,
  requireNonEmptyString,
  requireObject,
  stringList,
} from './validation.js';

const TASK_FIELDS = ['id', 'title', 'description', 'dependsOn', 'requirementIds'];

export function createTask(input) {
  requireObject(input, 'Task');
  rejectUnknownKeys(input, TASK_FIELDS, 'Task');
  const id = requireNonEmptyString(input.id, 'id', 'Task');
  const dependsOn = stringList(input.dependsOn, 'dependsOn', 'Task');
  const requirementIds = stringList(input.requirementIds, 'requirementIds', 'Task');

  if (dependsOn.includes(id)) {
    throw new ValidationError(`Task "${id}" cannot depend on itself.`, {
      code: 'SELF_DEPENDENCY',
      details: { taskId: id },
    });
  }
  assertUniqueIds(dependsOn, `dependency of task "${id}"`);
  assertUniqueIds(requirementIds, `requirement reference of task "${id}"`);

  return freezeTask({
    id,
    title: requireNonEmptyString(input.title, 'title', 'Task'),
    description: requireNonEmptyString(input.description, 'description', 'Task'),
    status: TASK_STATUS.PENDING,
    dependsOn,
    requirementIds,
  });
}

/**
 * Changes a task's status. `allTasks` is the collection the task belongs to;
 * it is needed to check that dependencies are completed before the task can
 * become `ready`.
 */
export function transitionTask(task, nextStatus, allTasks) {
  assertTransition(TASK_TRANSITIONS, task.status, nextStatus, 'task');

  if (nextStatus === TASK_STATUS.READY) {
    if (!Array.isArray(allTasks)) {
      throw new ValidationError(
        'transitionTask(task, "ready", allTasks) requires the task collection to check dependencies.',
        { code: 'INVALID_INPUT' },
      );
    }
    const byId = new Map(allTasks.map((t) => [t.id, t]));
    const unfinished = task.dependsOn.filter((depId) => byId.get(depId)?.status !== TASK_STATUS.COMPLETED);
    if (unfinished.length) {
      throw new InvariantViolationError(
        `Task "${task.id}" cannot become ready: dependencies not completed: ${unfinished.join(', ')}.`,
        { code: 'DEPENDENCIES_UNFINISHED', details: { taskId: task.id, unfinished } },
      );
    }
  }

  return freezeTask({ ...task, status: nextStatus });
}

/**
 * Validates the dependency graph of a task collection: every dependency
 * must refer to a task in the collection, and there must be no cycles.
 */
export function assertValidDependencyGraph(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (!byId.has(depId)) {
        throw new ValidationError(`Task "${task.id}" depends on unknown task "${depId}".`, {
          code: 'UNKNOWN_DEPENDENCY',
          details: { taskId: task.id, dependencyId: depId },
        });
      }
    }
  }

  // Depth-first search with three colours; a back edge to a "visiting" node is a cycle.
  const state = new Map(); // id -> 'visiting' | 'done'
  const path = [];
  const visit = (id) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const cycle = [...path.slice(path.indexOf(id)), id];
      throw new ValidationError(`Dependency cycle detected: ${cycle.join(' -> ')}.`, {
        code: 'DEPENDENCY_CYCLE',
        details: { cycle },
      });
    }
    state.set(id, 'visiting');
    path.push(id);
    for (const depId of byId.get(id).dependsOn) visit(depId);
    path.pop();
    state.set(id, 'done');
  };
  for (const task of tasks) visit(task.id);
}

function freezeTask(task) {
  return Object.freeze({
    ...task,
    dependsOn: Object.freeze([...task.dependsOn]),
    requirementIds: Object.freeze([...task.requirementIds]),
  });
}
