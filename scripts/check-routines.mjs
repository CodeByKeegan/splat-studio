// Validates the public routine bank (.agents/workflows/) — the prompts the scheduled
// agents run. Catches the drift that makes an open routine untrustworthy: a routine
// naming a skill that doesn't exist, a file missing from the registry, or a skill
// mirror that's out of date. Run via `npm run check-routines`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflows = path.join(root, '.agents', 'workflows');
const claudeSkills = path.join(root, '.claude', 'skills');
const agentSkills = path.join(root, '.agents', 'skills');

const errors = [];
const fail = (msg) => errors.push(msg);

const files = fs.readdirSync(workflows).filter(f => f.endsWith('.md') && f !== 'README.md');
if (!files.length) fail('no routines in .agents/workflows/');

const registry = fs.readFileSync(path.join(workflows, 'README.md'), 'utf8');

for (const file of files) {
    const src = fs.readFileSync(path.join(workflows, file), 'utf8');
    const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) {
        fail(`${file}: missing front matter (name, schedule, skills, opens)`);
        continue;
    }
    const meta = Object.fromEntries(
        fm[1].split(/\r?\n/).map(l => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()])
    );

    for (const key of ['name', 'schedule', 'skills', 'opens']) {
        if (!meta[key]) fail(`${file}: front matter is missing \`${key}\``);
    }
    if (meta.name && meta.name !== path.basename(file, '.md')) {
        fail(`${file}: front-matter name \`${meta.name}\` doesn't match the filename`);
    }
    for (const skill of (meta.skills || '').split(',').map(s => s.trim()).filter(Boolean)) {
        if (!fs.existsSync(path.join(claudeSkills, skill, 'SKILL.md'))) {
            fail(`${file}: names skill \`${skill}\`, which has no .claude/skills/${skill}/SKILL.md`);
        }
    }
    if (!registry.includes(`(${file})`)) fail(`${file}: not listed in .agents/workflows/README.md`);
}

// The cross-agent mirror is generated — a stale copy means Codex/Antigravity run
// different instructions than Claude does.
const isSkill = (dir, name) => fs.existsSync(path.join(dir, name, 'SKILL.md'));
for (const name of fs.readdirSync(claudeSkills).filter(n => isSkill(claudeSkills, n))) {
    const mirrored = path.join(agentSkills, name, 'SKILL.md');
    if (!fs.existsSync(mirrored)) {
        fail(`skill \`${name}\` is not mirrored to .agents/skills — run \`npm run sync-skills\``);
    } else if (fs.readFileSync(mirrored, 'utf8') !== fs.readFileSync(path.join(claudeSkills, name, 'SKILL.md'), 'utf8')) {
        fail(`skill \`${name}\` differs from its .agents/skills mirror — run \`npm run sync-skills\``);
    }
}

if (errors.length) {
    console.error(`${errors.length} problem(s) in the routine bank:`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
}
console.log(`routine bank OK — ${files.length} routines, all skills present, mirror in sync.`);
