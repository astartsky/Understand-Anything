import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const skillDir = resolve(__dirname, '../../../understand-anything-plugin/skills/understand');
const entrypoint = readFileSync(resolve(skillDir, 'SKILL.md'), 'utf-8');
// Phase contracts live in references linked by the entrypoint; keep checking
// the complete procedure rather than forcing it back into one large prompt.
const references = [...new Set([...entrypoint.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map(match => match[1]))];
const skill = [entrypoint, ...references.map(file => readFileSync(resolve(skillDir, file), 'utf-8'))].join('\n');
const hook = readFileSync(
  resolve(__dirname, '../../../understand-anything-plugin/hooks/auto-update-prompt.md'),
  'utf-8',
);
const analyzer = readFileSync(
  resolve(__dirname, '../../../understand-anything-plugin/agents/file-analyzer.md'), 'utf-8',
);

describe('incremental execution contract', () => {
  it.each([skill, hook])('routes inventory and baseline updates through bundled helpers', content => {
    expect(content).toContain('prepare-incremental.mjs');
    expect(content).toContain('finalize-incremental.mjs');
    expect(content).toContain('filesToReanalyze');
    expect(content).toContain('batch-existing.json');
    expect(content).toContain('generated-artifact-only');
  });

  it('skips whole-graph LLM phases for ordinary partial updates', () => {
    expect(skill).toContain('Both incremental actions skip assemble-reviewer');
    expect(skill).toContain('For `PARTIAL_UPDATE`, dispatch no architecture agent');
    expect(skill).toContain('For `PARTIAL_UPDATE`, dispatch no tour agent');
    expect(skill).toContain('Without `--review`');
    expect(skill).toContain('Do not run Phase 6');
  });

  it('keeps explicit review and architecture escalation behavior', () => {
    expect(skill).toContain('The user-facing `--review` option is still honored');
    expect(skill).toContain('where `rerunArchitecture === true`');
    expect(skill).toContain('where `rerunTour === true`');
    expect(skill).toContain('`FULL_UPDATE`');
    expect(skill).toContain('With explicit `--review`');
    expect(skill).toContain('jump to the `--review` graph-reviewer path in Phase 6');
  });

  it.each([skill, hook])('requires deterministic symbol checking and one targeted repair', content => {
    expect(content).toContain('incremental-symbol-baseline.json');
    expect(content).toContain('validate-incremental-symbols.mjs');
    expect(content).toContain('incremental-symbol-report.json');
    expect(content).toContain('prepare-symbol-retry.mjs');
    expect(content).toContain('incremental-symbol-retry.json');
    expect(content).toContain('previousSymbols');
    expect(content).toContain('missingSymbols');
    expect(content).toContain('independently reruns the shared symbol');
  });

  it('keeps significance filtering for new symbols but requires accounting for old methods', () => {
    expect(analyzer).toContain('New symbols continue to use the filter above');
    expect(analyzer).toContain('classes[].methods');
    expect(analyzer).toContain('check the complete `previousSymbols` checklist');
    expect(analyzer).toContain('explicitly report an error with its ID/name');
  });
});
