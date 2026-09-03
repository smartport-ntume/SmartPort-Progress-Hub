import path from 'node:path';
import { GitConflictError } from './git-store.mjs';

export const LOCAL_READ_TOKEN = 'smartport-local-read';
export const LOCAL_WRITE_TOKEN = 'smartport-local-write';

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function requestHeaders(input, init) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  const overrides = new Headers(init?.headers);
  overrides.forEach((value, key) => headers.set(key, value));
  return headers;
}

function bearerToken(headers) {
  const value = headers.get('authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

async function requestBodyText(input, init) {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body instanceof Uint8Array || Buffer.isBuffer(init?.body)) {
    return Buffer.from(init.body).toString('utf8');
  }
  if (input instanceof Request) return input.clone().text();
  return '';
}

export function createLocalGitHubFetch({ nativeFetch, store }) {
  const repoPrefix = '/repos/' + store.fullName;
  const contentsPrefix = repoPrefix + '/contents/';

  return async function localGitHubFetch(input, init = {}) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.github.com') return nativeFetch(input, init);

    const headers = requestHeaders(input, init);
    const token = bearerToken(headers);
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const serviceToken = token === LOCAL_READ_TOKEN || token === LOCAL_WRITE_TOKEN;

    if (url.pathname === repoPrefix && method === 'GET' && serviceToken) {
      return response({
        full_name: store.fullName,
        private: true,
        default_branch: store.branch,
        permissions: {
          pull: true,
          push: token === LOCAL_WRITE_TOKEN,
          maintain: token === LOCAL_WRITE_TOKEN,
          admin: false,
          triage: false
        }
      });
    }

    if (url.pathname.startsWith(contentsPrefix)) {
      let relativePath;
      try {
        relativePath = decodeURIComponent(url.pathname.slice(contentsPrefix.length));
      } catch (_) {
        return response({ message: 'Invalid repository path' }, 400);
      }

      try {
        if (method === 'GET') {
          const content = await store.readBuffer(relativePath);
          const sha = await store.blobSha(relativePath);
          return response({
            type: 'file',
            encoding: 'base64',
            size: content.length,
            name: path.posix.basename(relativePath),
            path: relativePath,
            sha,
            content: content.toString('base64'),
            html_url: 'https://github.com/' + store.fullName + '/blob/' + store.branch + '/' + relativePath
          });
        }

        if (method === 'PUT') {
          if (token === LOCAL_READ_TOKEN) return response({ message: 'Read-only local repository token' }, 403);
          const raw = await requestBodyText(input, init);
          const payload = JSON.parse(raw || '{}');
          if (typeof payload.content !== 'string') return response({ message: 'content is required' }, 422);
          const result = await store.writeBuffer(relativePath, Buffer.from(payload.content, 'base64'), {
            message: payload.message,
            expectedSha: payload.sha || null
          });
          return response({
            content: {
              name: path.posix.basename(relativePath),
              path: relativePath,
              sha: result.sha,
              html_url: 'https://github.com/' + store.fullName + '/blob/' + store.branch + '/' + relativePath
            },
            commit: {
              sha: result.commitSha,
              html_url: 'https://github.com/' + store.fullName + '/commit/' + result.commitSha
            }
          }, result.changed ? 200 : 200);
        }

        return response({ message: 'Method not allowed' }, 405);
      } catch (error) {
        if (error?.code === 'ENOENT') return response({ message: 'Not Found' }, 404);
        if (error instanceof GitConflictError || error?.status === 409) {
          return response({ message: error.message }, 409);
        }
        return response({ message: error.message || String(error) }, 500);
      }
    }

    if (serviceToken) {
      return response({ message: 'Local service token cannot call this GitHub endpoint' }, 403);
    }
    return nativeFetch(input, init);
  };
}
