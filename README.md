# ADE — Application Delivery Engine

ADE is intended to deliver applications using coding agents **and independently
verify that the requested functionality actually works**. A coding agent saying
a feature is done is not treated as evidence that it works: ADE separates
implementation, verification, failure, and successful delivery.

## Current status: Step 1 — domain model only

This milestone provides the core data structures and deterministic rules that
the rest of ADE will build on. **It does not run agents, execute checks, or
deliver applications.** Nothing here works end to end yet.

Implemented:

- **Delivery run**: one attempt to fulfil a user request. It holds an ID, the
  original request, a lifecycle status, requirements, tasks, and timestamps.
- **Requirement**: a behaviour the application must exhibit. It has a
  verification status and a record of verification evidence.
- **Task**: a unit of implementation work, with dependencies on other tasks
  and optional links to requirements.
- **Lifecycle tables**: explicit allowed transitions for runs, tasks and
  requirements, plus the guards described below.

## Lifecycle rules

### Run

```
created ──► planning ──► executing ──► verifying ──► completed
                                         │  ▲
                                         ▼  │
                                       repairing
Any non-terminal status ──► failed | blocked
blocked ──► (the status it was blocked from) | failed
```

- `completed` is only reachable from `verifying`, never straight from
  implementation.
- Completion requires at least one requirement, **every required requirement
  `verified`**, and every task `completed`. `completionBlockers(run)` lists
  what is missing.
- `planning → executing` requires at least one requirement and one task.
- `completed` and `failed` are terminal.

### Task

```
pending ──► ready ──► in_progress ──► completed
   ▲  │        │          │
   │  ▼        ▼          ▼
   └ blocked ◄─┴──────── failed ──► pending (retry)
```

- A task can only become `ready` when all of its dependencies are `completed`.
- Self-dependencies, duplicate dependencies, unknown dependencies and
  dependency cycles are rejected.

### Requirement

```
pending ──► verified | failed | unverified
verified | failed | unverified ──► pending   (clears evidence)
```

- Evidence is `{ checkId, passed, summary? }`. `checkId` must be a non-empty
  string and `passed` must be a boolean. Unknown fields are rejected.
- **verified** requires at least one recorded check, and the most recent
  result of every check must have passed.
- **failed** requires the most recent result of at least one check to have
  failed.
- **unverified** means verification could not be carried out. It does not
  satisfy completion.
- Evidence can only be added while a requirement is `pending`. Resetting to
  `pending` discards old evidence so stale results cannot carry over.

These evidence rules are deliberately minimal. Having passing evidence does
**not** prove a requirement is correct; a future verification engine will
decide which checks each requirement needs.

### Run-phase restrictions

| Operation                                        | Allowed while run is            |
| ------------------------------------------------ | ------------------------------- |
| Add requirements                                 | created, planning               |
| Add tasks                                        | created, planning, repairing    |
| Change task status                               | executing, repairing            |
| Record evidence / mark verified, failed, unverified | verifying                    |
| Reset requirement to pending                     | verifying, repairing            |

## Design

- **Immutable values.** Every object is frozen. Operations return a new
  object and never change their input. A rejected operation throws before
  anything is built, so it can never leave state half-updated.
- **The run builds its own children.** `createDeliveryRun`, `addRequirement`
  and `addTask` take plain input specs, so a requirement cannot be injected
  already `verified`.
- **Typed errors with stable codes.** These are `ValidationError`,
  `InvalidTransitionError` and `InvariantViolationError`, all subclasses of
  `DomainError`. Each has a `code` (e.g. `DEPENDENCY_CYCLE`,
  `COMPLETION_BLOCKED`) and a `details` object.
- **Deterministic.** IDs and timestamps can be passed in (`id`,
  `{ now }`). They default to `crypto.randomUUID()` and the current time.
- **No runtime dependencies.**

## Project structure

```
src/domain/
  errors.js             Domain error types
  state-transitions.js  Status constants and allowed-transition tables
  requirement.js        Requirements and verification evidence
  task.js               Tasks, dependency-aware transitions, cycle detection
  delivery-run.js       Delivery run aggregate and delivery rules
  validation.js         Shared input-validation helpers
  index.js              Public exports
tests/domain/           node:test suites, one per module
```

## Usage sketch

```js
import { createDeliveryRun, transitionRun } from './src/domain/index.js';

let run = createDeliveryRun({
  request: 'Build a todo app',
  requirements: [{ id: 'req-add', description: 'Users can add a todo' }],
  tasks: [{ id: 'ui', title: 'Todo UI', description: 'Form and list', requirementIds: ['req-add'] }],
});
run = transitionRun(run, 'planning');
```

## Running tests

Requires Node.js 22 or later.

```sh
npm test
```

This runs `node --test "tests/**/*.test.js"` using the built-in test runner.

## Not implemented yet

- Coding-agent integration and task execution
- Task scheduling and parallel execution
- The verification engine (deciding and running the checks each requirement needs)
- Rich evidence (timestamps, commands, exit codes, logs, application revision)
- Persistence, APIs, CLI or UI
