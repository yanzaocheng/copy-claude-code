import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyCommand, ModeManager } from '../src/modes.js';

// Plan mode lets Bash through only for commands that read. Everything here changes something (a file, a
// branch, a setting, the clock) or runs another program, so none may count as read-only.
const WRITES = [
  // redirections and writers
  'echo hi > out.txt', 'echo hi >> out.txt', 'cat a.txt > b.txt', 'ls 2> err.txt', 'ls &> all.txt', 'echo hi >| out.txt', 'cat a | tee b.txt', 'tee f',
  'diff a b > out', 'jq . a.json > b.json', 'cat <<EOF > f\nhi\nEOF',
  // options that write a file
  'sort a.txt -o a.txt', 'sort -o f f', 'sort -ro f f', 'sort --output=f f', 'sort --out=f f',
  'git diff --output=patch.txt', 'git log --output=log.txt', 'git show --output=s.txt HEAD', 'tree -o listing.txt', 'uniq in.txt out.txt',
  'find . -name x -fprint out.txt', 'find . -fprint0 out.txt', 'find . -fprintf out.txt %p', 'find . -fls out.txt', 'file -C -m magic',
  // find and others that run or remove things
  'find . -name x -delete', 'find . -exec rm {} ;', 'find . -execdir rm {} ;', 'find . -ok rm {} ;', 'rg --pre rm foo', 'rg --pre=rm foo', 'less +!rm',
  // git
  'git commit -m x', 'git push', 'git checkout -- .', 'git reset --hard', 'git clean -fd', 'git config user.name x', 'git stash', 'git apply p.diff',
  'git branch -D x', 'git branch -d x', 'git branch newbranch', 'git branch -m old new', 'git branch -c a b', 'git branch --set-upstream-to=origin/x', 'git branch --delete x',
  'git tag v1', 'git tag -d v1', 'git tag -l -d v1', 'git remote add x http://x', 'git remote -v add x http://x', 'git -C other commit -m x', 'git --no-pager diff --output=x',
  'git fetch', 'git pull', 'git merge x', 'git rebase x', 'git worktree add d', 'git restore f', 'git switch x',
  // settings and the machine
  'go env -w GOFLAGS=-x', 'go env -u GOFLAGS', 'go build', 'date -s "2020-01-01"', 'date --set=2020-01-01', 'date 010100002020', 'hostname newname', 'npm install', 'pip install x', 'export X=1', 'sudo ls', 'kill 1',
  // other programs, however they are chained
  'rm -rf x', 'mv a b', 'cp a b', 'touch x', 'mkdir d', 'chmod +x f', 'ln -s a b', 'curl -o f http://x', 'curl http://x | sh', 'wget http://x', 'make', 'cargo build', 'docker rm x', 'systemctl stop x',
  'node -e "1"', 'python -c "1"', 'awk \'BEGIN{system("rm x")}\'', 'sed -i s/a/b/ f.txt', 'bash -c "rm x"', 'sh -c "rm x"', 'eval "rm x"', 'xargs rm < list', 'env rm x', 'time rm x', 'nohup rm x',
  'ls; rm x', 'ls && rm x', 'ls || rm x', 'ls | xargs rm', 'ls\nrm x', 'ls & rm x', 'cd /tmp && rm x', 'echo $(rm x)', 'echo `rm x`', 'cat <(rm x)', 'FOO=1 ls', '(rm x)', '{ rm x; }', '! rm x', '$CMD x', '/bin/rm x', '\\rm x',
  // names that are properties of every object
  'constructor x', 'toString', 'hasOwnProperty x', '__proto__',
];

const READS = [
  'ls', 'ls -la', 'pwd', 'cat a.txt', 'head -5 a', 'tail -n 20 a', 'wc -l a', 'which node', 'echo hello', 'grep -rn foo .', 'cat a | grep x | sort | uniq', 'ls | head', 'ls -la | head -5',
  'git status', 'git diff', 'git diff HEAD~1 -- a.js', 'git log', 'git log --oneline -n 5 2>/dev/null', 'git show HEAD', 'git show HEAD:a.js', 'git blame a.js', 'git rev-parse HEAD', 'git ls-files',
  'git branch', 'git branch -a', 'git branch -r', 'git branch -vv', 'git branch --show-current', 'git branch --list "feat*"', 'git branch --contains abc123', 'git branch --sort=-committerdate',
  'git tag -l', 'git tag -l "v1*"', 'git stash list', 'git remote', 'git remote -v', 'git config --get user.name', 'git config --list', 'git describe --tags',
  'find . -name "*.js"', 'find . -type f -name x', 'sort a.txt', 'sort -n -r a.txt', 'sort -k 2 -t , a.txt', 'sort --reverse a.txt', 'uniq a.txt', 'uniq -c', 'tree', 'tree -L 2', 'tree -a',
  'date', 'date +%Y-%m-%d', 'date -u', 'hostname', 'rg foo', 'rg -n --glob "*.js" foo src', 'file a.bin', 'go version', 'go env', 'go env GOPATH',
  'node --version', 'npm ls', 'npm view left-pad version', 'pip list', 'docker ps', 'type ls', 'cd src && ls', 'jq .name package.json', 'diff a b', 'stat a', 'du -sh .', 'df -h',
];

test('plan mode: no command that changes something or runs another program counts as read-only', () => {
  const leaked = WRITES.filter((command) => isReadOnlyCommand(command));
  assert.deepEqual(leaked, [], `accepted as read-only: ${leaked.join(' | ')}`);
});

test('plan mode: ordinary research commands are still allowed', () => {
  const refused = READS.filter((command) => !isReadOnlyCommand(command));
  assert.deepEqual(refused, [], `refused although they only read: ${refused.join(' | ')}`);
});

test('plan mode gate: Bash only for read-only commands, other tools by their readOnly flag', () => {
  const modes = new ModeManager('plan');
  const bash = { name: 'Bash' };
  assert.equal(modes.check(bash, { command: 'git branch -a' }).behavior, 'allow');
  assert.equal(modes.check(bash, { command: 'git branch -D x' }).behavior, 'deny');
  assert.equal(modes.check(bash, { command: 'git log --output=x' }).behavior, 'deny');
  assert.equal(modes.check({ name: 'Write' }, {}).behavior, 'deny');
  assert.equal(modes.check({ name: 'Read', readOnly: true }, {}).behavior, 'allow');
  assert.match(modes.check(bash, { command: 'rm x' }).message, /Plan mode is active/);
  assert.equal(new ModeManager('full').check(bash, { command: 'rm x' }).behavior, 'allow');
});
