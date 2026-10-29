import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checksForRequirement, createCheck, createCheckSuite } from '../../src/verification/check.js';
import { createRequirement } from '../../src/domain/requirement.js';
import { ValidationError } from '../../src/domain/errors.js';

const hasCode = (Type, code) => (err) => err instanceof Type && err.code === code;

const spec = (overrides = {}) => ({
  id: 'unit',
  command: 'npm',
  args: ['test'],
  requirementIds: ['req-add'],
  ...overrides,
});

describe('createCheck', () => {
  it('applies safe defaults and freezes the check', () => {
    const check = createCheck(spec());
    assert.equal(check.cwd, '.');
    assert.equal(check.timeoutMs, 60_000);
    assert.equal(check.expectExitCode, 0);
    assert.deepEqual(check.args, ['test']);
    assert.ok(Object.isFrozen(check) && Object.isFrozen(check.args));
  });

  it('requires at least one requirement so every check is traceable', () => {
    assert.throws(() => createCheck(spec({ requirementIds: [] })), hasCode(ValidationError, 'INVALID_FIELD'));
  });

  for (const cwd of ['/etc', '..', '../other', 'a/../../b']) {
    it(`rejects cwd ${JSON.stringify(cwd)} outside the workspace`, () => {
      assert.throws(() => createCheck(spec({ cwd })), hasCode(ValidationError, 'UNSAFE_PATH'));
    });
  }

  it('accepts a nested relative cwd', () => {
    assert.equal(createCheck(spec({ cwd: './app/../app/web' })).cwd, 'app/web');
  });

  for (const [label, overrides] of [
    ['a zero timeout', { timeoutMs: 0 }],
    ['an excessive timeout', { timeoutMs: 31 * 60_000 }],
    ['a non-integer exit code', { expectExitCode: 1.5 }],
    ['non-string args', { args: [1] }],
    ['an empty command', { command: ' ' }],
    ['unknown fields', { shell: true }],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() => createCheck(spec(overrides)), ValidationError);
    });
  }
});

describe('createCheckSuite', () => {
  const reqs = () => [
    createRequirement({ id: 'req-add', description: 'Add', checkIds: ['unit'] }),
    createRequirement({ id: 'req-list', description: 'List' }),
  ];

  it('builds a suite and maps checks to requirements', () => {
    const suite = createCheckSuite([spec(), spec({ id: 'e2e', requirementIds: ['req-add', 'req-list'] })], reqs());
    assert.deepEqual(checksForRequirement(suite, reqs()[0]).map((c) => c.id), ['unit', 'e2e']);
    assert.deepEqual(checksForRequirement(suite, reqs()[1]).map((c) => c.id), ['e2e']);
  });

  it('rejects duplicate check ids', () => {
    assert.throws(() => createCheckSuite([spec(), spec()], reqs()), hasCode(ValidationError, 'DUPLICATE_ID'));
  });

  it('rejects a check for an unknown requirement', () => {
    assert.throws(
      () => createCheckSuite([spec({ requirementIds: ['req-nope'] })], reqs()),
      hasCode(ValidationError, 'UNKNOWN_REQUIREMENT'),
    );
  });

  it('rejects a requirement that declares a missing check', () => {
    assert.throws(() => createCheckSuite([], reqs()), hasCode(ValidationError, 'UNKNOWN_CHECK'));
  });

  it('rejects a declared check that does not point back at the requirement', () => {
    assert.throws(
      () => createCheckSuite([spec({ requirementIds: ['req-list'] })], reqs()),
      hasCode(ValidationError, 'TRACEABILITY_MISMATCH'),
    );
  });
});
