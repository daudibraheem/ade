const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../todo.js');

test('add returns a new open todo with a numeric id', () => {
  const todo = createStore().add('Buy milk');
  assert.equal(todo.title, 'Buy milk');
  assert.equal(todo.done, false);
  assert.equal(typeof todo.id, 'number');
});

test('ids are unique', () => {
  const store = createStore();
  assert.notEqual(store.add('a').id, store.add('b').id);
});

test('empty titles are rejected', () => {
  const store = createStore();
  assert.throws(() => store.add(''), Error);
  assert.throws(() => store.add('   '), Error);
});
