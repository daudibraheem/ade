const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../todo.js');

test('list returns todos in insertion order', () => {
  const store = createStore();
  store.add('first');
  store.add('second');
  assert.deepEqual(store.list().map((t) => t.title), ['first', 'second']);
});

test('mutating the returned list does not change the store', () => {
  const store = createStore();
  store.add('only');
  store.list().push({ id: 99, title: 'intruder', done: false });
  assert.equal(store.list().length, 1);
});
