# ADE — Application Delivery Engine

ADE is intended to deliver applications using coding agents **and independently
verify that the requested functionality actually works**. A coding agent saying
a feature is done is not treated as evidence that it works: ADE separates
implementation, verification, failure, and successful delivery.

## Current status: MVP workflow

ADE can now run one delivery end to end, from a plain-English request to an evidence-backed report:

0. **Plan** (`ade plan "<request>"`): Claude Code, with every tool disabled, drafts
   requirements, acceptance criteria, tasks, proposed checks and proposed acceptance
   tests, plus assumptions and open questions. The draft is validated against the
   delivery schema and saved as `draft.json` + `proposed-tests/`. It is **not approved**.
   `ade deliver` refuses drafts.
1. **Approve** (`ade approve <draft.json>`): an explicit human step after reviewing the
   draft. It refuses while open questions remain. It writes `spec.json` with the SHA-256
   of each acceptance test file exactly as approved, including any edits made during review.
2. **Execute tasks** through a coding agent: Claude Code in headless mode with
   file tools only (no Bash). The agent can write code but cannot run anything.
3. **Verify independently.** ADE runs the approved checks itself, with controls
   (no shell, confined working directory, minimal environment, timeout that
   kills the process group, capped output).
4. **Capture evidence.** Each check result records command, arguments, cwd,
   start/finish times, duration, exit code or signal, timeout, start errors and output.
5. **Repair within a limit.** Real failure output goes back to the agent, then
   every check is re-run. The run fails when the limit is reached.
6. **Report.** `report.md` / `report.json` are built only from recorded results.
   What the agent said appears in a separate "Agent claims (not evidence)" section.

Not yet implemented: persistence beyond the evidence files, sandboxed execution, UI.

## Quick start

```sh
npm test                                            # 209 tests, no network or live model

# Full workflow (needs Claude Code logged in):
node bin/ade.js plan "A Node.js word-count module: count words, word frequencies ignoring case and punctuation, top N words" --out ade-drafts/word-count
#   review ade-drafts/word-count/draft.json and proposed-tests/, edit if needed
node bin/ade.js approve ade-drafts/word-count/draft.json
node bin/ade.js deliver ade-drafts/word-count/spec.json

# Or deliver the hand-written example:
node bin/ade.js deliver examples/todo-lib/spec.json
```

`plan` refuses to overwrite an existing draft; `approve` refuses to overwrite an existing spec.
Exit codes: 0 success or delivered, 1 not delivered, 2 usage, spec or planning error. Evidence is
written to `examples/todo-lib/.ade-runs/<run-id>/` (`report.md`, `report.json`,
`run.json`, `results/<result-id>.json`).

### Spec format

```json
{
  "request": "What the user asked for",
  "workspace": "./workspace",
  "maxRepairAttempts": 2,
  "requirements": [{ "id": "FR1", "description": "...", "acceptanceCriteria": ["..."], "checkIds": ["acceptance-add"] }],
  "tasks": [{ "id": "T1", "title": "...", "description": "...", "requirementIds": ["FR1"] }],
  "checks": [{ "id": "acceptance-add", "command": "node", "args": ["--test", "acceptance/add.test.js"],
               "timeoutMs": 30000, "requirementIds": ["FR1"] }],
  "protectedFiles": [{ "from": "approved/add.test.js", "to": "acceptance/add.test.js",
                      "sha256": "<sha256 of approved/add.test.js>" }]
}
```

- Every check must name the requirements it verifies, and every `checkIds`
  entry must exist and point back. The spec is rejected before anything runs.
- `protectedFiles` are approved acceptance tests, each with its approved `sha256`
  (required). See "Approval integrity" below.

### Approval integrity

Checks only ever run against the exact acceptance tests that were approved:

| When | What ADE checks | On failure |
|---|---|---|
| Before implementation | every `from` file matches its approved `sha256` | run fails, `APPROVED_SOURCE_CHANGED`; the agent never starts |
| Before implementation | the copies placed in the workspace match | run fails |
| Before every verification round | the `from` files still match | run fails, `APPROVED_SOURCE_CHANGED` |
| Before every verification round | each directory holding approved tests (e.g. `acceptance/`) contains exactly the approved files, unchanged, as regular files | run fails, `WORKSPACE_TESTS_ALTERED`: lists each file as `changed`, `missing` or `unexpected` |

