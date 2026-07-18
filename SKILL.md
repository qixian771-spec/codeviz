---
name: codeviz
description: 给 Spec Kit 补上缺失的可视化——把 tasks.md 渲染成实时进度导图
color: purple
emoji: 📊
commands:
  - name: "/codeviz"
    description: "启动并打开 CodeViz 进度可视化面板"
    action: "node /Users/niuniu/Workbuddy/2026-07-03-05-24-57/codeviz-skill/bin/codeviz.js"
trigger:
  - 开始可视化
  - 显示进度
  - 打开导图
  - 可视化项目
  - 看看进度
---

# CodeViz Skill

给 Spec Kit 补上那块缺失的可视化。Spec Kit 把"一问到底生成 tasks.md"做完了，但完全没有可视化界面——这个 skill 只补这一块。

## 这个 skill 解决什么问题

用 Claude Code / Codex / Gemini 等 CLI 写代码时，**看不到项目整体进度**。tasks.md 是个纯文本文件，得自己脑补哪个完成了哪个没完成。

CodeViz 把 tasks.md 渲染成实时导图，文件一变导图就更新，让你在第二块屏幕上一眼看到全局。

## 什么时候触发

用户说这些话时触发：
- "开始可视化"
- "显示进度"
- "打开导图"
- "可视化项目"
- "看看进度"

## 怎么用

### 步骤 1：确保有 tasks.md

如果项目已经用了 Spec Kit，跑过 `/speckit.tasks`，那 tasks.md 已经在 `specs/NNN-xxx/tasks.md` 了。

如果没有，可以让用户先创建一个简单的 tasks.md（参考 examples/tasks.md）。

### 步骤 2：启动可视化

进入 `codeviz-skill/` 后执行：

```bash
node bin/codeviz.js
```

或者监听指定项目：

```bash
node bin/codeviz.js /path/to/project
```

也可以一次监听多个项目：

```bash
node bin/codeviz.js ~/projects/blog ~/projects/shop --port 7878
```

服务会在 `http://localhost:7878` 启动，并自动打开浏览器。

### 步骤 3：边开发边看

- 你（CLI）继续写代码、改 tasks.md
- 浏览器里的导图会实时刷新
- 任务颜色会变化：
  - 灰色 = 未开始
  - 黄色 = 进行中（文件已创建 或 有相关 commit）
  - 绿色 = 已完成（tasks.md 里标了 `[x]`）
  - 红色 = 报错

## tasks.md 怎么写

兼容 Spec Kit 格式，也支持两种常见 Markdown 任务写法：

### 标题式

```markdown
# Tasks: 项目名

## Phase 1: 阶段名

### T001 - 任务标题
- files: src/file1.ts, src/file2.ts
- depends: T000
- [ ] 任务描述（未完成）
```

### 清单式（Spec Kit 常见）

```markdown
# Tasks: 项目名

## Phase 1: 阶段名

- [ ] T001 [P] 初始化项目 files: package.json, src/main.ts
- depends: T000
- [x] T002 - 配置路由 depends: T001
```

字段说明：
- `T001`：任务 ID（可选，没有会自动生成）
- `[P]`：可并行标记（写在标题或清单项里）
- `files:`：关联文件，skill 靠这个判断进度
- `depends:`：依赖的任务 ID
- `[ ]` / `[x]`：未完成 / 已完成

## 进度推断逻辑

skill 综合三个信号判断每个任务状态，优先级从高到低：

1. **tasks.md 手动标记**（`[x]` → done，`[ ]` → 看 2、3）
2. **git commit 记录**（commit 消息提到任务 ID 或改了关联文件 → in-progress）
3. **文件是否存在**（关联文件存在 → in-progress）

## 多项目

一个服务能同时监听多个项目：

```bash
node bin/codeviz.js ~/projects/blog ~/projects/shop
```

浏览器左侧会出现项目列表，点击切换。

## 自检

CodeViz 是零 npm 依赖项目，内置一个冒烟测试：

```bash
node tests/smoke.test.js
```

也可以跑语法检查：

```bash
node --check bin/codeviz.js
node --check templates/client.js
```

如果已有 `npm`，也可以用：

```bash
npm test
npm run check
```

## 文件结构

```
codeviz-skill/
├── SKILL.md              ← 本文件
├── bin/
│   └── codeviz.js        ← 启动入口
├── src/
│   ├── server.js         ← HTTP + WebSocket 服务
│   ├── watcher.js        ← 文件监听
│   ├── parser.js         ← tasks.md 解析
│   ├── inferencer.js     ← 进度推断
│   ├── git-tracker.js    ← git commit 抓取
│   └── project-manager.js ← 多项目管理
├── templates/
│   ├── index.html        ← 导图网页
│   └── client.js         ← 浏览器客户端
└── examples/
    └── tasks.md          ← 示例任务文件
```

## 技术栈

- Node.js 22（零 npm 依赖，全用内置模块）
- 原生 HTML/CSS/JS（不引前端框架）
- WebSocket 实时通信

## 跟 Spec Kit 的关系

- Spec Kit 负责"规划"和"执行"：生成 spec/plan/tasks，跑 implement
- CodeViz 只负责"看"：读 tasks.md，渲染导图，监听变化

两者完全解耦，互不干扰。CodeViz 不替代 Spec Kit 的任何功能。

## 限制（v1）

- 不自动跑测试（v2 加）
- 不收集浏览器报错（v2 加）
- 没有看板视图，只有树状导图（v2 加）
- 不会帮你生成 tasks.md（这是 Spec Kit 的活）
