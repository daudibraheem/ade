import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addRequirement,
  addTask,
  completionBlockers,
  createDeliveryRun,
  recordRequirementEvidence,
  transitionRun,
  transitionRunRequirement,
  transitionRunTask,
} from '../../src/domain/delivery-run.js';
import { InvalidTransitionError, InvariantViolationError, ValidationError } from '../../src/domain/errors.js';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:01:00.000Z';

const hasCode = (Type, code) => (err) => err instanceof Type && err.code === code;

function plannedRun() {
  return createDeliveryRun(
    {
      id: 'run-1',
      request: 'Build a todo app with login',
      requirements: [
        { id: 'req-login', description: 'Users can log in' },
        { id: 'req-todo', description: 'Users can add todos' },
        { id: 'req-theme', description: 'Dark mode', required: false },
      ],
      tasks: [
        { id: 'auth', title: 'Auth', description: 'Implement login', requirementIds: ['req-login'] },
        { id: 'todos', title: 'Todos', description: 'Todo CRUD', dependsOn: ['auth'], requirementIds: ['req-todo'] },
      ],
    },
    { now: T0 },
  );
}

const moveRun = (run, statuses) => statuses.reduce((r, s) => transitionRun(r, s), run);

function runTask(run, id) {
  return ['ready', 'in_progress', 'completed'].reduce((r, s) => transitionRunTask(r, id, s), run);
}

function verify(run, reqId) {
  const withEvidence = recordRequirementEvidence(run, reqId, { checkId: `check:${reqId}`, passed: true });
  return transitionRunRequirement(withEvidence, reqId, 'verified');
}

/** A run in `verifying` with all tasks completed and nothing verified yet. */
function runAwaitingVerification() {
  let run = moveRun(plannedRun(), ['planning', 'executing']);
  run = runTask(runTask(run, 'auth'), 'todos');
  return transitionRun(run, 'verifying');
}

describe('createDeliveryRun', () => {
  it('creates a run in created status with requirements, tasks and timestamps', () => {
    const run = plannedRun();
    assert.equal(run.id, 'run-1');
    assert.equal(run.request, 'Build a todo app with login');
    assert.equal(run.status, 'created');
    assert.equal(run.createdAt, T0);
    assert.equal(run.updatedAt, T0);
    assert.deepEqual(run.requirements.map((r) => [r.id, r.status]), [
      ['req-login', 'pending'],
      ['req-todo', 'pending'],
      ['req-theme', 'pending'],
    ]);
    assert.deepEqual(run.tasks.map((t) => t.id), ['auth', 'todos']);
    assert.ok(Object.isFrozen(run) && Object.isFrozen(run.tasks) && Object.isFrozen(run.requirements));
  });

  it('generates a unique id when none is given', () => {
    const a = createDeliveryRun({ request: 'x' });
    const b = createDeliveryRun({ request: 'x' });
    assert.match(a.id, /^[0-9a-f-]{36}$/);
    assert.notEqual(a.id, b.id);
  });

  for (const [label, input, code] of [
    ['missing request', { id: 'r' }, 'INVALID_FIELD'],
    ['blank request', { request: '  ' }, 'INVALID_FIELD'],
    ['non-array requirements', { request: 'x', requirements: {} }, 'INVALID_FIELD'],
    ['unknown field', { request: 'x', status: 'completed' }, 'UNKNOWN_FIELD'],
    ['invalid requirement', { request: 'x', requirements: [{ id: 'r' }] }, 'INVALID_FIELD'],
    [
      'duplicate requirement ids',
      { request: 'x', requirements: [{ id: 'r', description: 'a' }, { id: 'r', description: 'b' }] },
      'DUPLICATE_ID',
    ],
    [
      'duplicate task ids',
      { request: 'x', tasks: [{ id: 't', title: 'a', description: 'a' }, { id: 't', title: 'b', description: 'b' }] },
      'DUPLICATE_ID',
    ],
    [
      'unknown dependency',
      { request: 'x', tasks: [{ id: 't', title: 'a', description: 'a', dependsOn: ['nope'] }] },
      'UNKNOWN_DEPENDENCY',
    ],
    [
      'dependency cycle',
      {
        request: 'x',
        tasks: [
          { id: 'a', title: 'a', description: 'a', dependsOn: ['b'] },
          { id: 'b', title: 'b', description: 'b', dependsOn: ['a'] },
        ],
      },
      'DEPENDENCY_CYCLE',
    ],
    [
      'unknown requirement reference',
      { request: 'x', tasks: [{ id: 't', title: 'a', description: 'a', requirementIds: ['ghost'] }] },
      'UNKNOWN_REQUIREMENT',
    ],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() => createDeliveryRun(input), hasCode(ValidationError, code));
    });
  }

  it('rejects an invalid timestamp', () => {
    assert.throws(() => createDeliveryRun({ request: 'x' }, { now: 'not a date' }), hasCode(ValidationError, 'INVALID_TIMESTAMP'));
  });

  it('does not share state with the caller input', () => {
    const input = { request: 'x', requirements: [{ id: 'r', description: 'd', acceptanceCriteria: ['a'] }] };
    const run = createDeliveryRun(input);
    input.requirements[0].acceptanceCriteria.push('b');
    input.requirements.push({ id: 'r2', description: 'd' });
    assert.equal(run.requirements.length, 1);
    assert.deepEqual(run.requirements[0].acceptanceCriteria, ['a']);
  });
});

