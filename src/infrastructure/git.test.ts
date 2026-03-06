import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { __testables, autoCommit, listChangedFiles } from './git';

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

  it('returns skipped/no-files when files list is empty', () => {
    expect(autoCommit('001', 'test', 'summary', [])).toEqual({ status: 'skipped', reason: 'no-files' });
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

  it('collects staged, unstaged and untracked business files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flow-git-'));

    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.name', 'FlowPilot Test'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['config', 'user.email', 'flowpilot@example.com'], { cwd: dir, stdio: 'pipe' });

      await writeFile(join(dir, 'tracked.txt'), 'base\n', 'utf-8');
      await writeFile(join(dir, 'staged.txt'), 'base\n', 'utf-8');
      execFileSync('git', ['add', '--', 'tracked.txt', 'staged.txt'], { cwd: dir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });

      await writeFile(join(dir, 'tracked.txt'), 'base\nchanged\n', 'utf-8');
      await writeFile(join(dir, 'staged.txt'), 'base\nstaged\n', 'utf-8');
      await writeFile(join(dir, 'untracked.txt'), 'new\n', 'utf-8');
      execFileSync('git', ['add', '--', 'staged.txt'], { cwd: dir, stdio: 'pipe' });

      expect(listChangedFiles(dir)).toEqual(['staged.txt', 'tracked.txt', 'untracked.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
