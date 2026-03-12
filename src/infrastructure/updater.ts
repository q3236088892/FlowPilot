/**
 * @module infrastructure/updater
 * @description 自动更新检查和下载模块
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

const REPO_OWNER = '6BNBN';
const REPO_NAME = 'FlowPilot';
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  checkedAt: number;
  latestVersion: string;
  currentVersion: string;
  hasUpdate: boolean;
}

function getCachePath(): string {
  return join(process.cwd(), '.flowpilot', 'update-cache.json');
}

function getCurrentVersion(): string {
  try {
    const cwd = process.cwd();
    const flowPath = existsSync(join(cwd, 'flow.js')) 
      ? join(cwd, 'flow.js') 
      : join(cwd, 'dist', 'flow.js');
    if (existsSync(flowPath)) {
      const content = readFileSync(flowPath, 'utf-8');
      const match = content.match(/\/\/ FLOWPILOT_VERSION:\s*(\d+\.\d+\.\d+)/);
      if (match) return match[1];
    }
  } catch {}
  return '0.0.0';
}

function getFlowPath(): string {
  const cwd = process.cwd();
  return existsSync(join(cwd, 'flow.js')) 
    ? join(cwd, 'flow.js') 
    : join(cwd, 'dist', 'flow.js');
}

function parseVersion(version: string): number[] {
  return version.replace(/^v/, '').split('.').map(Number);
}

function compareVersions(current: string, latest: string): boolean {
  const cur = parseVersion(current);
  const lat = parseVersion(latest);
  for (let i = 0; i < 3; i++) {
    const c = cur[i] || 0;
    const l = lat[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

function fetchLatestInfo(): { version: string; url: string } | null {
  try {
    const apiUrl = 'https://api.github.com/repos/' + REPO_OWNER + '/' + REPO_NAME + '/releases/latest';
    const cmd = 'curl -s -H "Accept: application/vnd.github+json" "' + apiUrl + '"';
    const result = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
    const data = JSON.parse(result);
    const version = data.tag_name ? data.tag_name.replace(/^v/, '') : null;
    if (!version) return null;
    
    const flowAsset = data.assets ? data.assets.find((a: any) => a.name === 'flow.js') : null;
    const downloadUrl = flowAsset 
      ? flowAsset.browser_download_url 
      : 'https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/main/dist/flow.js';
    
    return { version, url: downloadUrl };
  } catch {
    return null;
  }
}

function downloadUpdate(url: string, version: string): boolean {
  try {
    const flowPath = getFlowPath();
    console.error('正在下载新版本...');
    
    const cmd = 'curl -s -L "' + url + '"';
    const content = execSync(cmd, { encoding: 'utf-8', timeout: 60000 });
    
    const shebang = '#!/usr/bin/env node';
    if (content.indexOf(shebang) === -1) {
      console.error('下载的文件不是有效的 flow.js');
      return false;
    }
    
    // 直接写入下载的内容
    writeFileSync(flowPath, content);
    console.error('已更新到 v' + version + '，请重新运行命令');
    return true;
  } catch (e) {
    console.error('下载失败: ' + e);
    return false;
  }
}

function loadCache(): UpdateCache | null {
  const cachePath = getCachePath();
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, 'utf-8'));
  } catch {
    return null;
  }
}

function saveCache(cache: UpdateCache): void {
  const cachePath = getCachePath();
  const dir = dirname(cachePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2));
}

export function checkForUpdate(): boolean | null {
  const currentVersion = getCurrentVersion();
  if (currentVersion === '0.0.0') return null;

  const cache = loadCache();
  const now = Date.now();

  if (cache && now - cache.checkedAt < CACHE_DURATION_MS) {
    if (cache.hasUpdate) {
      console.error('\n发现新版本: v' + cache.latestVersion + ' (当前: v' + cache.currentVersion + ')');
      const downloaded = downloadUpdate(
        'https://raw.githubusercontent.com/' + REPO_OWNER + '/' + REPO_NAME + '/main/dist/flow.js',
        cache.latestVersion
      );
      return downloaded ? true : null;
    }
    return false;
  }

  const latestInfo = fetchLatestInfo();
  if (!latestInfo) {
    if (cache) return null;
    const failedCache: UpdateCache = {
      checkedAt: now,
      latestVersion: currentVersion,
      currentVersion,
      hasUpdate: false,
    };
    saveCache(failedCache);
    return null;
  }

  const hasUpdate = compareVersions(currentVersion, latestInfo.version);
  const newCache: UpdateCache = {
    checkedAt: now,
    latestVersion: latestInfo.version,
    currentVersion,
    hasUpdate,
  };
  saveCache(newCache);

  if (hasUpdate) {
    console.error('\n发现新版本: v' + latestInfo.version + ' (当前: v' + currentVersion + ')');
    const downloaded = downloadUpdate(latestInfo.url, latestInfo.version);
    return downloaded ? true : null;
  }
  
  return false;
}
