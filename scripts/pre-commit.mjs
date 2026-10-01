import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { resolve } from 'node:path';

const root = resolve('.');
const git = (args, options = {}) =>
  execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'inherit'],
  });

const run = (command, args) => {
  execFileSync(command, args, {
    cwd: root,
    stdio: 'inherit',
  });
};

const staged = git([
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACMR',
  '-z',
])
  .split('\0')
  .filter(Boolean);

if (staged.length === 0) {
  process.exit(0);
}

const unstaged = new Set(
  git(['diff', '--name-only', '-z'])
    .split('\0')
    .filter(Boolean),
);

const overlapping = staged.filter((file) => unstaged.has(file));
if (overlapping.length > 0) {
  process.stderr.write(
    [
      'Pre-commit auto-fix stopped because these files have both staged and unstaged changes:',
      ...overlapping.map((file) => `  - ${file}`),
      '',
      'Stage the whole file before committing so formatting/lint fixes cannot accidentally stage unrelated edits.',
    ].join('\n') + '\n',
  );
  process.exit(1);
}

const prettierFiles = staged.filter((file) =>
  /\.(?:c|m)?js$|\.json$|\.md$|\.ya?ml$/.test(file),
);
const eslintFiles = staged.filter((file) => /\.(?:c|m)?js$|\.tsx?$/.test(file));

const prettierBin = resolve(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
);
const eslintBin = resolve(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'eslint.cmd' : 'eslint',
);

if (prettierFiles.length > 0) {
  run(prettierBin, ['--write', '--ignore-unknown', ...prettierFiles]);
}

if (eslintFiles.length > 0) {
  run(eslintBin, ['--fix', ...eslintFiles]);
}

run('git', ['add', '--', ...staged]);
