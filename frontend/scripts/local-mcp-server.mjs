import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const LOCAL_USER_ID = '00000000-0000-4000-8000-000000000001';
const statuses = ['todo', 'in-progress', 'done'];
const types = ['bug', 'feature', 'scope'];
const priorities = ['low', 'medium', 'high'];

function result(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function assertProjectAccess(db, projectId) {
  const row = db.prepare(
    `SELECT p.id FROM projects p
       JOIN project_collaborators pc ON pc.project_id=p.id
      WHERE p.id=? AND pc.user_id=? AND pc.accepted=1`,
  ).get(projectId, LOCAL_USER_ID);
  if (!row) throw new Error(`Project ${projectId} not found`);
}

function assertTaskAccess(db, taskId) {
  const row = db.prepare(
    `SELECT t.project_id FROM tasks t
       JOIN project_collaborators pc ON pc.project_id=t.project_id
      WHERE t.id=? AND pc.user_id=? AND pc.accepted=1`,
  ).get(taskId, LOCAL_USER_ID);
  if (!row) throw new Error(`Task ${taskId} not found`);
  return row.project_id;
}

function listProjects(db) {
  return db.prepare(
    `SELECT p.* FROM projects p
       JOIN project_collaborators pc ON pc.project_id=p.id
      WHERE pc.user_id=? AND pc.accepted=1
      ORDER BY datetime(COALESCE(p.created_at,'1970-01-01')) ASC`,
  ).all(LOCAL_USER_ID).map((row) => ({
    ...row,
    complete: Boolean(row.complete),
    private: row.private == null ? true : Boolean(row.private),
  }));
}

function listTasks(db, projectId, sprint) {
  assertProjectAccess(db, projectId);
  if (sprint !== undefined) {
    return db.prepare(
      `SELECT * FROM tasks WHERE project_id=? AND sprint=?
       ORDER BY datetime(COALESCE(created_at,'1970-01-01')) ASC`,
    ).all(projectId, sprint);
  }
  return db.prepare(
    `SELECT * FROM tasks WHERE project_id=?
     ORDER BY datetime(COALESCE(created_at,'1970-01-01')) ASC`,
  ).all(projectId);
}

function boardContext(db, projectId, sprint, includeComments) {
  assertProjectAccess(db, projectId);
  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  const tasks = listTasks(db, projectId, sprint);
  if (!includeComments || tasks.length === 0) return { project, tasks };
  const placeholders = tasks.map(() => '?').join(',');
  const comments = db.prepare(
    `SELECT * FROM task_comments WHERE task_id IN (${placeholders})
     ORDER BY datetime(created_at) ASC`,
  ).all(...tasks.map((task) => task.id));
  const grouped = new Map();
  for (const comment of comments) {
    const rows = grouped.get(comment.task_id) ?? [];
    rows.push(comment);
    grouped.set(comment.task_id, rows);
  }
  return {
    project,
    tasks: tasks.map((task) => ({ ...task, comments: grouped.get(task.id) ?? [] })),
  };
}

function createServer(db) {
  const server = new McpServer({ name: 'kanban-ai-sqlite', version: '1.0.0' });

  server.registerTool('list_projects', {
    description: 'List all projects in this self-hosted Kanban AI instance.',
    inputSchema: {},
  }, async () => result({ projects: listProjects(db) }));

  server.registerTool('get_board', {
    description: 'Get project tasks, optionally by sprint or without comments.',
    inputSchema: {
      project_id: z.string().uuid(),
      sprint: z.number().int().min(1).optional(),
      include_comments: z.boolean().optional(),
    },
  }, async ({ project_id, sprint, include_comments }) =>
    result(boardContext(db, project_id, sprint, include_comments ?? true)));

  server.registerTool('create_project', {
    description: 'Create a project.',
    inputSchema: {
      title: z.string().min(1), description: z.string().min(1),
      projectType: z.string().optional(), num_sprints: z.number().int().min(1).max(52).optional(),
      private: z.boolean().optional(), master_plan: z.string().optional(), initial_prompt: z.string().optional(),
      keywords: z.string().optional(), notes: z.string().optional(),
    },
  }, async (input) => {
    const id = randomUUID(); const now = new Date().toISOString();
    const row = {
      id, title: input.title.trim(), description: input.description.trim(),
      master_plan: input.master_plan ?? '', initial_prompt: input.initial_prompt ?? '',
      keywords: input.keywords ?? '', num_sprints: input.num_sprints ?? 10, current_sprint: 1,
      complete: 0, created_at: now, due_date: null, achievements: '', user_id: LOCAL_USER_ID,
      projectType: input.projectType ?? 'Manual', private: input.private === false ? 0 : 1,
      notes: input.notes ?? '',
    };
    db.transaction(() => {
      db.prepare(`INSERT INTO projects
        (id,title,description,master_plan,initial_prompt,keywords,num_sprints,current_sprint,complete,created_at,due_date,achievements,user_id,projectType,private,notes)
        VALUES (@id,@title,@description,@master_plan,@initial_prompt,@keywords,@num_sprints,@current_sprint,@complete,@created_at,@due_date,@achievements,@user_id,@projectType,@private,@notes)`).run(row);
      db.prepare(`INSERT INTO project_collaborators(id,project_id,user_id,role,invited_at,accepted)
        VALUES(?,?,?,?,?,1)`).run(randomUUID(), id, LOCAL_USER_ID, 'owner', now);
    })();
    return result({ success: true, project: { ...row, complete: false, private: Boolean(row.private) } });
  });

  server.registerTool('update_project', {
    description: 'Update project metadata.',
    inputSchema: {
      project_id: z.string().uuid(), title: z.string().optional(), description: z.string().optional(),
      master_plan: z.string().optional(), initial_prompt: z.string().optional(), keywords: z.string().optional(),
      projectType: z.string().optional(), num_sprints: z.number().int().optional(),
      current_sprint: z.number().int().optional(), due_date: z.string().nullable().optional(),
      achievements: z.string().optional(), complete: z.boolean().optional(), private: z.boolean().optional(),
      notes: z.string().optional(),
    },
  }, async ({ project_id, ...patch }) => {
    assertProjectAccess(db, project_id);
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (entries.length) {
      const values = entries.map(([key, value]) => key === 'complete' || key === 'private' ? [key, value ? 1 : 0] : [key, value]);
      db.prepare(`UPDATE projects SET ${values.map(([key]) => `${key}=@${key}`).join(',')} WHERE id=@id`)
        .run(Object.fromEntries([...values, ['id', project_id]]));
    }
    return result({ success: true, project: db.prepare('SELECT * FROM projects WHERE id=?').get(project_id) });
  });

  server.registerTool('delete_project', {
    description: 'Delete a project and its tasks.', inputSchema: { project_id: z.string().uuid() },
  }, async ({ project_id }) => {
    assertProjectAccess(db, project_id);
    db.prepare('DELETE FROM projects WHERE id=?').run(project_id);
    return result({ success: true, project_id });
  });

  server.registerTool('create_task', {
    description: 'Create a task.',
    inputSchema: {
      project_id: z.string().uuid(), title: z.string().min(1), description: z.string().optional(),
      type: z.enum(types).optional(), priority: z.enum(priorities).optional(), status: z.enum(statuses).optional(),
      sprint: z.number().int().min(1).optional(), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
  }, async (input) => {
    assertProjectAccess(db, input.project_id);
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(), project_id: input.project_id, title: input.title.trim(), description: input.description ?? '',
      type: input.type ?? 'feature', priority: input.priority ?? 'medium', status: input.status ?? 'todo',
      sprint: input.sprint ?? 1, due_date: input.due_date ?? now.slice(0, 10), assignee_id: LOCAL_USER_ID,
      created_at: now, updated_at: now,
    };
    db.prepare(`INSERT INTO tasks(id,project_id,title,description,type,priority,status,sprint,due_date,assignee_id,created_at,updated_at)
      VALUES(@id,@project_id,@title,@description,@type,@priority,@status,@sprint,@due_date,@assignee_id,@created_at,@updated_at)`).run(row);
    return result({ success: true, task: row });
  });

  server.registerTool('update_task', {
    description: 'Update a task.',
    inputSchema: {
      task_id: z.string().uuid(), title: z.string().optional(), description: z.string().optional(),
      type: z.enum(types).optional(), priority: z.enum(priorities).optional(), status: z.enum(statuses).optional(),
      sprint: z.number().int().min(1).optional(), due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
  }, async ({ task_id, ...patch }) => {
    assertTaskAccess(db, task_id);
    const values = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (values.length) {
      db.prepare(`UPDATE tasks SET ${values.map(([key]) => `${key}=@${key}`).join(',')},updated_at=@updated_at WHERE id=@id`)
        .run({ ...Object.fromEntries(values), updated_at: new Date().toISOString(), id: task_id });
    }
    return result({ success: true, task: db.prepare('SELECT * FROM tasks WHERE id=?').get(task_id) });
  });

  server.registerTool('delete_task', {
    description: 'Delete a task.', inputSchema: { task_id: z.string().uuid() },
  }, async ({ task_id }) => {
    assertTaskAccess(db, task_id); db.prepare('DELETE FROM tasks WHERE id=?').run(task_id);
    return result({ success: true, task_id });
  });

  server.registerTool('list_task_comments', {
    description: 'List comments on a task.', inputSchema: { task_id: z.string().uuid() },
  }, async ({ task_id }) => {
    assertTaskAccess(db, task_id);
    return result({ comments: db.prepare('SELECT * FROM task_comments WHERE task_id=? ORDER BY datetime(created_at) ASC').all(task_id) });
  });

  server.registerTool('add_task_comment', {
    description: 'Add a comment to a task.',
    inputSchema: { task_id: z.string().uuid(), body: z.string().min(1), author_display_name: z.string().optional() },
  }, async ({ task_id, body, author_display_name }) => {
    assertTaskAccess(db, task_id);
    const row = { id: randomUUID(), task_id, user_id: LOCAL_USER_ID, body: body.trim(), author_display_name: author_display_name ?? 'MCP Agent', created_at: new Date().toISOString() };
    db.prepare(`INSERT INTO task_comments(id,task_id,user_id,body,author_display_name,created_at)
      VALUES(@id,@task_id,@user_id,@body,@author_display_name,@created_at)`).run(row);
    return result({ success: true, comment: row });
  });

  server.registerTool('delete_task_comment', {
    description: 'Delete one of the local owner comments.', inputSchema: { comment_id: z.string().uuid() },
  }, async ({ comment_id }) => {
    const row = db.prepare(`SELECT c.id FROM task_comments c JOIN tasks t ON t.id=c.task_id
      JOIN project_collaborators pc ON pc.project_id=t.project_id
      WHERE c.id=? AND c.user_id=? AND pc.user_id=? AND pc.accepted=1`).get(comment_id, LOCAL_USER_ID, LOCAL_USER_ID);
    if (!row) throw new Error(`Comment ${comment_id} not found`);
    db.prepare('DELETE FROM task_comments WHERE id=?').run(comment_id);
    return result({ success: true, comment_id });
  });
  return server;
}

export async function handleLocalMcpRequest(req, res, body, db) {
  const server = createServer(db);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } finally {
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
  }
}