describe('run lifecycle', () => {
  it('follows the full happy path to completed', () => {
    let run = runAwaitingVerification();
    run = verify(verify(run, 'req-login'), 'req-todo');
    run = transitionRun(run, 'completed', { now: T1 });
    assert.equal(run.status, 'completed');
    assert.equal(run.updatedAt, T1);
    assert.equal(run.createdAt, T0);
  });

  it('rejects arbitrary status changes', () => {
    const run = plannedRun();
    assert.throws(() => transitionRun(run, 'executing'), InvalidTransitionError);
    assert.throws(() => transitionRun(run, 'verifying'), InvalidTransitionError);
    assert.throws(() => transitionRun(run, 'completed'), InvalidTransitionError);
    assert.throws(() => transitionRun(run, 'nonsense'), hasCode(ValidationError, 'UNKNOWN_STATUS'));
  });

  it('rejects leaving terminal states', () => {
    const failed = transitionRun(plannedRun(), 'failed');
    assert.throws(() => transitionRun(failed, 'planning'), InvalidTransitionError);
  });

  it('cannot start executing without requirements and tasks', () => {
    const empty = transitionRun(createDeliveryRun({ request: 'x' }), 'planning');
    assert.throws(() => transitionRun(empty, 'executing'), hasCode(InvariantViolationError, 'PLAN_INCOMPLETE'));
  });

  it('supports a repair loop: verifying -> repairing -> verifying', () => {
    let run = runAwaitingVerification();
    run = recordRequirementEvidence(run, 'req-todo', { checkId: 'e2e:add-todo', passed: false });
    run = transitionRunRequirement(run, 'req-todo', 'failed');
    run = transitionRun(run, 'repairing');
    run = transitionRunRequirement(run, 'req-todo', 'pending');
    run = addTask(run, { id: 'fix-todos', title: 'Fix', description: 'Fix add todo', dependsOn: ['todos'] });
    run = runTask(run, 'fix-todos');
    run = transitionRun(run, 'verifying');
    run = verify(verify(run, 'req-login'), 'req-todo');
    assert.equal(transitionRun(run, 'completed').status, 'completed');
  });

  it('a blocked run resumes only to the status it was blocked from', () => {
    const executing = moveRun(plannedRun(), ['planning', 'executing']);
    const blocked = transitionRun(executing, 'blocked');
    assert.equal(blocked.blockedFrom, 'executing');
    assert.throws(() => transitionRun(blocked, 'verifying'), hasCode(InvalidTransitionError, 'INVALID_RESUME'));
    const resumed = transitionRun(blocked, 'executing');
    assert.equal(resumed.status, 'executing');
    assert.equal(resumed.blockedFrom, null);
    assert.equal(transitionRun(blocked, 'failed').status, 'failed');
  });
});

