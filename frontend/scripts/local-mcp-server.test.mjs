import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function parseMcpResponse(text) {
  if (text.trim().startsWith('{')) return JSON.parse(text);
  const data = text.split('\n').find((line) => line.startsWith('data: '));
  if (!data) throw new Error(`MCP response has no data event: ${text.slice(0, 120)}`);
  return JSON.parse(data.slice(6));
}

test('self-hosted MCP is authenticated and reads every sprint without comments', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'kanban-mcp-'));
  const keyFile = path.join(dir, 'key');
  const key = 'test-key-that-is-long-enough-000000000000';
  await writeFile(keyFile, `${key}\n`, { mode: 0o600 });
  const port = 32000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, ['scripts/local-dev-server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      LOCAL_API_HOST: '127.0.0.1',
      LOCAL_API_PORT: String(port),
      LOCAL_DATA_DIR: dir,
      LOCAL_MCP_API_KEY_FILE: keyFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));

  const post = async (body, token = key) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { response, body: await response.text() };
  };

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (response.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const unauthorized = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, 'wrong-key-that-is-also-long-enough-000');
    assert.equal(unauthorized.response.status, 401);

    const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(tools.response.status, 200);
    const toolPayload = parseMcpResponse(tools.body);
    assert.ok(toolPayload.result.tools.some((tool) => tool.name === 'get_board'));

    const create = await post({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'create_project', arguments: { title: 'Local', description: 'Private board', num_sprints: 12 } },
    });
    const createPayload = parseMcpResponse(create.body);
    const created = JSON.parse(createPayload.result.content[0].text);
    const projectId = created.project.id;

    for (const sprint of [1, 2, 12]) {
      const task = await post({
        jsonrpc: '2.0', id: 10 + sprint, method: 'tools/call',
        params: { name: 'create_task', arguments: { project_id: projectId, title: `Sprint ${sprint}`, sprint } },
      });
      assert.equal(task.response.status, 200);
    }

    const board = await post({
      jsonrpc: '2.0', id: 30, method: 'tools/call',
      params: { name: 'get_board', arguments: { project_id: projectId, include_comments: false } },
    });
    const boardPayload = parseMcpResponse(board.body);
    const context = JSON.parse(boardPayload.result.content[0].text);
    assert.equal(typeof context.project.complete, 'boolean');
    assert.equal(typeof context.project.private, 'boolean');
    assert.deepEqual(context.tasks.map((task) => task.sprint), [1, 2, 12]);
    assert.ok(context.tasks.every((task) => !Object.hasOwn(task, 'comments')));
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await exited;
    await rm(dir, { recursive: true, force: true });
  }
}, { timeout: 30_000 });
