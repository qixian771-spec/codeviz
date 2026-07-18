/**
 * project-manager.js - 管理多个项目
 * 一个服务监听多个项目目录
 */

const path = require('path');
const fs = require('fs');

class ProjectManager {
  constructor() {
    this.projects = new Map(); // projectId -> { id, name, root, tasksPath }
  }

  /**
   * 添加项目
   * @param {string} projectRoot - 项目根目录绝对路径
   * @param {string} tasksFile - tasks.md 相对路径，默认查 specs 目录或 tasks.md
   * @returns {Object} 项目信息
   */
  addProject(projectRoot, tasksFile) {
    const absRoot = path.resolve(projectRoot);
    const projectId = this._generateProjectId(absRoot);
    const projectName = path.basename(absRoot);

    // 自动查找 tasks.md
    const tasksPath = tasksFile
      ? path.resolve(absRoot, tasksFile)
      : this._findTasksMd(absRoot);

    const project = {
      id: projectId,
      name: projectName,
      root: absRoot,
      tasksPath,
      addedAt: new Date().toISOString()
    };

    this.projects.set(projectId, project);
    return project;
  }

  /**
   * 自动查找 tasks.md
   * 优先级：specs 目录下的 tasks.md > 根目录 tasks.md > .specify/tasks.md
   */
  _findTasksMd(root) {
    const candidates = [
      'tasks.md',
      '.specify/tasks.md',
      'specs/tasks.md'
    ];

    // 扫 specs/ 目录
    try {
      const specsDir = path.join(root, 'specs');
      if (fs.existsSync(specsDir) && fs.statSync(specsDir).isDirectory()) {
        const entries = fs.readdirSync(specsDir);
        for (const entry of entries) {
          const candidate = path.join('specs', entry, 'tasks.md');
          if (fs.existsSync(path.join(root, candidate))) {
            return path.resolve(root, candidate);
          }
        }
      }
    } catch (e) {
      // ignore
    }

    // 试默认候选
    for (const candidate of candidates) {
      const fullPath = path.join(root, candidate);
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    }

    // 没找到，返回默认值（可能不存在，启动时报错）
    return path.join(root, 'tasks.md');
  }

  _generateProjectId(root) {
    // 用路径的 hash 当 ID
    let hash = 0;
    for (let i = 0; i < root.length; i++) {
      const char = root.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `proj-${Math.abs(hash).toString(36)}`;
  }

  getProject(id) {
    return this.projects.get(id);
  }

  listProjects() {
    return Array.from(this.projects.values());
  }

  removeProject(id) {
    return this.projects.delete(id);
  }
}

module.exports = { ProjectManager };
