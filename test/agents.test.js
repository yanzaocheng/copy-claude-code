import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Agent, skill and command files are looked up in the user's config directory too.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-agents-home-'));
process.env.CLAUDE_PRO_CONFIG_DIR = home;
const { parseFrontmatter, loadAgents, loadSkills, loadCustomCommands, renderSkill, expandCommandBody, expandShellEmbeds } = await import('../src/agents.js');
const { gitInfo, localDate, environmentBlock } = await import('../src/context.js');

const project = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pro-agents-'));
const write = (dir, rel, text, { bom = false } = {}) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (bom ? '\ufeff' : '') + text);
  return file;
};

test('parseFrontmatter: plain, quoted and continued values', () => {
  const p = parseFrontmatter('---\nname: reviewer\ndescription: "Reviews code; \\"carefully\\"\\nSecond line"\nmodel: \'haiku\'\nargument-hint: [file]\n---\nBody text here.\n');
  assert.equal(p.meta.name, 'reviewer');
  assert.equal(p.meta.description, 'Reviews code; "carefully"\nSecond line');
  assert.equal(p.meta.model, 'haiku');
  assert.equal(p.meta['argument-hint'], '[file]');
  assert.equal(p.body, 'Body text here.');
  const folded = parseFrontmatter('---\ndescription: This is long\n  and continues here\nname: x\n---\nb');
  assert.equal(folded.meta.description, 'This is long and continues here');
  assert.equal(folded.meta.name, 'x');
});

test('parseFrontmatter: block scalars, lists and a byte order mark', () => {
  const literal = parseFrontmatter('---\nname: a\ndescription: |\n  First line.\n  Second line.\ntools: Read, Grep\n---\nbody');
  assert.equal(literal.meta.description, 'First line.\nSecond line.');
  assert.equal(literal.meta.tools, 'Read, Grep');
  assert.equal(parseFrontmatter('---\ndescription: >\n  folded\n  text\n---\nb').meta.description, 'folded text');
  assert.equal(parseFrontmatter('---\ntools:\n  - Read\n  - Grep\n---\nb').meta.tools, 'Read, Grep');
  assert.equal(parseFrontmatter('\ufeff---\nname: bom\n---\nbody').meta.name, 'bom');
  assert.equal(parseFrontmatter('---\r\nname: crlf\r\ndescription: windows\r\n---\r\nbody\r\n').meta.description, 'windows');
});

test('parseFrontmatter: no frontmatter, an empty body, and a line that only starts with ---', () => {
  assert.equal(parseFrontmatter('just text\n---\nmore'), null);
  assert.equal(parseFrontmatter('---\nname: x\n---').body, '');
  assert.equal(parseFrontmatter('---\nname: x\n--- not the end\ndescription: y\n---\nbody').meta.description, 'y');
});

test('loadAgents: files with a BOM, block scalar descriptions and list-style tools', () => {
  const dir = project();
  write(dir, '.claude/agents/bom.md', '---\nname: bom-agent\ndescription: Saved with a BOM\n---\nDo things.', { bom: true });
  write(dir, '.claude/agents/block.md', '---\nname: block-agent\ndescription: |\n  Use this agent to review code.\n  It reads carefully.\ntools: [Read, "Grep"]\nmodel: inherit\n---\nReview.');
  write(dir, '.claude/agents/incomplete.md', '---\nname: no-description\n---\nx');
  const agents = loadAgents(dir);
  assert.equal(agents.get('bom-agent').description, 'Saved with a BOM');
  assert.equal(agents.get('bom-agent').prompt, 'Do things.');
  assert.equal(agents.get('block-agent').description, 'Use this agent to review code.\nIt reads carefully.');
  assert.deepEqual(agents.get('block-agent').tools, ['Read', 'Grep']);
  assert.equal(agents.get('block-agent').model, null);
  assert.equal(agents.has('no-description'), false);
  assert.ok(agents.has('Explore') && agents.has('general-purpose'), 'the built-in agents are still there');
});