describe('premature completion', () => {
  it('cannot complete directly after implementation finishes', () => {
    let run = moveRun(plannedRun(), ['planning', 'executing']);
    run = runTask(runTask(run, 'auth'), 'todos');
    assert.throws(() => transitionRun(run, 'completed'), InvalidTransitionError);
  });

  it('cannot complete while required requirements are unverified', () => {
    const run = verify(runAwaitingVerification(), 'req-login');
    assert.throws(
      () => transitionRun(run, 'completed'),
      (err) =>
        err instanceof InvariantViolationError &&
        err.code === 'COMPLETION_BLOCKED' &&
        err.details.blockers.some((b) => b.includes('req-todo')) &&
        !err.details.blockers.some((b) => b.includes('req-theme')),
    );
  });

  it('cannot complete when a required requirement is marked unverified or failed', () => {
    let run = verify(runAwaitingVerification(), 'req-login');
    const unverified = transitionRunRequirement(run, 'req-todo', 'unverified');
    assert.throws(() => transitionRun(unverified, 'completed'), hasCode(InvariantViolationError, 'COMPLETION_BLOCKED'));
    run = recordRequirementEvidence(run, 'req-todo', { checkId: 'c', passed: false });
    const failed = transitionRunRequirement(run, 'req-todo', 'failed');
    assert.throws(() => transitionRun(failed, 'completed'), hasCode(InvariantViolationError, 'COMPLETION_BLOCKED'));
  });

  it('cannot complete a run with no requirements', () => {
    const run = createDeliveryRun({ request: 'x' });
    assert.deepEqual(completionBlockers(run), ['The run has no requirements.']);
  });

  it('cannot verify a requirement in the run without evidence', () => {
    const run = runAwaitingVerification();
    assert.throws(
      () => transitionRunRequirement(run, 'req-login', 'verified'),
      hasCode(InvariantViolationError, 'MISSING_EVIDENCE'),
    );
  });

  it('does not allow verification outside the verifying phase', () => {
    const executing = moveRun(plannedRun(), ['planning', 'executing']);
    assert.throws(
      () => recordRequirementEvidence(executing, 'req-login', { checkId: 'c', passed: true }),
      hasCode(InvariantViolationError, 'RUN_STATUS_DISALLOWS'),
    );
    assert.throws(
      () => transitionRunRequirement(executing, 'req-login', 'unverified'),
      hasCode(InvariantViolationError, 'RUN_STATUS_DISALLOWS'),
    );
  });

  it('rejects invalid evidence recorded through the run', () => {
    const run = runAwaitingVerification();
    assert.throws(() => recordRequirementEvidence(run, 'req-login', { checkId: '', passed: true }), ValidationError);
    assert.throws(() => recordRequirementEvidence(run, 'req-login', { checkId: 'c', passed: 'yes' }), ValidationError);
    assert.throws(() => recordRequirementEvidence(run, 'ghost', { checkId: 'c', passed: true }), hasCode(ValidationError, 'NOT_FOUND'));
  });
});

describe('tasks within a run', () => {
  it('cannot make a task ready before its dependencies complete', () => {
    const run = moveRun(plannedRun(), ['planning', 'executing']);
    assert.throws(
      () => transitionRunTask(run, 'todos', 'ready'),
      hasCode(InvariantViolationError, 'DEPENDENCIES_UNFINISHED'),
    );
    const afterAuth = runTask(run, 'auth');
    assert.equal(transitionRunTask(afterAuth, 'todos', 'ready').tasks[1].status, 'ready');
  });

  it('rejects task status changes outside execution or repair', () => {
    const planning = transitionRun(plannedRun(), 'planning');
    assert.throws(() => transitionRunTask(planning, 'auth', 'ready'), hasCode(InvariantViolationError, 'RUN_STATUS_DISALLOWS'));
  });

  it('rejects adding a task that would create a cycle or reference unknown items', () => {
    const run = transitionRun(plannedRun(), 'planning');
    assert.throws(
      () => addTask(run, { id: 'auth', title: 'dup', description: 'dup' }),
      hasCode(ValidationError, 'DUPLICATE_ID'),
    );
    assert.throws(
      () => addTask(run, { id: 'x', title: 'x', description: 'x', dependsOn: ['missing'] }),
      hasCode(ValidationError, 'UNKNOWN_DEPENDENCY'),
    );
    assert.throws(
      () => addTask(run, { id: 'x', title: 'x', description: 'x', requirementIds: ['missing'] }),
      hasCode(ValidationError, 'UNKNOWN_REQUIREMENT'),
    );
  });

  it('rejects adding requirements once execution has started', () => {
    const run = moveRun(plannedRun(), ['planning', 'executing']);
    assert.throws(
      () => addRequirement(run, { id: 'late', description: 'late' }),
      hasCode(InvariantViolationError, 'RUN_STATUS_DISALLOWS'),
    );
  });

  it('adds requirements during planning and rejects duplicates', () => {
    const run = transitionRun(plannedRun(), 'planning');
    const next = addRequirement(run, { id: 'req-new', description: 'New' }, { now: T1 });
    assert.equal(next.requirements.length, 4);
    assert.equal(next.updatedAt, T1);
    assert.equal(run.requirements.length, 3);
    assert.throws(() => addRequirement(run, { id: 'req-login', description: 'dup' }), hasCode(ValidationError, 'DUPLICATE_ID'));
  });
});

