/**
 * @module interfaces/cli
 * @description CLI 命令路由
 */

import { readFileSync } from 'fs';
import { resolve, relative } from 'path';
import type { WorkflowService } from '../application/workflow-service';
import { formatStatus, formatTask, formatBatch } from './formatter';
import { promptSetupClient, readStdinIfPiped } from './stdin';
import { enableVerbose } from '../infrastructure/logger';
import { checkForUpdate, getCurrentVersion } from '../infrastructure/updater';
import type { SetupClient } from '../domain/types';

interface CliDeps {
  readStdinIfPiped?: typeof readStdinIfPiped;
  promptSetupClient?: () => Promise<SetupClient>;
  checkForUpdate?: (executablePath?: string) => string | null;
  getCurrentVersion?: (executablePath?: string) => string;
  getExecutablePath?: () => string | undefined;
}

interface ParsedPayload {
  detail: string;
  files?: string[];
}

const UPDATE_SKIP_COMMANDS = new Set(['version', 'help', '-h', '--help', 'resume', 'status', 'recall']);
const VALID_TASK_TYPES = new Set(['frontend', 'backend', 'general']);

function looksLikePathToken(token: string): boolean {
  return /^[./~]/.test(token) || token.includes('/') || token.includes('\\') || token.includes('.');
}

function resolveProjectFile(pathArg: string): string {
  const filePath = resolve(pathArg);
  if (relative(process.cwd(), filePath).startsWith('..')) throw new Error('--file 路径不能超出项目目录');
  return filePath;
}

async function parseDetailAndFiles(
  rest: string[],
  readInput: () => Promise<string>,
): Promise<ParsedPayload> {
  const detailTokens: string[] = [];
  const files: string[] = [];
  let detailFromFile: string | null = null;

  for (let i = 1; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--file') {
      const fileArg = rest[i + 1];
      if (!fileArg) throw new Error('需要 --file 路径');
      detailFromFile = readFileSync(resolveProjectFile(fileArg), 'utf-8');
      i += 1;
      continue;
    }
    if (token === '--files') {
      let sawFile = false;
      while (i + 1 < rest.length && !rest[i + 1].startsWith('--')) {
        const candidate = rest[i + 1];
        if (sawFile && !looksLikePathToken(candidate)) {
          detailTokens.push(...rest.slice(i + 1));
          i = rest.length;
          break;
        }
        files.push(candidate);
        sawFile = true;
        i += 1;
      }
      continue;
    }
    if (token.startsWith('--')) {
      continue;
    }
    detailTokens.push(token);
  }

  const detail = detailFromFile ?? (detailTokens.length ? detailTokens.join(' ') : await readInput());
  return {
    detail: detail.trim(),
    ...(files.length ? { files } : {}),
  };
}

export class CLI {
  constructor(
    private readonly service: WorkflowService,
    private readonly deps: CliDeps = {},
  ) {}

  async run(argv: string[]): Promise<void> {
    const args = argv.slice(2);
    // 全局 --verbose 标志
    const verboseIdx = args.indexOf('--verbose');
    if (verboseIdx >= 0) {
      enableVerbose();
      args.splice(verboseIdx, 1);
    }
    // 跳过更新检查的命令
    const cmd = args[0] || '';
    const noUpdateCheck = UPDATE_SKIP_COMMANDS.has(cmd);
    const executablePath = (this.deps.getExecutablePath ?? (() => process.argv[1]))();

    try {
      let output = await this.dispatch(args);
      
      // 检查更新（排除 version/help 命令）
      if (!noUpdateCheck) {
        const updateMsg = (this.deps.checkForUpdate ?? checkForUpdate)(executablePath);
        if (updateMsg) {
          output = output + ' ' + updateMsg;
        }
      }
      
      process.stdout.write(output + '\n');
    } catch (e) {
      process.stderr.write('错误: ' + (e instanceof Error ? e.message : e) + '\n');
      process.exitCode = 1;
    }
  }

