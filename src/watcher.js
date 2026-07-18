/**
 * watcher.js - 监听 tasks.md 和代码文件变化
 * 用 Node fs.watch（递归监听），降级到非递归，再降级到 mtime 轮询
 */

const fs = require('fs');
const path = require('path');

class FileWatcher {
  /**
   * @param {string} projectRoot - 项目根目录
   * @param {Function} onChange - 回调 (event) => void
   *   event: { type: 'tasks'|'code', file: string, projectRoot: string }
   */
  constructor(projectRoot, onChange) {
    this.projectRoot = projectRoot;
    this.onChange = onChange;
    this.watchers = [];
    this.debounceTimer = null;
    /** @type {Set<string>} 轮询监听的文件列表 */
    this._pollFiles = new Set();
    /** @type {Map<string, number>} 文件上次 mtime（毫秒） */
    this._pollMtimes = new Map();
    /** @type {ReturnType<typeof setInterval>|null} 轮询定时器 */
    this._pollTimer = null;
  }

  start() {
    try {
      // 递归监听整个项目（排除 node_modules / .git）
      const watcher = fs.watch(
        this.projectRoot,
        { recursive: true },
        (eventType, filename) => {
          if (!filename) return;

          // 过滤噪音
          if (this._shouldIgnore(filename)) return;

          this._debounce({
            type: filename.endsWith('tasks.md') ? 'tasks' : 'code',
            file: filename,
            projectRoot: this.projectRoot
          });
        }
      );

      this.watchers.push(watcher);
    } catch (e) {
      // recursive watch 在某些系统不支持，降级到非递归
      console.error('[codeviz] 递归监听失败，尝试非递归:', e.message);
      this._startNonRecursive();
    }
  }

  _startNonRecursive() {
    try {
      const watcher = fs.watch(this.projectRoot, (eventType, filename) => {
        if (!filename || this._shouldIgnore(filename)) return;
        this._debounce({
          type: filename.endsWith('tasks.md') ? 'tasks' : 'code',
          file: filename,
          projectRoot: this.projectRoot
        });
      });
      this.watchers.push(watcher);
    } catch (e) {
      // 非递归也失败，降级到 mtime 轮询
      console.error('[codeviz] 非递归监听也失败，降级到 mtime 轮询:', e.message);
      this._startPolling();
    }
  }

  /**
   * 基于 mtime 的轮询降级方案
   * 每 2 秒检查一次关注文件列表的 mtime 变化
   */
  _startPolling() {
    if (this._pollTimer) return; // 已在轮询

    // 自动添加 tasks.md 到关注列表
    const tasksPath = path.join(this.projectRoot, 'tasks.md');
    this._pollFiles.add(tasksPath);

    // 也检查常见子目录下的 tasks.md
    const specsTasksPath = path.join(this.projectRoot, 'specs', 'tasks.md');
    this._pollFiles.add(specsTasksPath);

    // 初始化 mtime
    for (const filePath of this._pollFiles) {
      this._updateMtime(filePath);
    }

    this._pollTimer = setInterval(() => {
      for (const filePath of this._pollFiles) {
        try {
          const stat = fs.statSync(filePath);
          const mtime = stat.mtimeMs;
          const prevMtime = this._pollMtimes.get(filePath);

          if (prevMtime !== undefined && mtime !== prevMtime) {
            const relative = path.relative(this.projectRoot, filePath);
            this._debounce({
              type: relative.endsWith('tasks.md') ? 'tasks' : 'code',
              file: relative,
              projectRoot: this.projectRoot
            });
          }

          this._pollMtimes.set(filePath, mtime);
        } catch (e) {
          // 文件不存在或不可访问，跳过
        }
      }
    }, 2000);
  }

  /**
   * 添加文件到轮询关注列表
   * @param {string} filePath - 文件绝对路径
   */
  addWatchFile(filePath) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    this._pollFiles.add(absPath);
    this._updateMtime(absPath);
    // 如果还没有启动轮询但文件列表不为空，且没有 watcher 在工作，启动轮询
    if (!this._pollTimer && this.watchers.length === 0) {
      this._startPolling();
    }
  }

  /**
   * 从轮询关注列表移除文件
   * @param {string} filePath - 文件绝对路径
   */
  removeWatchFile(filePath) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    this._pollFiles.delete(absPath);
    this._pollMtimes.delete(absPath);
  }

  /**
   * 更新文件的初始 mtime
   * @param {string} filePath
   */
  _updateMtime(filePath) {
    try {
      const stat = fs.statSync(filePath);
      this._pollMtimes.set(filePath, stat.mtimeMs);
    } catch (e) {
      // 文件不存在时不记录 mtime
    }
  }

  _shouldIgnore(filename) {
    const ignored = [
      'node_modules/',
      '.git/',
      '.DS_Store',
      'dist/',
      'build/',
      '.next/',
      '.cache/'
    ];
    return ignored.some(prefix => filename.includes(prefix));
  }

  _debounce(event) {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.onChange(event);
      this.debounceTimer = null;
    }, 300); // 300ms 防抖
  }

  stop() {
    this.watchers.forEach(w => {
      try { w.close(); } catch (e) {}
    });
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // 清理轮询定时器
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._pollFiles.clear();
    this._pollMtimes.clear();
  }
}

module.exports = { FileWatcher };
