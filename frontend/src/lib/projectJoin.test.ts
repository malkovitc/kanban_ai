import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeJoinedProject } from './projectJoin.ts';

const project = { id: 'project-1', title: 'Board', private: true };

test('normalizes a single authorized project without rewriting fields', () => {
  assert.equal(normalizeJoinedProject(project), project);
  assert.equal(normalizeJoinedProject([project]), project);
  assert.equal(normalizeJoinedProject(null), null);
});

test('rejects ambiguous or malformed project joins without selecting a first row', () => {
  for (const value of [[], [project, project], [null], {}, { id: 'project-1' }, 'project-1']) {
    assert.throws(() => normalizeJoinedProject(value), /Invalid project join/);
  }
});