test('loadSkills and loadCustomCommands: a BOM does not leak the frontmatter into the instructions', () => {
  const dir = project();
  write(dir, '.claude/skills/bomskill/SKILL.md', '---\nname: bomskill\ndescription: A skill\n---\nSkill body.', { bom: true });
  write(dir, '.claude/skills/plain/SKILL.md', '\ufeffNo frontmatter, only a BOM.');
  write(dir, '.claude/commands/bomcmd.md', '---\ndescription: A command\nargument-hint: [x]\n---\nCommand body $ARGUMENTS', { bom: true });
  const skills = loadSkills(dir);
  assert.equal(skills.get('bomskill').body, 'Skill body.');
  assert.equal(skills.get('plain').body, 'No frontmatter, only a BOM.');
  const commands = loadCustomCommands(dir);
  assert.equal(commands.get('bomcmd').body, 'Command body $ARGUMENTS');
  assert.equal(commands.get('bomcmd').description, 'A command');
  assert.equal(commands.get('bomcmd').argumentHint, '[x]');
});

test('loadCustomCommands survives a file that cannot be read', (t) => {
  const dir = project();
  write(dir, '.claude/commands/good.md', 'good command');
  try {
    fs.symlinkSync(path.join(dir, 'missing-target.md'), path.join(dir, '.claude', 'commands', 'broken.md'));
  } catch (e) {
    t.skip(`cannot create a symbolic link here (${e.code})`);
    return;
  }
  const commands = loadCustomCommands(dir);
  assert.deepEqual([...commands.keys()], ['good']);
});

test('renderSkill and expandCommandBody leave $& and $$ in the arguments alone', () => {
  assert.equal(renderSkill({ body: 'Run: $ARGUMENTS', dir: 'D' }, 'cost $& and $$ and $1').split('\n').pop(), 'Run: cost $& and $$ and $1');
  assert.match(renderSkill({ body: 'No placeholder', dir: 'D' }, 'extra $&'), /ARGUMENTS: extra \$&$/);
  assert.equal(expandCommandBody('fix $1 in $2 ($ARGUMENTS)', 'a.js b.js'), 'fix a.js in b.js (a.js b.js)');
  assert.equal(expandCommandBody('echo $ARGUMENTS', 'it costs $& $$ $1'), 'echo it costs $& $$ $1', 'what the arguments contain is not expanded again');
  assert.equal(expandCommandBody('missing $3 here', 'one'), 'missing  here\n\nARGUMENTS: one');
  assert.equal(expandCommandBody('plain', ''), 'plain');
});

test('expandShellEmbeds puts in what the command printed, whatever it contains', async () => {
  const ran = [];
  const out = await expandShellEmbeds('before !`echo one` middle !`echo two` after', async (command) => { ran.push(command); return command === 'echo one' ? 'pid $$ and $& and $1' : 'two'; });
  assert.deepEqual(ran, ['echo one', 'echo two']);
  assert.equal(out, 'before pid $$ and $& and $1 middle two after');
  assert.equal(await expandShellEmbeds('no embeds', async () => { throw new Error('not called'); }), 'no embeds');
});

test('localDate is the date where the user is, not the UTC date', () => {
  assert.equal(localDate(new Date(2026, 9, 5, 0, 30)), '2026-10-05');
  assert.equal(localDate(new Date(2026, 0, 3, 23, 59)), '2026-01-03');
  assert.equal(localDate(new Date(2026, 11, 31, 12, 0)), '2026-12-31');
  assert.match(environmentBlock(process.cwd(), { model: { id: 'm' }, shellName: 'bash' }), new RegExp(`Today's date: ${localDate()}`));
});

test('gitInfo shows non-ASCII file names as they are', (t) => {
  const dir = project();
  try { execFileSync('git', ['init', '-q'], { cwd: dir }); } catch { t.skip('git is not available'); return; }
  fs.writeFileSync(path.join(dir, '你好.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'plain.txt'), 'x');
  const info = gitInfo(dir);
  assert.ok(info.status.includes('你好.txt'), `status was ${JSON.stringify(info.status)}`);
  assert.ok(!info.status.includes('\\344'));
});
