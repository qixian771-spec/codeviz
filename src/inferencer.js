/**
 * inferencer.js - 自动推断任务进度
 * 综合四个信号：手动标记（tasks.md）> git commit > 文件存在 > git status 模糊匹配
 */

const fs = require('fs');
const path = require('path');
const { getRecentCommits, isCommitRelatedToTask, getGitStatus } = require('./git-tracker');

// 与 inferencer 无关的目录，扫描时跳过
const SCAN_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'Library', 'Temp', 'obj'];

// 值得关注的代码文件扩展名
const CODE_EXTS = new Set(['.cs', '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.cpp', '.c', '.h', '.unity', '.asset', '.prefab']);

/**
 * 把文件路径拆成小写 token 集合（camelCase 拆分 + 路径分段）
 * @param {string} filePath
 * @returns {Set<string>}
 */
function tokenizeFilePath(filePath) {
  const tokens = new Set();
  const parts = filePath.split(/[/\\]/);
  for (const part of parts) {
    const stem = part.replace(/\.[^.]+$/, ''); // 去扩展名
    // camelCase → 空格
    const words = stem
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_\-]+/)
      .map(w => w.toLowerCase())
      .filter(w => w.length >= 2);
    words.forEach(w => tokens.add(w));
  }
  return tokens;
}

/**
 * 从任务名提取英文 token（≥3 字符的英文单词）
 * @param {string} name
 * @returns {Set<string>}
 */
function tokenizeTaskName(name) {
  const tokens = new Set();
  if (!name) return tokens;
  const words = (name.match(/[a-zA-Z]{3,}/g) || []).map(w => w.toLowerCase());
  words.forEach(w => tokens.add(w));
  return tokens;
}

/**
 * 对一个文件路径打分，返回最匹配的任务和得分
 * 得分规则：
 *   10 — 文件名 stem 完全匹配 task.files 中某个声明文件的 stem
 *    5 — 文件名 stem 包含/被包含于声明文件 stem（部分匹配）
 *    2 — token 与任务名英文词重叠（每个词 +2）
 *    1 — token 与声明文件名词重叠（每个词 +1）
 * 阈值 >= 2 才算有效匹配
 *
 * @param {string} filePath
 * @param {Array} tasks
 * @returns {{ task: Object, score: number } | null}
 */
function fuzzyMatchFile(filePath, tasks) {
  const ext = path.extname(filePath).toLowerCase();
  if (!CODE_EXTS.has(ext)) return null;

  const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
  const fileTokens = tokenizeFilePath(filePath);

  let bestScore = 0;
  let bestTask = null;

  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'error') continue;

    let score = 0;

    // 1. 与声明文件的 stem 匹配
    for (const declaredFile of (task.files || [])) {
      const dStem = path.basename(declaredFile, path.extname(declaredFile)).toLowerCase();
      if (stem === dStem) {
        score = Math.max(score, 10);
      } else if (dStem.length >= 4 && (dStem.includes(stem) || stem.includes(dStem))) {
        score = Math.max(score, 5);
      }
    }

    // 2. token 与任务名英文词重叠
    const taskNameTokens = tokenizeTaskName(task.name);
    for (const ft of fileTokens) {
      if (taskNameTokens.has(ft)) score += 2;
    }

    // 3. token 与声明文件名词重叠
    for (const declaredFile of (task.files || [])) {
      const dTokens = tokenizeFilePath(declaredFile);
      for (const ft of fileTokens) {
        if (dTokens.has(ft)) score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestTask = task;
    }
  }

  return bestScore >= 2 ? { task: bestTask, score: bestScore } : null;
}

/**
 * 递归扫描项目目录，返回所有相关代码文件的相对路径列表
 * @param {string} projectRoot
 * @param {number} maxDepth
 * @returns {string[]}
 */
function scanProjectFiles(projectRoot, maxDepth = 10) {
  const results = [];
  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (SCAN_IGNORE.includes(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTS.has(ext)) {
          results.push(path.relative(projectRoot, fullPath));
        }
      }
    }
  }
  walk(projectRoot, 0);
  return results;
}

/**
 * Pass 3: 全项目文件扫描（启动时或按需执行）
 * 对项目内所有代码文件做模糊匹配，覆盖 git status 漏掉的已提交文件
 */
async function applyFullProjectScan(inferredTasks, projectRoot) {
  const files = scanProjectFiles(projectRoot);
  for (const filePath of files) {
    const match = fuzzyMatchFile(filePath, inferredTasks);
    if (!match) continue;
    const task = match.task;
    if (task.status === 'pending') task.status = 'in-progress';
    if (!task.autoDetectedFiles) task.autoDetectedFiles = [];
    if (!task.autoDetectedFiles.includes(filePath)) {
      task.autoDetectedFiles.push(filePath);
    }
  }
}

/**
 * 从 Phase 名称提取用于匹配 commit 消息的关键词
 * @param {string} phaseName
 * @returns {string[]}
 */
function extractPhaseKeywords(phaseName) {
  if (!phaseName) return [];
  const lower = phaseName.toLowerCase();
  const keywords = new Set([lower]);
  // 英文词 ≥ 4 字符
  const words = lower.match(/[a-z]{4,}/g) || [];
  words.forEach(w => keywords.add(w));
  // "phase N" 模式
  const numMatch = lower.match(/phase\s*(\d+)/);
  if (numMatch) {
    keywords.add(`phase${numMatch[1]}`);
    keywords.add(`phase ${numMatch[1]}`);
  }
  return [...keywords].filter(k => k.length >= 6);
}

