import http from 'node:http';
import process from 'node:process';
import { serveStaticFile } from '../local-server/static-files.mjs';

const host = '127.0.0.1';
const port = 4173;
const rootDir = process.cwd();

const server = http.createServer(async (request, response) => {
  try {
    if (await serveStaticFile(request, response, rootDir)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Preview error');
    process.stderr.write(String(error?.stack || error) + '\n');
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    `SmartPort preview: http://${host}:${port}/\n` +
    'Only frontend allowlisted files are served; .env.local remains private.\n'
  );
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
