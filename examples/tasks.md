# Tasks: 个人博客系统

## Phase 1: 基础设施

### T001 - 初始化项目脚手架
- files: package.json, vite.config.ts
- [x] 初始化 Vite + Vue 3 + TypeScript 项目

### T002 - 配置 Tailwind CSS [P]
- depends: T001
- files: tailwind.config.js, src/style.css
- [x] 集成 Tailwind CSS 4.0

### T003 - 配置路由系统
- depends: T001
- files: src/router/index.ts
- [x] 实现 vue-router 路由

## Phase 2: 用户认证

### T004 - 创建 User 数据模型
- files: src/types/User.ts, src/api/user.ts
- [x] 定义 User 接口和 API 封装

### T005 - 实现登录页面
- depends: T003, T004
- files: src/views/Login.vue, src/components/LoginForm.vue
- [ ] 实现登录表单和 JWT 鉴权

### T006 - 实现注册页面 [P]
- depends: T004
- files: src/views/Register.vue
- [ ] 实现注册表单和验证

## Phase 3: 文章管理

### T007 - 创建 Post 数据模型
- depends: T004
- files: src/types/Post.ts, src/api/post.ts
- [x] 定义 Post 接口和 CRUD API

### T008 - 实现文章列表页
- depends: T003, T007
- files: src/views/Posts.vue, src/components/PostList.vue, src/components/Pagination.vue
- [ ] 实现分页文章列表

### T009 - 实现文章详情页
- depends: T007
- files: src/views/PostDetail.vue, src/components/MarkdownRenderer.vue
- [ ] 实现 Markdown 渲染和目录

### T010 - 实现文章编辑器 [P]
- depends: T007
- files: src/views/PostEditor.vue, src/components/MarkdownEditor.vue
- [ ] 实现富文本编辑和草稿保存

## Phase 4: 评论系统

### T011 - 创建 Comment 数据模型
- depends: T007
- files: src/types/Comment.ts, src/api/comment.ts
- [ ] 定义 Comment 接口和 API

### T012 - 实现评论组件
- depends: T011
- files: src/components/CommentList.vue, src/components/CommentForm.vue
- [ ] 实现评论列表和发表

## Phase 5: 后台管理

### T013 - 实现管理后台布局
- depends: T005
- files: src/views/admin/Layout.vue, src/views/admin/Dashboard.vue
- [ ] 实现后台侧边栏和数据看板

### T014 - 实现文章管理
- depends: T008, T013
- files: src/views/admin/Posts.vue
- [ ] 实现文章增删改查

## Phase 6: 部署优化

### T015 - 性能优化
- files: vite.config.ts
- [ ] 代码分割、懒加载、图片优化

### T016 - SEO 优化
- depends: T009
- files: index.html, src/router/index.ts
- [ ] meta 标签、sitemap、SSR 预渲染
