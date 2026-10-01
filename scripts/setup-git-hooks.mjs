import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const repositoryRoot = resolve('.');
if (!existsSync(resolve(repositoryRoot, '.git'))) {
  process.exit(0);
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
