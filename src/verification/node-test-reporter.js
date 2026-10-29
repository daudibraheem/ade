/**
 * A Node.js test reporter that ADE attaches to `node --test` checks. It writes
 * one JSON line per finished test, so verification can confirm that tests
 * actually ran instead of trusting the exit code alone.
 *
 * It runs in the test runner's parent process. With the default process
 * isolation, each test file (and the application code it imports) runs in a
 * child process, whose own output cannot add events here.
 */
export default async function* adeTestEvents(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const { name, nesting, file, skip, todo, details } = event.data;
    yield `${JSON.stringify({ event: event.type, name, nesting, file, type: details?.type, skip: Boolean(skip), todo: Boolean(todo) })}\n`;
  }
}
