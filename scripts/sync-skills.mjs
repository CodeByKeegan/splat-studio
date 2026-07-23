#!/usr/bin/env node
// Mirror canonical Claude Code skills into the cross-agent .agents/skills dir so
// Codex (.agents/skills) and Antigravity (.agents/skills) read the same SKILL.md format.
// Run via `npm run sync-skills` after editing anything under .claude/skills/.
import { cpSync, rmSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '.claude', 'skills');
const dst = join(root, '.agents', 'skills');

const isSkillDir = (name) =>
    !name.startsWith('.') &&
    statSync(join(src, name)).isDirectory() &&
    existsSync(join(src, name, 'SKILL.md'));

const skills = readdirSync(src).filter(isSkillDir);

// Rebuild the mirror, excluding Claude's internal .system/ files.
if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const name of skills) {
    cpSync(join(src, name), join(dst, name), {
        recursive: true,
        filter: (p) => !p.split(/[\\/]/).includes('.system'),
    });
}

console.log(`Synced ${skills.length} skills -> .agents/skills: ${skills.join(', ')}`);
