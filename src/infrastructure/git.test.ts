import { describe, expect, it } from 'vitest';
import { __testables, autoCommit } from './git';

describe('git runtime path filtering', () => {
  it('filters FlowPilot runtime artifacts from commit files', () => {
    expect(__testables.filterCommitFiles([
      './src/main.ts',
      '.workflow/progress.md',
      '.flowpilot/history/2026-01-01.json',
      '.claude/settings.json',
      'src/main.ts',
      'docs/readme.md',
    ])).toEqual(['src/main.ts', 'docs/readme.md']);
  });

  it('detects runtime paths after normalization', () => {
    expect(__testables.isFlowPilotRuntimePath('./.workflow/tasks.md')).toBe(true);
    expect(__testables.isFlowPilotRuntimePath('\\.flowpilot\\memory.json')).toBe(true);
    expect(__testables.isFlowPilotRuntimePath('./.claude/settings.json')).toBe(true);
    expect(__testables.isFlowPilotRuntimePath('src/app.ts')).toBe(false);
  });

  it('returns skipped/no-files when files are omitted', () => {
    expect(autoCommit('001', 'test', 'summary')).toEqual({ status: 'skipped', reason: 'no-files' });
  });

  it('returns skipped/runtime-only when only runtime files are provided', () => {
    expect(autoCommit('001', 'test', 'summary', [
      '.workflow/progress.md',
      '.flowpilot/history/run.json',
      '.claude/settings.json',
    ])).toEqual({ status: 'skipped', reason: 'runtime-only' });
  });

  it('returns skipped/no-staged-changes when business files have no git diff', () => {
    expect(autoCommit('001', 'test', 'summary', ['src/main.ts'])).toEqual({ status: 'skipped', reason: 'no-staged-changes' });
  });
});
