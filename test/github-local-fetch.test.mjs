import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalGitHubFetch,
  LOCAL_READ_TOKEN,
  LOCAL_WRITE_TOKEN
} from '../local-server/github-local-fetch.mjs';

function fixture() {
  const calls = [];
  const store = {
    fullName: 'example/private-project',
    branch: 'main',
    async readBuffer(file) { calls.push(['read', file]); return Buffer.from('{"ok":true}\n'); },
    async blobSha(file) { calls.push(['sha', file]); return 'abc123'; },
    async writeBuffer(file, buffer, options) {
      calls.push(['write', file, buffer.toString(), options]);
      return { changed: true, sha: 'def456', commitSha: 'commit789' };
    }
  };
  let nativeCalls = 0;
  const nativeFetch = async () => {
    nativeCalls += 1;
    return new Response('{"login":"vincent"}', { status: 200 });
  };
  return {
    calls,
    store,
    fetch: createLocalGitHubFetch({ nativeFetch, store }),
    nativeCalls: () => nativeCalls
  };
}

test('local GitHub adapter serves repository contents from Git', async () => {
  const context = fixture();
  const response = await context.fetch(
    'https://api.github.com/repos/example/private-project/contents/project/sample.json',
    { headers: { Authorization: 'Bearer ' + LOCAL_READ_TOKEN } }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(Buffer.from(body.content, 'base64').toString(), '{"ok":true}\n');
  assert.deepEqual(context.calls, [['read', 'project/sample.json'], ['sha', 'project/sample.json']]);
});

test('local GitHub adapter protects read-only writes and accepts managed writes', async () => {
  const context = fixture();
  const url = 'https://api.github.com/repos/example/private-project/contents/project/sample.json';
  const payload = JSON.stringify({
    content: Buffer.from('{"version":2}\n').toString('base64'),
    sha: 'abc123',
    message: 'Update sample'
  });

  const denied = await context.fetch(url, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + LOCAL_READ_TOKEN }, body: payload
  });
  assert.equal(denied.status, 403);

  const accepted = await context.fetch(url, {
    method: 'PUT', headers: { Authorization: 'Bearer ' + LOCAL_WRITE_TOKEN }, body: payload
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).commit.sha, 'commit789');
  assert.equal(context.calls[0][0], 'write');
  assert.equal(context.calls[0][3].expectedSha, 'abc123');
});

test('local GitHub adapter leaves account APIs on native GitHub fetch', async () => {
  const context = fixture();
  const response = await context.fetch('https://api.github.com/user', {
    headers: { Authorization: 'Bearer real-user-token' }
  });
  assert.equal(response.status, 200);
  assert.equal(context.nativeCalls(), 1);
});

test('managed agent token gets local repository writes but native Issues API access', async () => {
  const calls = [];
  const store = {
    fullName: 'example/private-project',
    branch: 'main',
    async readBuffer() { return Buffer.from('{}'); },
    async blobSha() { return 'abc'; },
    async writeBuffer(file) {
      calls.push(['write', file]);
      return { changed: true, sha: 'def', commitSha: 'commit' };
    }
  };
  let nativeCalls = 0;
  const adapter = createLocalGitHubFetch({
    store,
    managedWriteTokens: ['agent-token'],
    nativeFetch: async () => {
      nativeCalls += 1;
      return Response.json({ number: 42 });
    }
  });

  const repository = await adapter('https://api.github.com/repos/example/private-project', {
    headers: { Authorization: 'Bearer agent-token' }
  });
  assert.equal((await repository.json()).permissions.push, true);

  await adapter('https://api.github.com/repos/example/private-project/contents/project/sample.json', {
    method: 'PUT',
    headers: { Authorization: 'Bearer agent-token' },
    body: JSON.stringify({ content: Buffer.from('{}').toString('base64') })
  });
  assert.deepEqual(calls, [['write', 'project/sample.json']]);

  const issue = await adapter('https://api.github.com/repos/example/private-project/issues', {
    method: 'POST',
    headers: { Authorization: 'Bearer agent-token' },
    body: '{}'
  });
  assert.equal((await issue.json()).number, 42);
  assert.equal(nativeCalls, 1);
});
