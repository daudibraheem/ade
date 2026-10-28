/** Small input-validation helpers shared by the domain modules. */
import { ValidationError } from './errors.js';

export function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function requireObject(value, label) {
  if (!isPlainObject(value)) {
    throw new ValidationError(`${label} must be a plain object.`, {
      code: 'INVALID_INPUT',
      details: { field: label },
    });
  }
}

export function requireNonEmptyString(value, field, entity) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${entity} "${field}" must be a non-empty string.`, {
      code: 'INVALID_FIELD',
      details: { entity, field, received: describe(value) },
    });
  }
  return value.trim();
}

export function optionalNonEmptyString(value, field, entity) {
  if (value === undefined) return undefined;
  return requireNonEmptyString(value, field, entity);
}

/** Validates an optional array of non-empty strings and returns a trimmed copy. */
export function stringList(value, field, entity) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ValidationError(`${entity} "${field}" must be an array of strings.`, {
      code: 'INVALID_FIELD',
      details: { entity, field, received: describe(value) },
    });
  }
  return value.map((item, i) => requireNonEmptyString(item, `${field}[${i}]`, entity));
}

/** Rejects keys outside `allowed` so typos are not silently ignored. */
export function rejectUnknownKeys(input, allowed, entity) {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new ValidationError(
      `${entity} has unknown field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`,
      { code: 'UNKNOWN_FIELD', details: { entity, unknown } },
    );
  }
}

/** Throws if any value in `ids` appears more than once. */
export function assertUniqueIds(ids, entity) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new ValidationError(`Duplicate ${entity} id "${id}".`, {
        code: 'DUPLICATE_ID',
        details: { entity, id },
      });
    }
    seen.add(id);
  }
}

export function toTimestamp(now) {
  const date = now === undefined ? new Date() : new Date(now);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`Invalid timestamp: ${describe(now)}.`, {
      code: 'INVALID_TIMESTAMP',
      details: { received: describe(now) },
    });
  }
  return date.toISOString();
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return JSON.stringify(value);
  return typeof value;
}
