import { expect, test } from 'bun:test';
test('real Worker cache RPC persists SQLite and recovers failed refreshes', async () => {
  const process = Bun.spawn(['node', 'tests/fixtures/library-worker-smoke.mjs'], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
  expect(stdout).toContain('user isolation: PASS');
}, 30_000);
