import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertValidDependencyGraph, createTask, transitionTask } from '../../src/domain/task.js';
import { InvalidTransitionError, InvariantViolationError, ValidationError } from '../../src/domain/errors.js';

const spec = (id, dependsOn = [], extra = {}) => ({
  id,
  title: `Task ${id}`,
  description: `Implement ${id}`,
  dependsOn,
  ...extra,
});

const hasCode = (Type, code) => (err) => err instanceof Type && err.code === code;

const advance = (task, statuses, all) => statuses.reduce((t, s) => transitionTask(t, s, all), task);

describe('createTask', () => {
  it('creates a pending task with dependencies and requirement links', () => {
    const task = createTask(spec('b', ['a'], { requirementIds: ['req-1'] }));
    assert.equal(task.id, 'b');
    assert.equal(task.title, 'Task b');
    assert.equal(task.description, 'Implement b');
    assert.equal(task.status, 'pending');
    assert.deepEqual(task.dependsOn, ['a']);
    assert.deepEqual(task.requirementIds, ['req-1']);
    assert.ok(Object.isFrozen(task));
  });

  it('defaults dependsOn and requirementIds to empty lists', () => {
    const task = createTask({ id: 'a', title: 't', description: 'd' });
    assert.deepEqual(task.dependsOn, []);
    assert.deepEqual(task.requirementIds, []);
  });

  for (const [label, input] of [
    ['missing id', { title: 't', description: 'd' }],
    ['missing title', { id: 'a', description: 'd' }],
    ['blank description', { id: 'a', title: 't', description: '' }],
    ['non-array dependsOn', { id: 'a', title: 't', description: 'd', dependsOn: 'b' }],
    ['non-string dependency', { id: 'a', title: 't', description: 'd', dependsOn: [3] }],
    ['caller-supplied status', { id: 'a', title: 't', description: 'd', status: 'completed' }],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() => createTask(input), ValidationError);
    });
  }

  it('rejects self-dependency', () => {
    assert.throws(() => createTask(spec('a', ['a'])), hasCode(ValidationError, 'SELF_DEPENDENCY'));
  });

  it('rejects duplicate dependency ids', () => {
    assert.throws(() => createTask(spec('a', ['b', 'b'])), hasCode(ValidationError, 'DUPLICATE_ID'));
  });

  it('defensively copies dependency lists', () => {
    const input = spec('b', ['a']);
    const task = createTask(input);
    input.dependsOn.push('c');
    assert.deepEqual(task.dependsOn, ['a']);
  });
});

describe('transitionTask', () => {
  it('follows the happy path pending -> ready -> in_progress -> completed', () => {
    const task = createTask(spec('a'));
    const done = advance(task, ['ready', 'in_progress', 'completed'], [task]);
    assert.equal(done.status, 'completed');
    assert.equal(task.status, 'pending', 'original task is unchanged');
  });

  it('rejects skipping states', () => {
    const task = createTask(spec('a'));
    assert.throws(() => transitionTask(task, 'completed', [task]), InvalidTransitionError);
    assert.throws(() => transitionTask(task, 'in_progress', [task]), InvalidTransitionError);
  });

  it('rejects leaving the completed state', () => {
    const done = advance(createTask(spec('a')), ['ready', 'in_progress', 'completed'], []);
    assert.throws(() => transitionTask(done, 'pending', []), InvalidTransitionError);
  });

  it('allows a failed task to be retried via pending', () => {
    const failed = advance(createTask(spec('a')), ['ready', 'in_progress', 'failed'], []);
    assert.equal(transitionTask(failed, 'pending', []).status, 'pending');
  });

  it('cannot become ready while a dependency is unfinished', () => {
    const a = createTask(spec('a'));
    const b = createTask(spec('b', ['a']));
    const inProgressA = advance(a, ['ready', 'in_progress'], [a]);
    for (const tasks of [[a, b], [inProgressA, b]]) {
      assert.throws(
        () => transitionTask(b, 'ready', tasks),
        (err) => err instanceof InvariantViolationError && err.code === 'DEPENDENCIES_UNFINISHED' &&
          err.details.unfinished.includes('a'),
      );
    }
  });

  it('cannot become ready when a dependency is missing from the collection', () => {
    const b = createTask(spec('b', ['a']));
    assert.throws(() => transitionTask(b, 'ready', [b]), hasCode(InvariantViolationError, 'DEPENDENCIES_UNFINISHED'));
  });

  it('becomes ready once all dependencies are completed', () => {
    const a = advance(createTask(spec('a')), ['ready', 'in_progress', 'completed'], []);
    const b = createTask(spec('b', ['a']));
    assert.equal(transitionTask(b, 'ready', [a, b]).status, 'ready');
  });

  it('requires the task collection to move to ready', () => {
    const a = createTask(spec('a'));
    assert.throws(() => transitionTask(a, 'ready'), ValidationError);
  });
});

describe('assertValidDependencyGraph', () => {
  it('accepts a valid DAG', () => {
    const tasks = [spec('a'), spec('b', ['a']), spec('c', ['a', 'b'])].map(createTask);
    assert.doesNotThrow(() => assertValidDependencyGraph(tasks));
  });

  it('rejects unknown dependencies', () => {
    const tasks = [createTask(spec('b', ['ghost']))];
    assert.throws(() => assertValidDependencyGraph(tasks), hasCode(ValidationError, 'UNKNOWN_DEPENDENCY'));
  });

  it('detects a two-node cycle', () => {
    const tasks = [spec('a', ['b']), spec('b', ['a'])].map(createTask);
    assert.throws(() => assertValidDependencyGraph(tasks), hasCode(ValidationError, 'DEPENDENCY_CYCLE'));
  });

  it('detects a longer cycle and reports its path', () => {
    const tasks = [spec('root'), spec('a', ['root', 'c']), spec('b', ['a']), spec('c', ['b'])].map(createTask);
    assert.throws(
      () => assertValidDependencyGraph(tasks),
      (err) => {
        assert.equal(err.code, 'DEPENDENCY_CYCLE');
        const { cycle } = err.details;
        assert.equal(cycle[0], cycle.at(-1));
        assert.deepEqual(new Set(cycle), new Set(['a', 'b', 'c']));
        return true;
      },
    );
  });
});