Tests are placed once, before implementation. ADE never silently restores
them: if the coding agent (including a repair session) changes, deletes, adds
or symlinks a file in an acceptance directory, or the approved files change,
no further checks run. The report's "Integrity failure" section names each
file, with its approved and actual hashes. The workspace root is never a closed
directory: a test placed there is hash-checked, but other root files are allowed.

To fix an integrity failure, restore the approved file. If the change is
intended, review it and run `ade approve` again (it refuses to overwrite
`spec.json`, so move the old one aside first). For a hand-written spec, add each
file's `sha256sum` output after reviewing it.

### Verification levels

ADE keeps four questions separate:

| Question | Answered by | Values |
|---|---|---|
| Did the command execute? | `execution.status` | `completed`, `timed_out`, `could_not_start` |
| Did the check pass? | `result.outcome` | `passed` (expected exit code), `failed` (other code or timeout), `error` (could not run) |
| Is the requirement verified? | requirement verdict | `verified` only if every relevant check passed; any failure gives `failed`; a missing or errored result gives `unverified` |
| Is the app deliverable? | domain `completionBlockers` | every required requirement `verified`, every task `completed` |

## Development methodology: AWS AI-DLC

ADE itself is developed with [AWS AI-DLC](https://github.com/awslabs/aidlc-workflows)
(MIT-0) in Claude Code. It is a development tool only and is not part of ADE's runtime.
The version is pinned in `.aidlc-version` (2.11.2).

- **Committed:** `.aidlc-version`, and the shared workflow records under `aidlc/spaces/`
  (memory, and later intents, state and audit).
- **Not committed:** `.claude/`. It is AI-DLC's generated Claude Code harness (framework
  files, hooks, agents and skills) and is rebuilt exactly from the pinned version. AI-DLC's
  local state (`aidlc/.aidlc-sessions/`, `aidlc/active-*`, clone id) is ignored by its own
  `.gitignore` block.

Setup after cloning ([AI-DLC install guide](https://github.com/awslabs/aidlc-workflows/blob/v2.11.2/docs/guide/18-install-and-lifecycle.md)):

```sh
# install the pinned release (download and inspect install.sh from the v2.11.2 release first)
sh install.sh --version "$(cat .aidlc-version)"
aidlc config --harness claude    # regenerates .claude/
aidlc doctor
```

Then start Claude Code in this folder and run `/aidlc --doctor`, then `/aidlc <work description>`.

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
- Each move from `verifying` to `repairing` uses one repair attempt. When
  `maxRepairAttempts` (default 2) is used up, the move is refused with
  `REPAIR_LIMIT_REACHED`. Resuming a blocked repair does not count.

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

- Evidence is `{ checkId, passed, summary?, resultId? }`. `resultId` points to the full check result. `checkId` must be a non-empty
  string and `passed` must be a boolean. Unknown fields are rejected.
- **verified** requires at least one recorded check, a result for every
  check the requirement declares in `checkIds`, and the most recent result of
  every check must have passed.
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
bin/ade.js              CLI: ade deliver <spec.json>
src/domain/             Step 1 domain model (runs, requirements, tasks, rules)
src/verification/
  check.js              Check definitions and requirement/check traceability
  runner.js             Controlled command execution
  verify.js             Check outcomes, requirement verdicts, applying results to a run
src/agent/claude-code.js  Claude Code adapter: implement (file tools only), plan (no tools)
src/planner/plan.js     Draft spec generation, validation, writing and approval
src/controller/
  spec.js               Spec loading and validation
  delivery.js           Delivery controller: execute, verify, repair, decide
src/report/report.js    Evidence files and delivery report
examples/todo-lib/      Example spec with approved acceptance tests
tests/                  node:test suites
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

## Known limitations

- **Not a sandbox.** Checks run as the current user with full filesystem and
  network access, and they execute code the agent wrote. Use a disposable
  machine or container for untrusted requests.
- A passing check proves only what it tests. The quality of acceptance tests
  limits the quality of verification.
- The agent can only write inside its workspace through Claude Code's own
  `acceptEdits` permission scope. ADE does not add its own file-access controls.
- Runs are not resumable; evidence is written once the run ends.
- Planning quality depends on the model. Proposed tests can be wrong or weak;
  approval means a person has read them.
- `spec.json` is the approval record. ADE detects changes to the test files, but
  not edits to `spec.json` itself (for example a replaced hash).
- Planner-generated apps target Node.js, with `node --test` acceptance tests.
