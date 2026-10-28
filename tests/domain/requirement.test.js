import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEvidence,
  createRequirement,
  recordEvidence,
  transitionRequirement,
} from '../../src/domain/requirement.js';
import { InvalidTransitionError, InvariantViolationError, ValidationError } from '../../src/domain/errors.js';

const validInput = () => ({
  id: 'req-login',
  description: 'Users can log in with email and password',
  acceptanceCriteria: ['Valid credentials redirect to dashboard'],
});

const hasCode = (Type, code) => (err) => err instanceof Type && err.code === code;

describe('createRequirement', () => {
  it('creates a pending, required requirement with no evidence', () => {
    const req = createRequirement(validInput());
    assert.equal(req.id, 'req-login');
    assert.equal(req.description, 'Users can log in with email and password');
    assert.deepEqual(req.acceptanceCriteria, ['Valid credentials redirect to dashboard']);
    assert.equal(req.status, 'pending');
    assert.equal(req.required, true);
    assert.deepEqual(req.evidence, []);
    assert.ok(Object.isFrozen(req));
  });

  it('accepts optional requirements and omitted acceptance criteria', () => {
    const req = createRequirement({ id: 'r', description: 'd', required: false });
    assert.equal(req.required, false);
    assert.deepEqual(req.acceptanceCriteria, []);
  });

  it('rejects a caller-supplied status (cannot be created verified)', () => {
    assert.throws(
      () => createRequirement({ ...validInput(), status: 'verified' }),
      hasCode(ValidationError, 'UNKNOWN_FIELD'),
    );
  });

  for (const [label, patch, field] of [
    ['missing id', { id: undefined }, 'id'],
    ['blank id', { id: '   ' }, 'id'],
    ['numeric id', { id: 7 }, 'id'],
    ['missing description', { description: undefined }, 'description'],
    ['non-array acceptance criteria', { acceptanceCriteria: 'x' }, 'acceptanceCriteria'],
    ['blank acceptance criterion', { acceptanceCriteria: ['ok', ''] }, 'acceptanceCriteria[1]'],
    ['non-boolean required', { required: 'yes' }, 'required'],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(
        () => createRequirement({ ...validInput(), ...patch }),
        (err) => err instanceof ValidationError && err.message.includes(field),
      );
    });
  }

  it('rejects non-object input', () => {
    assert.throws(() => createRequirement(null), ValidationError);
    assert.throws(() => createRequirement('req'), ValidationError);
  });

  it('defensively copies acceptance criteria', () => {
    const input = validInput();
    const req = createRequirement(input);
    input.acceptanceCriteria.push('mutated');
    assert.equal(req.acceptanceCriteria.length, 1);
    assert.throws(() => req.acceptanceCriteria.push('x'), TypeError);
  });
});

describe('createEvidence', () => {
  it('records a check identifier and boolean result', () => {
    const ev = createEvidence({ checkId: 'e2e:login', passed: true, summary: 'redirected' });
    assert.deepEqual(ev, { checkId: 'e2e:login', passed: true, summary: 'redirected' });
    assert.ok(Object.isFrozen(ev));
  });

  for (const [label, input] of [
    ['missing checkId', { passed: true }],
    ['blank checkId', { checkId: ' ', passed: true }],
    ['missing passed', { checkId: 'c' }],
    ['string passed', { checkId: 'c', passed: 'true' }],
    ['numeric passed', { checkId: 'c', passed: 1 }],
    ['unknown field', { checkId: 'c', passed: true, verified: true }],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() => createEvidence(input), ValidationError);
    });
  }
});

describe('requirement verification', () => {
  it('records evidence without changing status', () => {
    const req = createRequirement(validInput());
    const next = recordEvidence(req, { checkId: 'c1', passed: true });
    assert.equal(next.status, 'pending');
    assert.deepEqual(next.evidence, [{ checkId: 'c1', passed: true }]);
    assert.deepEqual(req.evidence, [], 'original is unchanged');
  });

  it('marks verified when every check most recently passed', () => {
    let req = createRequirement(validInput());
    req = recordEvidence(req, { checkId: 'c1', passed: false });
    req = recordEvidence(req, { checkId: 'c1', passed: true });
    req = recordEvidence(req, { checkId: 'c2', passed: true });
    assert.equal(transitionRequirement(req, 'verified').status, 'verified');
  });

  it('refuses to verify without any evidence', () => {
    const req = createRequirement(validInput());
    assert.throws(() => transitionRequirement(req, 'verified'), hasCode(InvariantViolationError, 'MISSING_EVIDENCE'));
  });

  it('refuses to verify when any check most recently failed', () => {
    let req = createRequirement(validInput());
    req = recordEvidence(req, { checkId: 'c1', passed: true });
    req = recordEvidence(req, { checkId: 'c2', passed: false });
    assert.throws(
      () => transitionRequirement(req, 'verified'),
      (err) => err.code === 'FAILING_EVIDENCE' && err.details.failingChecks.includes('c2'),
    );
  });

  it('refuses to verify when a passed check was later re-run and failed', () => {
    let req = createRequirement(validInput());
    req = recordEvidence(req, { checkId: 'c1', passed: true });
    req = recordEvidence(req, { checkId: 'c1', passed: false });
    assert.throws(() => transitionRequirement(req, 'verified'), hasCode(InvariantViolationError, 'FAILING_EVIDENCE'));
  });

  it('marks failed only with evidence of a failing check', () => {
    const req = createRequirement(validInput());
    assert.throws(() => transitionRequirement(req, 'failed'), hasCode(InvariantViolationError, 'MISSING_EVIDENCE'));
    const passing = recordEvidence(req, { checkId: 'c1', passed: true });
    assert.throws(() => transitionRequirement(passing, 'failed'), InvariantViolationError);
    const failing = recordEvidence(req, { checkId: 'c1', passed: false });
    assert.equal(transitionRequirement(failing, 'failed').status, 'failed');
  });

  it('can be marked unverified without evidence', () => {
    const req = createRequirement(validInput());
    assert.equal(transitionRequirement(req, 'unverified').status, 'unverified');
  });

  it('cannot go directly from failed to verified; reset to pending clears stale evidence', () => {
    let req = recordEvidence(createRequirement(validInput()), { checkId: 'c1', passed: false });
    req = transitionRequirement(req, 'failed');
    assert.throws(() => transitionRequirement(req, 'verified'), InvalidTransitionError);
    req = transitionRequirement(req, 'pending');
    assert.deepEqual(req.evidence, []);
    assert.throws(() => transitionRequirement(req, 'verified'), hasCode(InvariantViolationError, 'MISSING_EVIDENCE'));
  });

  it('does not accept evidence once a verdict has been reached', () => {
    let req = recordEvidence(createRequirement(validInput()), { checkId: 'c1', passed: true });
    req = transitionRequirement(req, 'verified');
    assert.throws(
      () => recordEvidence(req, { checkId: 'c2', passed: false }),
      hasCode(InvariantViolationError, 'EVIDENCE_NOT_ACCEPTED'),
    );
  });

  it('cannot be marked verified by mutating the status field', () => {
    const req = createRequirement(validInput());
    assert.throws(() => {
      req.status = 'verified';
    }, TypeError);
    assert.equal(req.status, 'pending');
  });

  it('leaves the requirement unchanged when an operation fails', () => {
    const req = recordEvidence(createRequirement(validInput()), { checkId: 'c1', passed: false });
    const snapshot = structuredClone(req);
    assert.throws(() => transitionRequirement(req, 'verified'));
    assert.throws(() => recordEvidence(req, { checkId: '', passed: true }));
    assert.deepEqual(req, snapshot);
  });
});
