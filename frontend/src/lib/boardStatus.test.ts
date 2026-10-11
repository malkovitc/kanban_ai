import assert from 'node:assert/strict';
import test from 'node:test';
import { BOARD_COLUMNS, boardColumnForStatus, groupTasksByBoardColumn, originalStatusLabel } from './boardStatus.ts';

const statuses = ['planning', 'todo', 'in-progress', 'blocked', 'done', 'archived'] as const;

test('every canonical status has exactly one board column', () => {
  assert.deepEqual(BOARD_COLUMNS.map((column) => column.id), statuses);
  for (const status of statuses) assert.equal(boardColumnForStatus(status), status);
});

test('legacy statuses remain visible without changing persisted values', () => {
  assert.equal(boardColumnForStatus('waiting'), 'blocked');
  assert.equal(boardColumnForStatus('in_progress'), 'in-progress');
  assert.equal(originalStatusLabel('waiting'), 'Waiting (legacy)');
  assert.equal(originalStatusLabel('in_progress'), 'In progress (legacy)');
});

test('unexpected statuses are diagnosed, not silently dropped or called done', () => {
  for (const status of ['', 'cancelled', 'DONE']) {
    assert.equal(boardColumnForStatus(status), 'unrecognized');
  }
});

test('every loaded task appears in exactly one column without rewriting its status', () => {
  const tasks = [...statuses, 'waiting', 'in_progress', 'unknown'].map((status, id) => ({ id, status }));
  const grouped = groupTasksByBoardColumn(tasks);
  assert.deepEqual(Object.values(grouped).flat().map((task) => task.id).sort(), tasks.map((task) => task.id).sort());
  assert.equal(grouped.blocked[1].status, 'waiting');
  assert.equal(grouped['in-progress'][1].status, 'in_progress');
  assert.equal(grouped.unrecognized[0].status, 'unknown');
});
