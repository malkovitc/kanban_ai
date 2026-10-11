type JoinedProject = Record<string, unknown> & { id: string; title: string };

function isJoinedProject(value: unknown): value is JoinedProject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).id === 'string'
    && typeof (value as Record<string, unknown>).title === 'string';
}

/** Supabase may type a many-to-one join as a list; never pick an arbitrary project. */
export function normalizeJoinedProject(value: unknown): JoinedProject | null {
  if (value === null) return null;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new Error('Invalid project join cardinality');
    if (!isJoinedProject(value[0])) throw new Error('Invalid project join');
    return value[0];
  }
  if (!isJoinedProject(value)) throw new Error('Invalid project join');
  return value;
}
