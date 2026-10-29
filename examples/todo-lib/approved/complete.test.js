const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../todo.js');

test('complete marks a todo done', () => {
  const store = createStore();
  const { id } = store.add('Walk dog');
  assert.equal(store.complete(id).done, true);
  assert.equal(store.list()[0].done, true);
});

test('complete rejects unknown ids', () => {
  assert.throws(() => createStore().complete(12345), Error);
});
