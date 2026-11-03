import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

function readRepoFile(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf-8');
}

function readSkillWithReferences(relPath) {
  const entry = readRepoFile(relPath);
  const refs = [...new Set([...entry.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map(match => match[1]))];
  return [entry, ...refs.map(ref => readFileSync(resolve(repoRoot, dirname(relPath), ref), 'utf-8'))].join('\n');
}

describe('skill command hardening', () => {
  it('quotes PROJECT_ROOT in shell command snippets', () => {
    const files = [
      'understand-anything-plugin/skills/understand/SKILL.md',
      'understand-anything-plugin/hooks/auto-update-prompt.md',
    ];

    const unsafePatterns = [
      /\b(?:node|python|python3|mkdir|find|rm|cat)\s+(?:-[^\n]*\s+)*\$PROJECT_ROOT\b/,
      />\s*\$PROJECT_ROOT\b/,
      /--changed-files=\$PROJECT_ROOT\b/,
      /rm\s+-rf\s+\$PROJECT_ROOT\b/,
    ];

    for (const relPath of files) {
      const content = readSkillWithReferences(relPath);
      for (const pattern of unsafePatterns) {
        expect(content, `${relPath} should not contain ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it('quotes skill and target directory placeholders in knowledge commands', () => {
    const content = readRepoFile('understand-anything-plugin/skills/understand-knowledge/SKILL.md');

    expect(content).not.toMatch(/python3\s+<SKILL_DIR>\/[^\n]+ <TARGET_DIR>/);
    expect(content).not.toMatch(/rm\s+-rf\s+<TARGET_DIR>/);
  });

  it('does not rewrite metadata for generated-only commits', () => {
    const content = readRepoFile(
      'understand-anything-plugin/hooks/auto-update-prompt.md',
    );

    expect(content).toContain('generated-artifact-only');
    expect(content).toContain('intentionally advances nothing for generated-only commits');
    expect(content).toContain('Never update `meta.json` for a generated-artifact-only commit');
  });

  it('runs the documented local viewer with a literal spaced project path', () => {
    const content = readRepoFile('understand-anything-plugin/skills/understand-dashboard/SKILL.md');
    const blocks = [...content.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
    const launches = blocks.filter(block => block.includes('VIEWER_DIR='));
    expect(launches).toHaveLength(1);
    const block = launches[0];
    expect(block).not.toMatch(/\bnpx\b|\b(?:npm|pnpm)\s+install\b/);
    const dir = mkdtempSync(resolve(tmpdir(), 'ua-launch-'));
    try {
      const project = resolve(dir, 'project with spaces');
      const plugin = resolve(dir, 'plugin with spaces');
      const viewer = resolve(plugin, 'packages/viewer');
      mkdirSync(project);
      mkdirSync(resolve(viewer, 'bin/dist'), { recursive: true });
      mkdirSync(resolve(viewer, 'dist'));
      writeFileSync(resolve(viewer, 'dist/index.html'), 'fixture');
      writeFileSync(resolve(viewer, 'bin/dist/staleness.js'), '');
      writeFileSync(resolve(viewer, 'bin/viewer.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
      const result = spawnSync('bash', ['--noprofile', '--norc', '-c', block], {
        cwd: dir, encoding: 'utf8',
        env: { PATH: process.env.PATH, PROJECT_ROOT: project, PLUGIN_ROOT: plugin },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([project, '--no-open']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes the actual project-scanner import input through a spaced checkout path', () => {
    const content = readRepoFile('understand-anything-plugin/agents/project-scanner.md');
    const blocks = [...content.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);
    const writes = blocks.filter(block => block.includes('cat >') && block.includes('ua-import-map-input.json'));
    expect(writes).toHaveLength(1);
    const project = mkdtempSync(resolve(tmpdir(), 'feature checkout '));
    try {
      const result = spawnSync('bash', ['--noprofile', '--norc', '-c', writes[0]], {
        encoding: 'utf8', env: { PATH: process.env.PATH, PROJECT_ROOT: project },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(resolve(project, '.ua/tmp/ua-import-map-input.json'), 'utf8')).files).toHaveLength(2);
    } finally { rmSync(project, { recursive: true, force: true }); }
  });

  it('marks project-controlled context as untrusted data', () => {
    const understand = readSkillWithReferences('understand-anything-plugin/skills/understand/SKILL.md');
    const knowledge = readRepoFile('understand-anything-plugin/skills/understand-knowledge/SKILL.md');

    expect(understand).not.toMatch(/README and manifest are authoritative/i);
    expect(understand).toMatch(/untrusted project data/i);
    expect(knowledge).toMatch(/untrusted article data/i);
  });
});
