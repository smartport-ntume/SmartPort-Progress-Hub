import { loadConfig, configProblems } from './config.mjs';
import { GitRepositoryStore } from './git-store.mjs';
import { SnapshotPublisher } from './snapshot.mjs';

const config = loadConfig();
const problems = configProblems(config);
if (problems.length) throw new Error(problems.join('; '));
if (!config.snapshot.enabled) throw new Error('Set PUBLIC_SNAPSHOT_ENABLED=true first');

const projectStore = new GitRepositoryStore({
  repoPath: config.project.path,
  repoUrl: config.project.url,
  branch: config.project.branch,
  fullName: config.project.fullName,
  autoPull: true,
  autoPush: false,
  authorName: config.project.authorName,
  authorEmail: config.project.authorEmail
});
const publicStore = new GitRepositoryStore({
  repoPath: config.snapshot.publicRepoPath,
  repoUrl: config.snapshot.publicRepoUrl,
  branch: config.snapshot.branch,
  fullName: 'smartport-ntume/SmartPort-Progress-Hub',
  autoPull: true,
  autoPush: true,
  authorName: config.project.authorName,
  authorEmail: config.project.authorEmail
});
const publisher = new SnapshotPublisher({
  enabled: true,
  projectStore,
  publicStore,
  file: config.snapshot.file
});
const result = await publisher.publish();
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
