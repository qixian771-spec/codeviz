/**
 * git-tracker.js - 抓 git commit 记录
 * 零依赖，用 child_process 调 git 命令
 */

const { execFile } = require('child_process');
const path = require('path');

/**
 * 内存缓存：key 为 projectRoot，value 为 { data, ts }
 * @type {Map<string, {data: Array, ts: number}>}
 */
const _commitCache = new Map();

/** 缓存有效期（毫秒） */
const CACHE_TTL = 5000;

/**
 * 清除指定项目的 commit 缓存
 * @param {string} projectRoot - 项目根目录
 */
function clearCommitCache(projectRoot) {
  _commitCache.delete(projectRoot);
}

/**
 * execFile 的 Promise 包装
 * @param {string} file
 * @param {string[]} args
 * @param {Object} options
 * @returns {Promise<string>}
 */
function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) return reject(error);
      resolve(stdout);
    });
  });
}

/**
 * 获取项目最近 N 条 commit
 * @param {string} projectRoot - 项目根目录
 * @param {number} limit - 最多取多少条
 * @returns {Promise<Array<{hash: string, message: string, author: string, date: string, files: string[]}>>}
 */
async function getRecentCommits(projectRoot, limit = 50) {
  // 检查缓存
  const cached = _commitCache.get(projectRoot);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL) {
    return cached.data;
  }

  try {
    const logOutput = await execFileAsync(
      'git',
      ['log', '--name-status', '--pretty=format:COMMIT:%H|%an|%ad|%s', '-n', String(limit)],
      { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 }
    );

    const trimmed = (logOutput || '').trim();
    if (!trimmed) {
      _commitCache.set(projectRoot, { data: [], ts: Date.now() });
      return [];
    }

    const commits = [];
    let currentCommit = null;

    const lines = trimmed.split('\n');
    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed) continue;

      if (lineTrimmed.startsWith('COMMIT:')) {
        const payload = lineTrimmed.substring(7);
        const [hash, author, date, ...msgParts] = payload.split('|');
        currentCommit = {
          hash: hash.trim(),
          author: author.trim(),
          date: date.trim(),
          message: msgParts.join('|').trim(),
          files: []
        };
        commits.push(currentCommit);
      } else if (currentCommit) {
        // --name-status 输出格式例如: "M\tpath/to/file" 或 "A\tpath/to/file"
        const parts = lineTrimmed.split(/\s+/);
        if (parts.length >= 2) {
          currentCommit.files.push(parts[1].trim());
        } else {
          currentCommit.files.push(lineTrimmed);
        }
      }
    }

    // 写入缓存
    _commitCache.set(projectRoot, { data: commits, ts: Date.now() });
    return commits;
  } catch (e) {
    // 不是 git 仓库或 git 命令失败
    return [];
  }
}

/**
 * 从 commit 消息中提取任务 ID
 * 支持 T001、T01、T1 等格式
 * @param {string} message
 * @returns {Array<string>}
 */
function extractTaskIds(message) {
  const ids = [];
  const regex = /T0*(\d+)/gi;
  let match;
  while ((match = regex.exec(message)) !== null) {
    ids.push(`T${match[1].padStart(3, '0')}`);
  }
  return ids;
}

/**
 * 判断 commit 是否跟某个任务相关
 * @param {Object} commit
 * @param {Object} task - { id, files }
 * @returns {boolean}
 */
function isCommitRelatedToTask(commit, task) {
  // 1. commit 消息提到任务 ID
  const idsInMessage = extractTaskIds(commit.message);
  if (idsInMessage.includes(task.id)) return true;

  // 2. commit 改了任务关联的文件
  if (task.files && task.files.length > 0) {
    return task.files.some(taskFile =>
      commit.files.some(commitFile => {
        const normTask = path.normalize(taskFile).toLowerCase();
        const normCommit = path.normalize(commitFile).toLowerCase();
        return normCommit === normTask || normCommit.endsWith(normTask) || normTask.endsWith(normCommit);
      })
    );
  }

  return false;
}

/**
 * 获取 git status 中新增/修改的文件
 * @param {string} projectRoot
 * @returns {Promise<Array<{xy: string, path: string, isNew: boolean, isModified: boolean}>>}
 */
async function getGitStatus(projectRoot) {
  try {
    const output = await execFileAsync(
      'git',
      ['status', '--porcelain', '-u'],
      { cwd: projectRoot, encoding: 'utf-8', timeout: 5000 }
    );
    const result = [];
    for (const line of (output || '').split('\n')) {
      if (!line.trim()) continue;
      const xy = line.substring(0, 2);
      // git 有时会用引号包裹含非 ASCII 字符的路径
      const raw = line.substring(3).trim().replace(/^"(.+)"$/, '$1');
      if (!raw) continue;
      result.push({
        xy: xy.trim(),
        path: raw,
        isNew: xy.includes('A') || xy.includes('?'),
        isModified: xy.includes('M') || xy.includes('R')
      });
    }
    return result;
  } catch (e) {
    return [];
  }
}

module.exports = { getRecentCommits, extractTaskIds, isCommitRelatedToTask, clearCommitCache, getGitStatus };
