/**
 * Domain errors. Each carries a stable `code` so callers can branch on the
 * kind of failure without parsing messages, plus optional structured `details`.
 */

export class DomainError extends Error {
  constructor(message, { code = 'DOMAIN_ERROR', details = {} } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
}

/** Input is missing, malformed, or references something that does not exist. */
export class ValidationError extends DomainError {
  constructor(message, { code = 'VALIDATION_ERROR', details } = {}) {
    super(message, { code, details });
  }
}

/** A status change is not permitted by the lifecycle table. */
export class InvalidTransitionError extends DomainError {
  constructor(message, { code = 'INVALID_TRANSITION', details } = {}) {
    super(message, { code, details });
  }
}

/**
 * The transition is permitted in principle, but a domain rule blocks it
 * right now (e.g. completing a run with unverified requirements).
 */
export class InvariantViolationError extends DomainError {
  constructor(message, { code = 'INVARIANT_VIOLATION', details } = {}) {
    super(message, { code, details });
  }
}
