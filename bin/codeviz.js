#!/usr/bin/env node
/**
 * codeviz.js - 启动入口
 * 用法: node bin/codeviz.js [project-root...] [--port 7878] [--no-open]
 */

const path = require('path');
const fs = require('fs');
const { ProjectManager } = require('../src/project-manager');
const { FileWatcher } = require('../src/watcher');
const { createServer, createProjectPayload, PORT: defaultPort } = require('../src/server');

function parseArgs(argv) {
  const args = { projects: [], port: defaultPort, open: true };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      args.port = parseInt(argv[i + 1], 10);
      i++;
    } else if (arg === '--no-open') {
      args.open = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
CodeViz - 给 Spec Kit 补上可视化

用法:
  node bin/codeviz.js [project-root...] [--port 7878] [--no-open]

参数:
  project-root    项目根目录，可传多个。不传则用当前目录
  --port PORT     服务端口，默认 7878
  --no-open       只启动服务，不自动打开浏览器

示例:
  node bin/codeviz.js                                  # 监听当前目录
  node bin/codeviz.js ~/projects/blog                  # 监听指定项目
  node bin/codeviz.js ~/proj/a ~/proj/b --port 8080    # 监听多项目
  node bin/codeviz.js examples --port 7879 --no-open   # 启动示例服务
`);
      process.exit(0);
    } else if (!arg.startsWith('--')) {
      args.projects.push(arg);
    }
  }
  if (args.projects.length === 0) {
    args.projects.push(process.cwd());
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const projectManager = new ProjectManager();

  // 添加所有项目
  for (const root of args.projects) {
    const absRoot = path.resolve(root);
    if (!fs.existsSync(absRoot)) {
      console.error(`[codeviz] 目录不存在: ${absRoot}`);
      continue;
    }
    const project = projectManager.addProject(absRoot);
    console.log(`[codeviz] 已添加项目: ${project.name}`);
    console.log(`         路径: ${project.root}`);
    console.log(`         tasks: ${project.tasksPath}`);

    if (!fs.existsSync(project.tasksPath)) {
      console.warn(`[codeviz] ⚠ tasks.md 不存在，会等它被创建`);
    }
  }

  if (projectManager.listProjects().length === 0) {
    console.error('[codeviz] 没有可监听的项目，已退出');
    process.exit(1);
  }

  // 启动服务
  const { server, broadcast } = createServer(projectManager);
  server.listen(args.port, () => {
    const url = `http://localhost:${args.port}`;
    console.log(`\n[codeviz] ✓ 服务已启动`);
    console.log(`         浏览器打开: ${url}`);
    console.log(`         按 Ctrl+C 停止\n`);

    if (args.open) {
      try {
        const { exec } = require('child_process');
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} ${url}`, () => {});
      } catch (e) {}
    }
  });

  // 为每个项目启动监听
  const watchers = [];
  for (const project of projectManager.listProjects()) {
    const watcher = new FileWatcher(project.root, async (event) => {
      // 文件变了，重新解析 + 推断 + 广播
      try {
        if (!fs.existsSync(project.tasksPath)) return;
        const payload = await createProjectPayload(project, { useGit: true, useFiles: true });

        broadcast({
          type: 'tasks.updated',
          ...payload
        });
      } catch (e) {
        // 静默失败，避免噪音
      }
    });
    watcher.start();
    watchers.push(watcher);
  }

  // 优雅退出
  process.on('SIGINT', () => {
    console.log('\n[codeviz] 正在停止...');
    watchers.forEach(w => w.stop());
    server.close();
    process.exit(0);
  });
}

main().catch(e => {
  console.error('[codeviz] 启动失败:', e);
  process.exit(1);
});