describe('consistency', () => {
  it('leaves the run untouched when any operation fails', () => {
    const run = moveRun(plannedRun(), ['planning', 'executing']);
    const snapshot = structuredClone(run);
    assert.throws(() => transitionRun(run, 'completed'));
    assert.throws(() => transitionRunTask(run, 'todos', 'ready'));
    assert.throws(() => transitionRunTask(run, 'ghost', 'ready'));
    assert.throws(() => addTask(run, { id: 'x' }));
    assert.deepEqual(run, snapshot);
  });

  it('updating one task does not alter other tasks or requirements', () => {
    const run = moveRun(plannedRun(), ['planning', 'executing']);
    const next = transitionRunTask(run, 'auth', 'ready');
    assert.equal(next.tasks[0].status, 'ready');
    assert.equal(run.tasks[0].status, 'pending');
    assert.equal(next.tasks[1], run.tasks[1], 'untouched task is the same frozen object');
    next.requirements.forEach((req, i) => assert.equal(req, run.requirements[i]));
  });

  it('cannot be mutated directly', () => {
    const run = plannedRun();
    assert.throws(() => {
      run.status = 'completed';
    }, TypeError);
    assert.throws(() => {
      run.requirements[0].status = 'verified';
    }, TypeError);
    assert.throws(() => {
      run.tasks.push({});
    }, TypeError);
    assert.equal(run.status, 'created');
  });
});

describe('repair limit', () => {
  const failRequirement = (run) => {
    run = recordRequirementEvidence(run, 'req-todo', { checkId: 'e2e', passed: false });
    return transitionRunRequirement(run, 'req-todo', 'failed');
  };
  const repairAndReverify = (run) => {
    run = transitionRun(run, 'repairing');
    run = transitionRunRequirement(run, 'req-todo', 'pending');
    run = transitionRun(run, 'verifying');
    return failRequirement(run);
  };

  it('defaults to two repair attempts and counts each one', () => {
    let run = failRequirement(runAwaitingVerification());
    assert.equal(run.maxRepairAttempts, 2);
    assert.equal(run.repairAttempts, 0);
    run = repairAndReverify(run);
    run = repairAndReverify(run);
    assert.equal(run.repairAttempts, 2);
    assert.throws(() => transitionRun(run, 'repairing'), hasCode(InvariantViolationError, 'REPAIR_LIMIT_REACHED'));
    assert.equal(transitionRun(run, 'failed').status, 'failed');
  });

  it('a limit of zero forbids repairs', () => {
    let run = createDeliveryRun({
      request: 'x',
      maxRepairAttempts: 0,
      requirements: [{ id: 'r', description: 'r' }],
      tasks: [{ id: 't', title: 't', description: 't' }],
    });
    run = transitionRun(runTask(moveRun(run, ['planning', 'executing']), 't'), 'verifying');
    assert.throws(() => transitionRun(run, 'repairing'), hasCode(InvariantViolationError, 'REPAIR_LIMIT_REACHED'));
  });

  it('resuming a blocked repair does not use another attempt', () => {
    let run = transitionRun(failRequirement(runAwaitingVerification()), 'repairing');
    run = transitionRun(transitionRun(run, 'blocked'), 'repairing');
    assert.equal(run.repairAttempts, 1);
  });

  for (const [label, value] of [['a negative limit', -1], ['a fractional limit', 1.5], ['a string limit', '2']]) {
    it(`rejects ${label}`, () => {
      assert.throws(
        () => createDeliveryRun({ request: 'x', maxRepairAttempts: value }),
        hasCode(ValidationError, 'INVALID_FIELD'),
      );
    });
  }
});
