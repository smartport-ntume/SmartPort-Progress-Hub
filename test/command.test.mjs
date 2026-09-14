import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../local-server/command.mjs';

test('command input crosses stdin intact beyond Windows argument limits, including Chinese and shell syntax', async () => {
  const input = '中文週報證據\n"quoted" `literal` $(literal) & | <>\n'.repeat(2000);
  const result = await runCommand(process.execPath, ['-e',
    "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input,args:process.argv.slice(1)})));"
  ], { input, timeoutMs: 5000 });
  assert.deepEqual(JSON.parse(result.stdout), { input, args: [] });
});

test('a child closing stdin early fails cleanly without exposing the prompt', async () => {
  await assert.rejects(() => runCommand(process.execPath, ['-e', 'process.exit(2)'], {
    input: 'private-report-content'.repeat(500000), timeoutMs: 5000
  }), error => error.name === 'CommandError' && !error.message.includes('private-report-content'));
});

test('a missing command with input reports a launch failure', async () => {
  await assert.rejects(() => runCommand('smartport-nonexistent-codex-test-command', [], {
    input: 'private-report-content', timeoutMs: 5000
  }), error => error.name === 'CommandError' && error.code === 'ENOENT');
});
