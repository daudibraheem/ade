import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_TRANSITIONS,
  TASK_TRANSITIONS,
  REQUIREMENT_TRANSITIONS,
  RUN_STATUS,
  TASK_STATUS,
  REQUIREMENT_STATUS,
  assertTransition,
  canTransition,
} from '../../src/domain/state-transitions.js';
import { InvalidTransitionError, ValidationError } from '../../src/domain/errors.js';

describe('transition tables', () => {
  it('cover exactly the declared statuses and only point at known statuses', () => {
    for (const [table, statuses] of [
      [RUN_TRANSITIONS, RUN_STATUS],
      [TASK_TRANSITIONS, TASK_STATUS],
      [REQUIREMENT_TRANSITIONS, REQUIREMENT_STATUS],
    ]) {
      assert.deepEqual(Object.keys(table).sort(), Object.values(statuses).sort());
      for (const targets of Object.values(table)) {
        for (const target of targets) assert.ok(Object.hasOwn(table, target), `unknown target ${target}`);
      }
    }
  });

  it('are frozen so rules cannot be altered at runtime', () => {
    assert.throws(() => {
      RUN_TRANSITIONS.created.push('completed');
    }, TypeError);
    assert.throws(() => {
      RUN_TRANSITIONS.created = ['completed'];
    }, TypeError);
  });

  it('do not allow a run to jump straight to completed from implementation', () => {
    assert.equal(canTransition(RUN_TRANSITIONS, 'executing', 'completed'), false);
    assert.equal(canTransition(RUN_TRANSITIONS, 'repairing', 'completed'), false);
    assert.equal(canTransition(RUN_TRANSITIONS, 'verifying', 'completed'), true);
  });

  it('treat completed and failed runs as terminal', () => {
    assert.deepEqual(RUN_TRANSITIONS.completed, []);
    assert.deepEqual(RUN_TRANSITIONS.failed, []);
  });
});

describe('assertTransition', () => {
  it('accepts an allowed transition', () => {
    assert.doesNotThrow(() => assertTransition(TASK_TRANSITIONS, 'pending', 'ready', 'task'));
  });

  it('rejects a disallowed transition and lists the allowed alternatives', () => {
    assert.throws(
      () => assertTransition(TASK_TRANSITIONS, 'pending', 'completed', 'task'),
      (err) =>
        err instanceof InvalidTransitionError &&
        err.code === 'INVALID_TRANSITION' &&
        /pending.*completed/.test(err.message) &&
        /Allowed next statuses: ready, blocked/.test(err.message),
    );
  });

  it('explains when the current status is terminal', () => {
    assert.throws(() => assertTransition(RUN_TRANSITIONS, 'completed', 'planning', 'run'), /terminal/);
  });

  it('rejects unknown target statuses as a validation error', () => {
    assert.throws(
      () => assertTransition(RUN_TRANSITIONS, 'created', 'done', 'run'),
      (err) => err instanceof ValidationError && err.code === 'UNKNOWN_STATUS',
    );
  });

  it('does not treat inherited object keys as statuses', () => {
    assert.throws(() => assertTransition(RUN_TRANSITIONS, 'created', 'toString', 'run'), ValidationError);
    assert.equal(canTransition(RUN_TRANSITIONS, 'constructor', 'planning'), false);
  });
});
