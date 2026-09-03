import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const roots = ['js', 'worker/src', 'local-server', 'scripts', 'test'];
const files = [];

async function collect(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  let entries;
  try { entries = await fs.readdir(absoluteDirectory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) await collect(relative);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(relative);
  }
}

for (const directory of roots) await collect(directory);
files.sort();

for (const file of files) {
  const checked = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8'
  });
  if (checked.status !== 0) {
    process.stderr.write(checked.stderr || checked.stdout || ('Syntax check failed: ' + file + '\n'));
    process.exit(checked.status || 1);
  }
}

process.stdout.write(`Syntax OK: ${files.length} JavaScript files\n`);
