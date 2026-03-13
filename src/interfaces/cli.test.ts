import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI } from './cli';
import { getCurrentVersion } from '../infrastructure/updater';
import { readAllFromStream, resolveSetupClientChoice } from './stdin';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveSetupClientChoice', () => {
  it('maps numbered options and defaults to other', () => {
    expect(resolveSetupClientChoice('1')).toBe('claude');
    expect(resolveSetupClientChoice('2')).toBe('codex');
    expect(resolveSetupClientChoice('3')).toBe('cursor');
    expect(resolveSetupClientChoice('4')).toBe('snow-cli');
    expect(resolveSetupClientChoice('')).toBe('other');
    expect(resolveSetupClientChoice('9')).toBe('other');
  });
});

describe('CLI init setup mode', () => {
  it('uses setup client selector when init runs without piped tasks', async () => {
    const service = {
      setup: vi.fn(async () => '项目已接管，工作流工具就绪'),
    } as any;
    const cli = new CLI(service, {
      readStdinIfPiped: async () => '',
      promptSetupClient: async () => 'snow-cli',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'init']);

    expect(service.setup).toHaveBeenCalledWith('snow-cli');
    expect(stdoutSpy).toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});

describe('CLI pulse command', () => {
  it('parses pulse phase and note then forwards to service', async () => {
    const service = {
      pulse: vi.fn(async () => '已记录任务 001 阶段 analysis'),
    } as any;
    const cli = new CLI(service);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'pulse', '001', '--phase', 'analysis', '--note', '正在读 README']);

    expect(service.pulse).toHaveBeenCalledWith('001', 'analysis', '正在读 README');
    expect(stdoutSpy).toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('accepts chinese phase aliases', async () => {
    const service = {
      pulse: vi.fn(async () => '已记录任务 001 阶段 blocked'),
    } as any;
    const cli = new CLI(service);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'pulse', '001', '阻塞', '等待测试完成']);

    expect(service.pulse).toHaveBeenCalledWith('001', 'blocked', '等待测试完成');
    stdoutSpy.mockRestore();
  });
});

describe('CLI command argument parsing', () => {
  it('parses checkpoint inline summary before --files', async () => {
    const service = {
      checkpoint: vi.fn(async () => 'ok'),
    } as any;
    const cli = new CLI(service, {
      readStdinIfPiped: async () => '',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'checkpoint', '001', '一句话摘要', '--files', 'src/a.ts']);

    expect(service.checkpoint).toHaveBeenCalledWith('001', '一句话摘要', ['src/a.ts']);
    stdoutSpy.mockRestore();
  });

  it('parses checkpoint inline summary after --files', async () => {
    const service = {
      checkpoint: vi.fn(async () => 'ok'),
    } as any;
    const cli = new CLI(service, {
      readStdinIfPiped: async () => '',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'checkpoint', '001', '--files', 'src/a.ts', '一句话摘要']);

    expect(service.checkpoint).toHaveBeenCalledWith('001', '一句话摘要', ['src/a.ts']);
    stdoutSpy.mockRestore();
  });

  it('parses adopt inline summary after --files', async () => {
    const service = {
      adopt: vi.fn(async () => 'ok'),
    } as any;
    const cli = new CLI(service, {
      readStdinIfPiped: async () => '',
    });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'adopt', '001', '--files', 'src/a.ts', '接管摘要']);

    expect(service.adopt).toHaveBeenCalledWith('001', '接管摘要', ['src/a.ts']);
    stdoutSpy.mockRestore();
  });

  it('keeps full title for add without --type', async () => {
    const service = {
      add: vi.fn(async () => 'ok'),
    } as any;
    const cli = new CLI(service);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'add', '修复', '接管', '提示']);

    expect(service.add).toHaveBeenCalledWith('修复 接管 提示', 'general');
    stdoutSpy.mockRestore();
  });

  it('shows add help instead of treating --help as a task title', async () => {
    const service = {
      add: vi.fn(async () => 'ok'),
    } as any;
    const cli = new CLI(service);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'add', '--help']);

    expect(service.add).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(
      '用法: node flow.js add <描述> [--type frontend|backend|general]\n示例:\n  node flow.js add "修复支付回调重试"\n  node flow.js add "补上线检查项" --type backend\n'
    );
    stdoutSpy.mockRestore();
  });
});

describe('CLI update checks', () => {
  it('skips update checks for resume', async () => {
    const service = {
      resume: vi.fn(async () => '恢复中'),
    } as any;
    const cli = new CLI(service, {
      checkForUpdate: vi.fn(() => '有新版本'),
    } as any);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'resume']);

    expect(service.resume).toHaveBeenCalled();
    expect((cli as any).deps.checkForUpdate).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('runs update checks for next', async () => {
    const service = {
      next: vi.fn(async () => null),
    } as any;
    const cli = new CLI(service, {
      checkForUpdate: vi.fn(() => '有新版本'),
    } as any);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await cli.run(['node', 'flow.js', 'next']);

    expect((cli as any).deps.checkForUpdate).toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith('全部完成 有新版本\n');
    stdoutSpy.mockRestore();
  });
});

describe('version resolution', () => {
  it('reads version from the executed script path instead of cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'flowpilot-cli-test-'));
    const flowPath = join(dir, 'flow.js');
    await writeFile(flowPath, '#!/usr/bin/env node\n// FLOWPILOT_VERSION: 9.8.7\n', 'utf-8');

    expect(getCurrentVersion(flowPath)).toBe('9.8.7');
  });
});

describe('stdin reading', () => {
  it('waits for slow piped input without destroying the stream', async () => {
    const stream = new PassThrough();
    const resultPromise = readAllFromStream(stream);

    setTimeout(() => {
      stream.write('slow ');
      stream.end('input');
    }, 50);

    await expect(resultPromise).resolves.toBe('slow input');
  });
});
