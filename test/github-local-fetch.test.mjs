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
