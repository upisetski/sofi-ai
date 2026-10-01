import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { resolve } from 'node:path';

const repositoryRoot = resolve('.');
if (!existsSync(resolve(repositoryRoot, '.git'))) {
  process.exit(0);
}

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
