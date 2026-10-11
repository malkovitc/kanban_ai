import type { Status } from '../types';

export type BoardColumnId = 'planning' | 'todo' | 'in-progress' | 'blocked' | 'done' | 'archived' | 'unrecognized';

export const BOARD_COLUMNS: ReadonlyArray<{ id: Exclude<BoardColumnId, 'unrecognized'>; title: string }> = [
  { id: 'planning', title: 'Planning' },
  { id: 'todo', title: 'To do' },
  { id: 'in-progress', title: 'In progress' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'done', title: 'Done' },
  { id: 'archived', title: 'Archived' },
];

export function boardColumnForStatus(status: string): BoardColumnId {
  switch (status) {
    case 'planning':
    case 'todo':
    case 'in-progress':
    case 'blocked':
    case 'done':
    case 'archived':
      return status;
    case 'waiting':
      return 'blocked';
    case 'in_progress':
      return 'in-progress';
    default:
      return 'unrecognized';
  }
}

export function groupTasksByBoardColumn<T extends { status: string }>(tasks: readonly T[]): Record<BoardColumnId, T[]> {
  const columns: Record<BoardColumnId, T[]> = {
    planning: [],
    todo: [],
    'in-progress': [],
    blocked: [],
    done: [],
    archived: [],
    unrecognized: [],
  };
  for (const task of tasks) columns[boardColumnForStatus(task.status)].push(task);
  return columns;
}

export function originalStatusLabel(status: Status): string {
  if (status === 'waiting') return 'Waiting (legacy)';
  if (status === 'in_progress') return 'In progress (legacy)';
  return 'Unrecognized (review)';
}