/**
 * Pass 4: Phase 级 commit 关键词匹配
 * commit 消息含 Phase 名称关键词 → 该 Phase 所有 pending 任务标为 in-progress
 */
function applyPhaseKeywordMatch(inferredTasks, phases, commits) {
  if (!commits.length || !phases.length) return;

  const phaseMap = phases.map(phase => ({
    id: phase.id,
    keywords: extractPhaseKeywords(phase.name)
  }));

  for (const commit of commits) {
    const msg = (commit.message || '').toLowerCase();
    for (const { id: phaseId, keywords } of phaseMap) {
      if (!keywords.some(kw => msg.includes(kw))) continue;
      for (const task of inferredTasks) {
        if (task.phase !== phaseId || task.status !== 'pending') continue;
        task.status = 'in-progress';
        if (!task.relatedCommits) task.relatedCommits = [];
        task.relatedCommits.push({
          hash: commit.hash.substring(0, 7),
          message: commit.message,
          date: commit.date,
          matchedByPhase: true
        });
      }
    }
  }
}

/**
 * Pass 5: 依赖就绪推断（必须在所有状态赋值之后执行）
 * 前置任务全部 done → 当前 pending 任务标为 ready（蓝色）
 */
function applyReadyState(inferredTasks) {
  const taskById = new Map(inferredTasks.map(t => [t.id, t]));
  for (const task of inferredTasks) {
    if (task.status !== 'pending') continue;
    const deps = Array.isArray(task.depends) ? task.depends : [];
    if (deps.length === 0) continue;
    const allDepsDone = deps.every(depId => {
      const dep = taskById.get(depId);
      return dep && dep.status === 'done';
    });
    if (allDepsDone) task.status = 'ready';
  }
}

/**
 * Pass 2: 用 git status 的新增/修改文件做模糊匹配
 * 直接修改 inferredTasks（in-place）
 * @param {Array} inferredTasks
 * @param {string} projectRoot
 */
async function applyGitStatusScan(inferredTasks, projectRoot) {
  const statusFiles = await getGitStatus(projectRoot);
  if (!statusFiles.length) return;

  for (const { path: filePath } of statusFiles) {
    const match = fuzzyMatchFile(filePath, inferredTasks);
    if (!match) continue;

    const task = match.task;
    if (task.status === 'pending') task.status = 'in-progress';
    if (!task.autoDetectedFiles) task.autoDetectedFiles = [];
    if (!task.autoDetectedFiles.includes(filePath)) {
      task.autoDetectedFiles.push(filePath);
    }
  }
}

/**
 * 推断所有任务的当前状态
 * 五遍扫描（优先级从高到低）：
 *   Pass 1 — 手动标记 > git commit > 声明文件存在（per-task）
 *   Pass 2 — git status 模糊匹配（增量变更）
 *   Pass 3 — 全项目文件扫描（fullScan=true 时执行，覆盖已提交旧文件）
 *   Pass 4 — Phase 级 commit 关键词匹配
 *   Pass 5 — 依赖就绪推断（ready 状态，必须最后执行）
 *
 * @param {Array} tasks - 解析出来的任务列表
 * @param {string} projectRoot - 项目根目录
 * @param {Object} options - { useGit, useFiles, phases, fullScan }
 * @returns {Promise<Array>} 更新状态后的任务列表
 */
async function inferProgress(tasks, projectRoot, options = {}) {
  const { useGit = true, useFiles = true, phases = [], fullScan = false } = options;

  const commits = useGit ? await getRecentCommits(projectRoot, 100) : [];

  // --- Pass 1: 逐任务信号 ---
  const inferredTasks = tasks.map(task => {
    const inferred = { ...task };

    if (inferred.status === 'done' || inferred.status === 'error') return inferred;

    // git commit 匹配
    if (useGit && commits.length > 0) {
      const relatedCommits = commits.filter(c => isCommitRelatedToTask(c, inferred));
      if (relatedCommits.length > 0) {
        inferred.status = 'in-progress';
        inferred.relatedCommits = relatedCommits.slice(0, 5).map(c => ({
          hash: c.hash.substring(0, 7),
          message: c.message,
          date: c.date
        }));
        inferred.lastCommitDate = relatedCommits[0].date;
      }
    }

    // 声明文件是否存在
    if (useFiles && inferred.files && inferred.files.length > 0) {
      const existingFiles = inferred.files.filter(f => {
        const fullPath = path.resolve(projectRoot, f);
        try { return fs.existsSync(fullPath); } catch (e) { return false; }
      });
      inferred.fileStats = { total: inferred.files.length, existing: existingFiles.length };
      if (existingFiles.length > 0 && inferred.status === 'pending') inferred.status = 'in-progress';
      if (existingFiles.length === inferred.files.length && inferred.status === 'in-progress') {
        inferred.maybeDone = true;
      }
    }

    return inferred;
  });

  // --- Pass 2: git status 增量模糊扫描 ---
  if (useGit) await applyGitStatusScan(inferredTasks, projectRoot);

  // --- Pass 3: 全量文件扫描（启动时 or 按需） ---
  if (fullScan) await applyFullProjectScan(inferredTasks, projectRoot);

  // --- Pass 4: Phase 级 commit 关键词匹配 ---
  if (useGit && phases.length) applyPhaseKeywordMatch(inferredTasks, phases, commits);

  // --- Pass 5: 依赖就绪推断（必须最后） ---
  applyReadyState(inferredTasks);

  return inferredTasks;
}

module.exports = {
  inferProgress,
  fuzzyMatchFile,
  tokenizeFilePath,
  tokenizeTaskName,
  scanProjectFiles,
  applyReadyState,
  extractPhaseKeywords
};