  private async dispatch(args: string[]): Promise<string> {
    const [cmd, ...rest] = args;
    const s = this.service;

    // version 命令单独处理
    if (cmd === 'version') {
      const executablePath = (this.deps.getExecutablePath ?? (() => process.argv[1]))();
      const version = (this.deps.getCurrentVersion ?? getCurrentVersion)(executablePath);
      if (version === '0.0.0') return 'FlowPilot vunknown';
      return 'FlowPilot v' + version;
    }

    switch (cmd) {
      case 'init': {
        const force = rest.includes('--force');
        const md = await (this.deps.readStdinIfPiped ?? readStdinIfPiped)();
        let out;
        if (md.trim()) {
          const data = await s.init(md, force);
          out = '已初始化工作流: ' + data.name + ' (' + data.tasks.length + ' 个任务)';
        } else {
          const client = await (this.deps.promptSetupClient ?? promptSetupClient)();
          out = await s.setup(client);
        }
        return out + '\n\n提示: 建议先通过 /plugin 安装插件 superpowers、frontend-design、feature-dev、code-review、context7，未安装则子Agent无法使用专业技能，功能会降级';
      }

      case 'next': {
        if (rest.includes('--batch')) {
          const items = await s.nextBatch();
          if (!items.length) return '全部完成';
          return formatBatch(items);
        }
        const result = await s.next();
        if (!result) return '全部完成';
        return formatTask(result.task, result.context);
      }

      case 'checkpoint': {
        const id = rest[0];
        if (!id) throw new Error('需要任务ID');
        const parsed = await parseDetailAndFiles(rest, this.deps.readStdinIfPiped ?? readStdinIfPiped);
        return await s.checkpoint(id, parsed.detail, parsed.files);
      }

      case 'adopt': {
        const id = rest[0];
        if (!id) throw new Error('需要任务ID');
        const parsed = await parseDetailAndFiles(rest, this.deps.readStdinIfPiped ?? readStdinIfPiped);
        return await s.adopt(id, parsed.detail, parsed.files);
      }

      case 'restart': {
        const id = rest[0];
        if (!id) throw new Error('需要任务ID');
        return await s.restart(id);
      }

      case 'skip': {
        const id = rest[0];
        if (!id) throw new Error('需要任务ID');
        return await s.skip(id);
      }

      case 'status': {
        const data = await s.status();
        if (!data) return '无活跃工作流';
        return formatStatus(data);
      }

      case 'pulse': {
        const id = rest[0];
        if (!id) throw new Error('需要任务ID');
        // 解析 phase 参数
        let phase: string = 'analysis';
        const phaseIdx = rest.indexOf('--phase');
        if (phaseIdx >= 0 && rest[phaseIdx + 1]) {
          phase = rest[phaseIdx + 1];
        } else if (rest.length > 1 && !rest[1].startsWith('--')) {
          phase = rest[1];
        }
        // 中文别名映射
        const phaseMap: Record<string, string> = {
          '分析': 'analysis',
          '实施': 'implementation',
          '验证': 'verification',
          '阻塞': 'blocked',
        };
        const normalizedPhase = phaseMap[phase] || phase;
        const validPhases = ['analysis', 'implementation', 'verification', 'blocked'];
        if (!validPhases.includes(normalizedPhase)) {
          throw new Error(`无效的 phase: ${phase}，可选值: analysis, implementation, verification, blocked`);
        }
        // 解析 note 参数
        let note = '';
        const noteIdx = rest.indexOf('--note');
        if (noteIdx >= 0 && rest[noteIdx + 1]) {
          note = rest.slice(noteIdx + 1).join(' ');
        } else if (rest.length > 2 && !rest[2].startsWith('--')) {
          note = rest.slice(2).join(' ');
        }
        return await s.pulse(id, normalizedPhase as any, note);
      }

      case 'review':
        return await s.review();

      case 'finish':
        return await s.finish();

      case 'resume':
        return await s.resume();

      case 'abort':
        return await s.abort();

      case 'rollback': {
        const id = rest[0];
        if (!id) throw new Error('需要任务ID');
        return await s.rollback(id);
      }

      case 'evolve': {
        const text = await (this.deps.readStdinIfPiped ?? readStdinIfPiped)();
        if (!text.trim()) throw new Error('需要通过 stdin 传入反思结果');
        return await s.evolve(text.trim());
      }

      case 'recall': {
        const query = rest.join(' ');
        if (!query) throw new Error('需要查询关键词');
        return await s.recall(query);
      }

      case 'add': {
        if (rest.includes('--help') || rest.includes('-h')) {
          return ADD_USAGE;
        }
        const typeIdx = rest.indexOf('--type');
        const rawType = (typeIdx >= 0 && rest[typeIdx + 1]) || 'general';
        const type = VALID_TASK_TYPES.has(rawType) ? rawType : 'general';
        const title = rest
          .filter((_, i) => typeIdx < 0 || (i !== typeIdx && i !== typeIdx + 1))
          .join(' ');
        if (!title) throw new Error('需要任务描述');
        return await s.add(title, type as any);
      }

      default:
        return USAGE;
    }
  }
}

const USAGE = '用法: node flow.js [--verbose] <command>\n  init [--force]       初始化工作流\n  next [--batch]       获取下一个待执行任务\n  checkpoint <id>      记录任务完成\n  adopt <id>           接管变更\n  restart <id>         任务重做\n  skip <id>            跳过任务\n  review               标记 review 完成\n  finish               收尾\n  status               查看进度\n  resume               恢复\n  abort                中止\n  rollback <id>        回滚\n  evolve               反思\n  recall <关键词>        记忆查询\n  add <描述>           追加任务\n  version              版本\n\n全局选项:\n  --verbose            调试日志';
const ADD_USAGE = '用法: node flow.js add <描述> [--type frontend|backend|general]\n示例:\n  node flow.js add "修复支付回调重试"\n  node flow.js add "补上线检查项" --type backend';
