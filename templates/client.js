/**
 * client.js - CodeViz 实时进度导图前端
 * 零依赖，负责项目选择、任务渲染、自动布局、SVG 流动连线和 WebSocket 更新。
 */

class CodeVizClient {
  constructor() {
    this.ws = null;
    this.projects = [];
    this.currentProjectId = null;
    this.currentProjectName = '';
    this.phases = [];
    this.tasks = [];
    this.stats = { total: 0, done: 0, ready: 0, pending: 0, inProgress: 0, error: 0 };
    this.reconnectDelay = 1000;
    this.lastStatusById = new Map();
    this.resizeTimer = null;
    this.themeChoice = localStorage.getItem('codeviz-theme') || 'system';
    this.viewMode = localStorage.getItem('codeviz-view') || 'map'; // 'map' | 'kanban'

    // Zoom/pan state. The #viewport layer is CSS-transformed by translate()+scale().
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.minScale = 0.2;
    this.maxScale = 2.5;
    this.contentHeight = 0;
    this.isPanning = false;
    this._panStart = null;
    this._minimapDragging = false;
    this._transformScheduled = false;
    this._hoveredTaskId = null;

    this.dom = {
      projectSelect: document.getElementById('project-select'),
      stats: document.getElementById('stats'),
      ringFill: document.getElementById('ring-fill'),
      ringText: document.getElementById('ring-text'),
      conn: document.getElementById('conn'),
      status: document.getElementById('status'),
      canvas: document.getElementById('canvas'),
      viewport: document.getElementById('viewport'),
      phaseLayer: document.getElementById('phase-layer'),
      nodeLayer: document.getElementById('node-layer'),
      linesGroup: document.getElementById('flow-lines'),
      particlesGroup: document.getElementById('flow-particles'),
      error: document.getElementById('error'),
      themeToggle: document.getElementById('theme-toggle'),
      viewToggle: document.getElementById('view-toggle'),
      zoomIn: document.getElementById('zoom-in'),
      zoomOut: document.getElementById('zoom-out'),
      zoomReset: document.getElementById('zoom-reset'),
      zoomLevel: document.getElementById('zoom-level'),
      minimap: document.getElementById('minimap'),
      minimapCanvas: document.getElementById('minimap-canvas'),
      minimapViewport: document.getElementById('minimap-viewport')
    };
  }

  async start() {
    this.applyTheme();
    this.bindEvents();
    await this.loadProjects();
    this.connect();
  }

  bindEvents() {
    if (this.dom.projectSelect) {
      this.dom.projectSelect.addEventListener('change', () => {
        this.loadProject(this.dom.projectSelect.value);
      });
    }

    if (this.dom.viewToggle) {
      this.dom.viewToggle.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-view]');
        if (!btn) return;
        this.viewMode = btn.dataset.view;
        localStorage.setItem('codeviz-view', this.viewMode);
        this.applyViewToggle();
        this.render(false);
      });
      this.applyViewToggle(); // 初始化按钮状态
    }

    if (this.dom.themeToggle) {
      this.dom.themeToggle.addEventListener('click', (event) => {
        const button = event.target.closest('[data-theme-choice]');
        if (!button) return;
        this.themeChoice = button.dataset.themeChoice;
        localStorage.setItem('codeviz-theme', this.themeChoice);
        this.applyTheme();
      });
    }

    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    systemTheme.addEventListener('change', () => {
      if (this.themeChoice === 'system') this.applyTheme();
    });

    window.addEventListener('resize', () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => {
        // 窗口宽度变化可能触发宽/窄布局切换，需要完整重排
        if (this.tasks.length) {
          this.render(false);
        } else {
          this.drawLines();
        }
        this.updateMinimap();
      }, 150);
    });

    this.bindZoomPan();
    this.bindMinimap();
    this.bindNodeHover();
  }

  applyViewToggle() {
    if (!this.dom.viewToggle) return;
    this.dom.viewToggle.querySelectorAll('[data-view]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === this.viewMode);
    });
    // 看板模式隐藏导图专属控件
    const mapOnly = ['zoom-controls', 'minimap'];
    mapOnly.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = this.viewMode === 'kanban' ? 'none' : '';
    });
  }

  renderKanban() {
    if (!this.dom.canvas) return;

    // 清除导图层
    if (this.dom.phaseLayer) this.dom.phaseLayer.innerHTML = '';
    if (this.dom.nodeLayer) this.dom.nodeLayer.innerHTML = '';
    this.clearLines();

    // 移除旧看板（如有）
    const old = this.dom.canvas.querySelector('.kanban-view');
    if (old) old.remove();
    this.removeEmpty();

    if (!this.tasks.length) {
      this.renderEmpty('还没有任务', '先创建 tasks.md，CodeViz 会把它渲染成看板。');
      return;
    }

    const columns = [
      { key: 'pending',     label: '未开始', cls: 'col-pending' },
      { key: 'ready',       label: '就绪',   cls: 'col-ready' },
      { key: 'in-progress', label: '进行中', cls: 'col-progress' },
      { key: 'done',        label: '完成',   cls: 'col-done' },
      { key: 'error',       label: '报错',   cls: 'col-error' }
    ];

    const phaseById = new Map();
    (this.phases || []).forEach((p, i) => phaseById.set(p.id, p.name || `Phase ${i + 1}`));

    const wrap = document.createElement('div');
    wrap.className = 'kanban-view';
    wrap.style.width = '100%';

    for (const col of columns) {
      const tasks = this.tasks.filter(t => this.normalizeStatus(t.status) === col.key);

      const colEl = document.createElement('div');
      colEl.className = `kanban-col ${col.cls}`;

      colEl.innerHTML = `
        <div class="kanban-col-header">
          <span class="col-dot"></span>${this.escape(col.label)}
          <span class="col-count">${tasks.length}</span>
        </div>
        <div class="kanban-cards"></div>
      `;

      const cardsEl = colEl.querySelector('.kanban-cards');
      for (const task of tasks) {
        const card = document.createElement('div');
        card.className = `kanban-card ${col.key}`;
        const phaseName = phaseById.get(task.phase) || '';
        const phaseLabel = phaseName ? `<div class="kc-phase">${this.escape(this.cleanPhaseName(phaseName))}</div>` : '';
        card.innerHTML = `
          <div class="kc-id">${this.escape(task.id || '')}</div>
          <div class="kc-name">${this.escape(task.name || task.description || '未命名')}</div>
          ${phaseLabel}
        `;
        card.title = this.buildNodeTitle(task);
        cardsEl.appendChild(card);
      }

      wrap.appendChild(colEl);
    }

    // 把看板插在 viewport 层之后（不影响导图的 DOM 结构）
    this.dom.canvas.appendChild(wrap);
  }

  // ---- Zoom / Pan ----

  bindZoomPan() {
    const canvas = this.dom.canvas;
    if (!canvas) return;

    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      this.zoomAt(px, py, factor);
    }, { passive: false });

    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.node')) return;
      if (event.target.closest('.minimap') || event.target.closest('.zoom-controls')) return;
      this.isPanning = true;
      this._panStart = {
        x: event.clientX,
        y: event.clientY,
        tx: this.translateX,
        ty: this.translateY
      };
      canvas.classList.add('panning');
      event.preventDefault();
    });

    window.addEventListener('mousemove', (event) => {
      if (!this.isPanning || !this._panStart) return;
      this.translateX = this._panStart.tx + (event.clientX - this._panStart.x);
      this.translateY = this._panStart.ty + (event.clientY - this._panStart.y);
      this.clampTranslate();
      this.applyTransform();
    });

    window.addEventListener('mouseup', () => {
      if (this.isPanning) {
        this.isPanning = false;
        this._panStart = null;
        canvas.classList.remove('panning');
      }
    });

    canvas.classList.add('pannable');

    if (this.dom.zoomIn) this.dom.zoomIn.addEventListener('click', () => this.zoomByButton(1.2));
    if (this.dom.zoomOut) this.dom.zoomOut.addEventListener('click', () => this.zoomByButton(1 / 1.2));
    if (this.dom.zoomReset) this.dom.zoomReset.addEventListener('click', () => this.resetView());
  }

  zoomByButton(factor) {
    const canvas = this.dom.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    this.zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  // Zoom keeping the point (px, py) in canvas space fixed on screen.
  zoomAt(px, py, factor) {
    const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    if (newScale === this.scale) return;
    const wx = (px - this.translateX) / this.scale;
    const wy = (py - this.translateY) / this.scale;
    this.scale = newScale;
    this.translateX = px - wx * this.scale;
    this.translateY = py - wy * this.scale;
    this.clampTranslate();
    this.applyTransform();
  }

  resetView() {
    this.scale = 1;
    this.translateX = 0;
    this.translateY = 0;
    this.applyTransform();
  }

  clampTranslate() {
    const canvas = this.dom.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const contentW = rect.width * this.scale;
    const contentH = Math.max(this.contentHeight, rect.height) * this.scale;
    const margin = 120;
    const minTx = Math.min(0, rect.width - contentW) - margin;
    const maxTx = margin;
    const minTy = Math.min(0, rect.height - contentH) - margin;
    const maxTy = margin;
    this.translateX = Math.max(minTx, Math.min(maxTx, this.translateX));
    this.translateY = Math.max(minTy, Math.min(maxTy, this.translateY));
  }

  applyTransform() {
    if (this._transformScheduled) return;
    this._transformScheduled = true;
    requestAnimationFrame(() => {
      this._transformScheduled = false;
      if (this.dom.viewport) {
        this.dom.viewport.style.transform =
          `translate(${this.translateX}px, ${this.translateY}px) scale(${this.scale})`;
      }
      if (this.dom.zoomLevel) {
        this.dom.zoomLevel.textContent = `${Math.round(this.scale * 100)}%`;
      }
      this.updateMinimapViewport();
    });
  }

  connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.setStatus('实时', 'online');
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch (e) {
        this.showError('实时消息解析失败: ' + e.message);
      }
    };

    this.ws.onclose = () => {
      this.setStatus('重连中', 'connecting');
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 5000);
    };

    this.ws.onerror = () => {
      this.setStatus('离线', 'offline');
    };
  }

  handleMessage(msg) {
    if (msg.type !== 'tasks.updated') return;
    if (this.currentProjectId && msg.projectId !== this.currentProjectId) return;

    this.currentProjectId = msg.projectId;
    this.currentProjectName = msg.projectName || this.currentProjectName;
    this.phases = Array.isArray(msg.phases) ? msg.phases : this.groupPhasesFromTasks(msg.tasks || []);
    this.tasks = Array.isArray(msg.tasks) ? msg.tasks : [];
    this.stats = msg.stats || this.computeStats(this.tasks);
    this.hideError();
    this.render(true);
  }

  async loadProjects() {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      this.projects = data.projects || [];
      this.renderProjectSelect();

      if (this.projects.length > 0) {
        await this.loadProject(this.projects[0].id);
      } else {
        this.renderEmpty('还没有项目', '启动 CodeViz 时传入一个项目目录，例如 node bin/codeviz.js /path/to/project');
      }
    } catch (e) {
      this.showError('项目列表加载失败: ' + e.message);
    }
  }

  renderProjectSelect() {
    if (!this.dom.projectSelect) return;
    if (this.projects.length === 0) {
      this.dom.projectSelect.innerHTML = '<option>无项目</option>';
      return;
    }

    this.dom.projectSelect.innerHTML = this.projects.map(project => (
      `<option value="${this.escapeAttr(project.id)}">${this.escape(project.name)}</option>`
    )).join('');
  }

  async loadProject(projectId) {
    if (!projectId) return;
    this.currentProjectId = projectId;
    if (this.dom.projectSelect) this.dom.projectSelect.value = projectId;

    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
      const data = await res.json();
      if (!res.ok || data.error) {
        this.showError(data.error || '任务加载失败');
        this.renderEmpty('找不到 tasks.md', data.error || '请先在项目根目录或 specs 目录创建 tasks.md');
        return;
      }

      this.currentProjectName = data.projectName || '';
      this.phases = Array.isArray(data.phases) ? data.phases : this.groupPhasesFromTasks(data.tasks || []);
      this.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      this.stats = data.stats || this.computeStats(this.tasks);
      this.hideError();
      this.render(false);
    } catch (e) {
      this.showError('任务加载失败: ' + e.message);
    }
  }

  render(animateChanges = false) {
    this.renderStats();
    if (this.viewMode === 'kanban') {
      this.renderKanban();
    } else {
      this.renderMap(animateChanges);
    }
  }

  renderStats() {
    const stats = this.stats || this.computeStats(this.tasks);
    const total = stats.total || 0;
    const done = stats.done || 0;
    const ready = stats.ready || 0;
    const inProgress = stats.inProgress || 0;
    const error = stats.error || 0;
    const pending = Math.max(0, stats.pending ?? (total - done - ready - inProgress - error));
    const percent = total > 0 ? Math.round((done / total) * 100) : 0;

    if (this.dom.stats) {
      this.dom.stats.innerHTML = `
        <div class="stat-pill done"><span class="dot"></span>完成 <span class="num">${done}</span></div>
        <div class="stat-pill ready"><span class="dot"></span>就绪 <span class="num">${ready}</span></div>
        <div class="stat-pill progress"><span class="dot"></span>进行中 <span class="num">${inProgress}</span></div>
        <div class="stat-pill error"><span class="dot"></span>报错 <span class="num">${error}</span></div>
        <div class="stat-pill pending"><span class="dot"></span>未开始 <span class="num">${pending}</span></div>
      `;
    }

    if (this.dom.ringFill) {
      const circumference = 113.1;
      const offset = circumference - (circumference * percent / 100);
      this.dom.ringFill.setAttribute('stroke-dashoffset', String(offset));
    }
    if (this.dom.ringText) this.dom.ringText.textContent = `${percent}%`;
  }

  renderMap(animateChanges) {
    if (!this.dom.canvas || !this.dom.phaseLayer || !this.dom.nodeLayer) return;

    // 切回导图时清除看板
    const oldKanban = this.dom.canvas.querySelector('.kanban-view');
    if (oldKanban) oldKanban.remove();

    this.dom.phaseLayer.innerHTML = '';
    this.dom.nodeLayer.innerHTML = '';
    this.clearLines();

    if (!this.tasks.length) {
      this.renderEmpty('还没有任务', '先创建或导入 Spec Kit 的 tasks.md，CodeViz 就会把它变成进度图。');
      return;
    }

    this.removeEmpty();

    const layout = this.computeLayout();

    // 设置 canvas 内容层的最小高度，确保能容纳所有节点
    const contentHeight = layout.contentHeight || 0;
    this.contentHeight = contentHeight;
    this.dom.canvas.style.minHeight = contentHeight + 'px';
    this.dom.phaseLayer.style.height = contentHeight + 'px';
    this.dom.nodeLayer.style.height = contentHeight + 'px';

    // SVG 也要跟着撑高
    const flowSvg = this.dom.canvas.querySelector('.flow');
    if (flowSvg) {
      flowSvg.style.height = contentHeight + 'px';
    }

    layout.phases.forEach(phaseBox => this.dom.phaseLayer.appendChild(this.createPhaseElement(phaseBox)));
    layout.nodes.forEach((nodeBox, index) => this.dom.nodeLayer.appendChild(this.createNodeElement(nodeBox, index, animateChanges)));

    requestAnimationFrame(() => {
      this.drawLines();
      this.updateMinimap();
    });
    this.lastStatusById = new Map(this.tasks.map(task => [task.id, this.normalizeStatus(task.status)]));
  }

  computeLayout() {
    const phaseSource = this.normalizePhases();
    const phaseCount = Math.max(phaseSource.length, 1);

    // 像素常量
    const NODE_HEIGHT = 95;       // 节点卡片高度（含 padding）
    const NODE_GAP = 12;          // 节点之间最小垂直间距
    const NODE_STEP = NODE_HEIGHT + NODE_GAP;  // 每个节点占的垂直空间
    const PHASE_TOP_PAD = 46;     // Phase 区域内，第一个节点距顶部（留空给 label）
    const PHASE_BOTTOM_PAD = 20;  // Phase 区域底部留白
    const CANVAS_TOP = 10;        // 距 canvas 顶部的初始间距
    const SECTION_GAP = 18;       // 窄屏单列模式下 Phase 之间的间距

    const canvasWidth = this.dom.canvas ? this.dom.canvas.clientWidth : window.innerWidth;
    const narrowMode = canvasWidth < 760;

    const phases = [];
    const nodes = [];
    let maxContentBottom = 0;

    if (narrowMode) {
      // 小窗口/内嵌预览：纵向单列，节点用像素宽度确保不溢出。
      const phaseLeft = 0;
      const phaseWidth = 100;
      const canvasPad = 16;
      const nodeWidth = Math.max(120, Math.min(220, canvasWidth - canvasPad * 2 - 20));
      const nodeLeft = canvasPad;
      let currentTop = CANVAS_TOP;

      phaseSource.forEach((phase, phaseIndex) => {
        const phaseTasks = this.tasks.filter(task => (task.phase || 'phase-1') === phase.id);
        const phaseStatus = this.getPhaseStatus(phaseTasks);
        const taskCount = Math.max(phaseTasks.length, 1);
        const phaseContentHeight = PHASE_TOP_PAD + taskCount * NODE_STEP + PHASE_BOTTOM_PAD;

        phases.push({
          ...phase,
          left: phaseLeft,
          topPx: currentTop,
          width: phaseWidth,
          heightPx: phaseContentHeight,
          status: phaseStatus
        });

        phaseTasks.forEach((task, taskIndex) => {
          const nodeTopPx = currentTop + PHASE_TOP_PAD + taskIndex * NODE_STEP;
          nodes.push({
            task,
            phase,
            left: nodeLeft,
            topPx: nodeTopPx,
            width: nodeWidth,
            narrowMode: true,
            delay: phaseIndex * 90 + taskIndex * 55
          });
          maxContentBottom = Math.max(maxContentBottom, nodeTopPx + NODE_HEIGHT);
        });

        maxContentBottom = Math.max(maxContentBottom, currentTop + phaseContentHeight);
        currentTop += phaseContentHeight + SECTION_GAP;
      });

      return { phases, nodes, contentHeight: maxContentBottom + 90, narrowMode };
    }

    // 宽屏：横向阶段布局 + 拓扑排序 + 重心排序
    const gapPercent = phaseCount > 6 ? 1 : (phaseCount > 4 ? 2 : 3);
    const side = 1;
    const widthPercent = Math.max(14, (100 - side * 2 - gapPercent * (phaseCount - 1)) / phaseCount);

    // 对同一阶段内的任务进行拓扑排序（Kahn's Algorithm）
    const sortedTasksByPhase = this._topoSortByPhase(phaseSource);

    phaseSource.forEach((phase, phaseIndex) => {
      const left = side + phaseIndex * (widthPercent + gapPercent);
      const phaseTasks = sortedTasksByPhase.get(phase.id) || [];
      const phaseStatus = this.getPhaseStatus(phaseTasks);
      const taskCount = Math.max(phaseTasks.length, 1);

      // Phase 高度由任务数决定（像素）
      const phaseContentHeight = PHASE_TOP_PAD + taskCount * NODE_STEP + PHASE_BOTTOM_PAD;

      phases.push({
        ...phase,
        left,
        topPx: CANVAS_TOP,
        width: widthPercent,
        heightPx: phaseContentHeight,
        status: phaseStatus
      });

      // 节点左偏移（百分比）
      const nodeLeft = left + Math.max(1.0, Math.min(3.0, widthPercent * 0.15));

      phaseTasks.forEach((task, taskIndex) => {
        const nodeTopPx = CANVAS_TOP + PHASE_TOP_PAD + taskIndex * NODE_STEP;
        nodes.push({
          task,
          phase,
          left: nodeLeft,
          topPx: nodeTopPx,
          delay: phaseIndex * 90 + taskIndex * 55
        });
        maxContentBottom = Math.max(maxContentBottom, nodeTopPx + NODE_HEIGHT);
      });

      maxContentBottom = Math.max(maxContentBottom, CANVAS_TOP + phaseContentHeight);
    });

    // 重心排序（Barycenter Heuristic）：根据前置节点的平均 Y 坐标重排同列节点
    this._barycentricReorder(nodes, phases, NODE_STEP, PHASE_TOP_PAD, CANVAS_TOP);

    // 内容总高度（给 canvas 滚动用）
    const contentHeight = maxContentBottom + 40; // 底部多留 40px

    return { phases, nodes, contentHeight, narrowMode };
  }

  /**
   * 按 Phase 对任务进行拓扑排序（Kahn's Algorithm）
   * 有环依赖时优雅降级（保持原始顺序）
   * @param {Array} phaseSource - Phase 列表
   * @returns {Map<string, Array>} phase.id → 排序后的任务数组
   */
  _topoSortByPhase(phaseSource) {
    const result = new Map();
    const allTasksById = new Map(this.tasks.map(t => [t.id, t]));

    phaseSource.forEach(phase => {
      const phaseTasks = this.tasks.filter(task => (task.phase || 'phase-1') === phase.id);

      if (phaseTasks.length <= 1) {
        result.set(phase.id, phaseTasks);
        return;
      }

      // 构建该 Phase 内的局部依赖图
      const phaseTaskIds = new Set(phaseTasks.map(t => t.id));
      const inDegree = new Map();
      const adjacency = new Map(); // from → [to]

      for (const task of phaseTasks) {
        inDegree.set(task.id, 0);
        adjacency.set(task.id, []);
      }

      for (const task of phaseTasks) {
        const deps = Array.isArray(task.depends) ? task.depends : [];
        for (const depId of deps) {
          // 只看同一 Phase 内的依赖
          if (phaseTaskIds.has(depId)) {
            adjacency.get(depId).push(task.id);
            inDegree.set(task.id, (inDegree.get(task.id) || 0) + 1);
          }
        }
      }

      // Kahn's Algorithm
      const queue = [];
      for (const task of phaseTasks) {
        if ((inDegree.get(task.id) || 0) === 0) {
          queue.push(task.id);
        }
      }

      const sorted = [];
      while (queue.length > 0) {
        const current = queue.shift();
        sorted.push(current);
        for (const neighbor of (adjacency.get(current) || [])) {
          const deg = (inDegree.get(neighbor) || 1) - 1;
          inDegree.set(neighbor, deg);
          if (deg === 0) {
            queue.push(neighbor);
          }
        }
      }

      // 有环降级：未排入的节点追加到末尾（保持原始顺序）
      if (sorted.length < phaseTasks.length) {
        const sortedSet = new Set(sorted);
        for (const task of phaseTasks) {
          if (!sortedSet.has(task.id)) {
            sorted.push(task.id);
          }
        }
      }

      // 按排序后的顺序重建任务数组
      const taskById = new Map(phaseTasks.map(t => [t.id, t]));
      result.set(phase.id, sorted.map(id => taskById.get(id)));
    });

    return result;
  }

  /**
   * 重心排序（Barycenter Heuristic）
   * 每个节点的"重心"= 它所依赖的前置节点的平均 Y 坐标
   * 按重心值从小到大排列节点，减少连线交叉
   * @param {Array} nodes - 已排好的节点数组（会被原地修改 topPx）
   * @param {Array} phases - Phase 布局数组
   * @param {number} NODE_STEP
   * @param {number} PHASE_TOP_PAD
   * @param {number} CANVAS_TOP
   */
  _barycentricReorder(nodes, phases, NODE_STEP, PHASE_TOP_PAD, CANVAS_TOP) {
    // 建立 taskId → node 的映射
    const nodeByTaskId = new Map();
    for (const node of nodes) {
      nodeByTaskId.set(node.task.id, node);
    }

    // 按 phase 分组
    const phaseGroups = new Map();
    for (const node of nodes) {
      const phaseId = node.phase.id;
      if (!phaseGroups.has(phaseId)) phaseGroups.set(phaseId, []);
      phaseGroups.get(phaseId).push(node);
    }

    // 对每个 phase（除了第一个），按重心排序
    for (const [phaseId, groupNodes] of phaseGroups) {
      if (groupNodes.length <= 1) continue;

      // 计算每个节点的重心
      const barycenters = [];
      let hasDeps = false;

      for (const node of groupNodes) {
        const deps = Array.isArray(node.task.depends) ? node.task.depends : [];
        const depYs = [];
        for (const depId of deps) {
          const depNode = nodeByTaskId.get(depId);
          if (depNode) {
            depYs.push(depNode.topPx);
          }
        }

        if (depYs.length > 0) {
          hasDeps = true;
          const avgY = depYs.reduce((sum, y) => sum + y, 0) / depYs.length;
          barycenters.push({ node, barycenter: avgY });
        } else {
          // 没有依赖的节点保持当前位置作为重心
          barycenters.push({ node, barycenter: node.topPx });
        }
      }

      // 只有当该 phase 中有节点具有跨 phase 依赖时才重排
      if (!hasDeps) continue;

      // 按重心排序
      barycenters.sort((a, b) => a.barycenter - b.barycenter);

      // 重新分配 Y 坐标（保持同一 phase 内的间距不变）
      barycenters.forEach((entry, index) => {
        entry.node.topPx = CANVAS_TOP + PHASE_TOP_PAD + index * NODE_STEP;
      });
    }
  }

  normalizePhases() {
    if (this.phases && this.phases.length) {
      return this.phases.map((phase, index) => ({
        id: phase.id || `phase-${index + 1}`,
        name: this.cleanPhaseName(phase.name || `Phase ${index + 1}`)
      }));
    }

    const grouped = this.groupPhasesFromTasks(this.tasks);
    return grouped.length ? grouped : [{ id: 'phase-1', name: '任务' }];
  }

  groupPhasesFromTasks(tasks) {
    const ids = Array.from(new Set((tasks || []).map(task => task.phase || 'phase-1')));
    return ids.map((id, index) => ({ id, name: `Phase ${index + 1}` }));
  }

  getPhaseStatus(tasks) {
    if (!tasks.length) return 'pending';
    if (tasks.some(task => this.normalizeStatus(task.status) === 'error')) return 'blocked';
    if (tasks.some(task => this.normalizeStatus(task.status) === 'in-progress')) return 'active';
    if (tasks.every(task => this.normalizeStatus(task.status) === 'done')) return 'complete';
    return 'pending';
  }

  createPhaseElement(phaseBox) {
    const el = document.createElement('div');
    el.className = `phase-zone ${phaseBox.status === 'complete' ? 'complete' : phaseBox.status === 'active' ? 'active' : phaseBox.status === 'blocked' ? 'blocked' : ''}`;
    el.style.left = `${phaseBox.left}%`;
    el.style.top = `${phaseBox.topPx}px`;
    el.style.width = `${phaseBox.width}%`;
    el.style.height = `${phaseBox.heightPx}px`;
    el.innerHTML = `<span class="phase-zone-label"><span class="phase-dot"></span>${this.escape(this.formatPhaseLabel(phaseBox.name))}</span>`;
    return el;
  }

  createNodeElement(nodeBox, index, animateChanges) {
    const task = nodeBox.task;
    const status = this.normalizeStatus(task.status);
    const previousStatus = this.lastStatusById.get(task.id);
    const flash = animateChanges && previousStatus && previousStatus !== status ? ' flash' : '';
    const el = document.createElement('div');

    el.className = `node ${status}${flash}`;
    el.dataset.id = task.id;
    el.title = this.buildNodeTitle(task);

    // 窄屏单列模式下用像素定位宽度，避免百分比 + 固定 156px 冲突
    if (nodeBox.narrowMode) {
      el.style.left = `${nodeBox.left}px`;
      el.style.width = `${nodeBox.width}px`;
    } else {
      el.style.left = `${nodeBox.left}%`;
    }
    el.style.top = `${nodeBox.topPx}px`;
    el.style.animationDelay = `${nodeBox.delay || index * 45}ms`;

    const meta = this.getTaskMeta(task);
    const icon = this.getStatusIcon(status);
    el.innerHTML = `
      <span class="node-glow"></span>
      <div class="node-head">
        <span class="node-icon">${icon}</span>
        <span class="node-id">${this.escape(task.id || '')}</span>
        ${task.parallel ? '<span class="node-tag">P</span>' : ''}
      </div>
      <div class="node-name">${this.escape(task.name || task.description || '未命名任务')}</div>
      <div class="node-meta">${this.escape(meta)}</div>
    `;
    return el;
  }

  statusColor(status) {
    return {
      pending: '#52525b',
      ready: '#3b82f6',
      'in-progress': '#f59e0b',
      done: '#10b981',
      error: '#ef4444'
    }[this.normalizeStatus(status)] || '#52525b';
  }

  // Lazily ensure a <defs> exists inside #flow-lines' parent SVG to hold per-line gradients.
  ensureLineDefs() {
    const svg = this.dom.linesGroup ? this.dom.linesGroup.ownerSVGElement : null;
    if (!svg) return null;
    let defs = svg.querySelector('defs.flow-grad-defs');
    if (!defs) {
      defs = this.createSvg('defs', { class: 'flow-grad-defs' });
      svg.insertBefore(defs, svg.firstChild);
    }
    return defs;
  }

  drawLines() {
    if (!this.dom.canvas || !this.dom.linesGroup || !this.dom.particlesGroup) return;
    this.clearLines();

    const canvasRect = this.dom.canvas.getBoundingClientRect();
    if (!canvasRect.width || !canvasRect.height) return;

    const defs = this.ensureLineDefs();
    let lineIndex = 0;
    const tasksById = new Map(this.tasks.map(task => [task.id, task]));

    this.tasks.forEach(toTask => {
      const dependencies = Array.isArray(toTask.depends) ? toTask.depends : [];
      dependencies.forEach(fromId => {
        const fromTask = tasksById.get(fromId);
        if (!fromTask) return;

        const fromNode = this.dom.nodeLayer.querySelector(`[data-id="${CSS.escape(fromId)}"]`);
        const toNode = this.dom.nodeLayer.querySelector(`[data-id="${CSS.escape(toTask.id)}"]`);
        if (!fromNode || !toNode) return;

        const fromRect = fromNode.getBoundingClientRect();
        const toRect = toNode.getBoundingClientRect();
        // #viewport is CSS-scaled, so getBoundingClientRect() returns scaled screen
        // coords. The SVG lives inside #viewport and scales with it, so paths must use
        // UNSCALED viewport-space coords: subtract translate, then divide by scale.
        const s = this.scale || 1;
        const fromX = (fromRect.left + fromRect.width / 2 - canvasRect.left - this.translateX) / s;
        const fromY = (fromRect.top + fromRect.height / 2 - canvasRect.top - this.translateY) / s;
        const toX = (toRect.left + toRect.width / 2 - canvasRect.left - this.translateX) / s;
        const toY = (toRect.top + toRect.height / 2 - canvasRect.top - this.translateY) / s;
        const dx = toX - fromX;
        const cp1x = fromX + dx * 0.52;
        const cp1y = fromY;
        const cp2x = toX - dx * 0.52;
        const cp2y = toY;
        const d = `M ${fromX} ${fromY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${toX} ${toY}`;
        const status = this.normalizeStatus(toTask.status);
        const fromStatus = this.normalizeStatus(fromTask.status);

        // Per-line gradient: source status color -> target status color.
        const gradId = `grad-${lineIndex}`;
        if (defs) {
          const grad = this.createSvg('linearGradient', {
            id: gradId,
            gradientUnits: 'userSpaceOnUse',
            x1: String(fromX), y1: String(fromY),
            x2: String(toX), y2: String(toY)
          });
          grad.appendChild(this.createSvg('stop', { offset: '0%', 'stop-color': this.statusColor(fromStatus) }));
          grad.appendChild(this.createSvg('stop', { offset: '100%', 'stop-color': this.statusColor(status) }));
          defs.appendChild(grad);
        }

        const path = this.createSvg('path', {
          d,
          id: `flow-${lineIndex}`,
          class: `flow-line ${status === 'in-progress' ? 'active' : status}`,
          'data-from': fromId,
          'data-to': toTask.id
        });
        if (defs) path.style.stroke = `url(#${gradId})`;
        const marker = status === 'error' ? 'url(#arr-error)' : status === 'in-progress' ? 'url(#arr-active)' : status === 'done' ? 'url(#arr-done)' : status === 'ready' ? 'url(#arr-ready)' : 'url(#arr-flow)';
        if (marker) path.setAttribute('marker-end', marker);
        this.dom.linesGroup.appendChild(path);

        if (status !== 'done') {
          const count = status === 'in-progress' || status === 'error' ? 2 : 1;
          const duration = status === 'in-progress' ? 1500 : status === 'error' ? 1200 : 3000;
          for (let i = 0; i < count; i++) {
            const particle = this.createSvg('circle', {
              r: '2.5',
              class: `flow-particle ${status === 'in-progress' ? 'active' : status === 'error' ? 'error' : ''}`
            });
            const motion = this.createSvg('animateMotion', {
              dur: `${duration}ms`,
              repeatCount: 'indefinite',
              path: d,
              begin: `${i * (duration / count)}ms`
            });
            particle.appendChild(motion);
            this.dom.particlesGroup.appendChild(particle);
          }
        }

        lineIndex++;
      });
    });
  }

  clearLines() {
    if (this.dom.linesGroup) this.dom.linesGroup.innerHTML = '';
    if (this.dom.particlesGroup) this.dom.particlesGroup.innerHTML = '';
    const svg = this.dom.linesGroup ? this.dom.linesGroup.ownerSVGElement : null;
    const defs = svg ? svg.querySelector('defs.flow-grad-defs') : null;
    if (defs) defs.innerHTML = '';
  }

  createSvg(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
    return el;
  }

  renderEmpty(title, detail) {
    this.removeEmpty();
    this.clearLines();
    if (this.dom.phaseLayer) this.dom.phaseLayer.innerHTML = '';
    if (this.dom.nodeLayer) this.dom.nodeLayer.innerHTML = '';
    if (!this.dom.canvas) return;

    const el = document.createElement('div');
    el.className = 'empty';
    el.innerHTML = `<strong>${this.escape(title)}</strong><span>${this.escape(detail)}</span>`;
    this.dom.canvas.appendChild(el);
    this.renderStats();
  }

  removeEmpty() {
    if (!this.dom.canvas) return;
    this.dom.canvas.querySelectorAll('.empty').forEach(el => el.remove());
  }

  getTaskMeta(task) {
    if (task.errorMessage) return String(task.errorMessage).replace(/^[-\s]*/, '').slice(0, 34);
    if (task.relatedCommits && task.relatedCommits.length) return `${task.relatedCommits.length} commits`;
    if (task.fileStats) return `${task.fileStats.existing}/${task.fileStats.total} 文件`;
    if (task.files && task.files.length) return `${task.files.length} 文件`;
    if (task.lastCommitDate) return task.lastCommitDate.substring(0, 10);
    return task.description || '等待开始';
  }

  getStatusIcon(status) {
    return {
      pending: '○',
      ready: '◎',
      'in-progress': '◐',
      done: '✓',
      error: '✕'
    }[status] || '○';
  }

  normalizeStatus(status) {
    if (status === 'inProgress') return 'in-progress';
    if (status === 'in-progress' || status === 'done' || status === 'error' || status === 'ready') return status;
    return 'pending';
  }

  computeStats(tasks) {
    const stats = { total: tasks.length, done: 0, ready: 0, pending: 0, inProgress: 0, error: 0 };
    tasks.forEach(task => {
      const status = this.normalizeStatus(task.status);
      if (status === 'done') stats.done++;
      else if (status === 'in-progress') stats.inProgress++;
      else if (status === 'error') stats.error++;
      else if (status === 'ready') stats.ready++;
      else stats.pending++;
    });
    return stats;
  }

  cleanPhaseName(name) {
    return String(name).replace(/^Phase\s+\d+\s*[:：-]?\s*/i, '').trim() || name;
  }

  formatPhaseLabel(phaseBox) {
    const name = phaseBox && phaseBox.name != null ? phaseBox.name : phaseBox;
    const id = phaseBox && phaseBox.id != null ? phaseBox.id : null;
    const normalized = this.normalizePhases();
    let index = id != null ? normalized.findIndex(phase => phase.id === id) : -1;
    if (index < 0) index = normalized.findIndex(phase => phase.name === name);
    return index >= 0 ? `Phase ${index + 1} · ${name}` : name;
  }

  buildNodeTitle(task) {
    const lines = [
      `${task.id} - ${task.name}`,
      `状态: ${this.normalizeStatus(task.status)}`
    ];
    if (task.description) lines.push(task.description);
    if (task.files && task.files.length) lines.push('文件: ' + task.files.join(', '));
    if (task.depends && task.depends.length) lines.push('依赖: ' + task.depends.join(', '));
    return lines.join('\n');
  }

  applyTheme() {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const resolved = this.themeChoice === 'system' ? (systemDark ? 'dark' : 'light') : this.themeChoice;
    document.documentElement.dataset.theme = resolved;

    if (this.dom.themeToggle) {
      // 容错处理：不仅寻找子按钮，如果 themeToggle 本身有 data-theme-choice，也一并处理
      const buttons = Array.from(this.dom.themeToggle.querySelectorAll('[data-theme-choice]'));
      if (this.dom.themeToggle.hasAttribute('data-theme-choice')) {
        buttons.push(this.dom.themeToggle);
      }
      buttons.forEach(button => {
        button.classList.toggle('active', button.dataset.themeChoice === this.themeChoice);
      });
    }
  }

  setStatus(text, mode) {
    if (this.dom.status) this.dom.status.textContent = text;
    if (this.dom.conn) {
      this.dom.conn.classList.remove('offline', 'connecting');
      if (mode === 'offline') this.dom.conn.classList.add('offline');
      if (mode === 'connecting') this.dom.conn.classList.add('connecting');
    }
  }

  showError(message) {
    if (!this.dom.error) return;
    this.dom.error.textContent = message;
    this.dom.error.style.display = 'block';
  }

  hideError() {
    if (!this.dom.error) return;
    this.dom.error.style.display = 'none';
  }

  escape(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  escapeAttr(value) {
    return this.escape(value).replace(/"/g, '&quot;');
  }

  // ---- Hover highlight ----

  bindNodeHover() {
    const layer = this.dom.nodeLayer;
    if (!layer) return;
    layer.addEventListener('mouseover', (event) => {
      const node = event.target.closest('.node');
      if (!node) return;
      this.highlightLines(node.dataset.id);
    });
    layer.addEventListener('mouseout', (event) => {
      const node = event.target.closest('.node');
      if (!node) return;
      this.clearHighlight();
    });
  }

  highlightLines(taskId) {
    if (!taskId || !this.dom.linesGroup) return;
    this._hoveredTaskId = taskId;
    const paths = this.dom.linesGroup.querySelectorAll('.flow-line');
    paths.forEach(path => {
      const related = path.getAttribute('data-from') === taskId || path.getAttribute('data-to') === taskId;
      path.classList.toggle('hl', related);
      path.classList.toggle('dim', !related);
    });
  }

  clearHighlight() {
    this._hoveredTaskId = null;
    if (!this.dom.linesGroup) return;
    this.dom.linesGroup.querySelectorAll('.flow-line').forEach(path => {
      path.classList.remove('hl', 'dim');
    });
  }

  // ---- Minimap ----

  bindMinimap() {
    const minimap = this.dom.minimap;
    if (!minimap) return;
    const jump = (event) => {
      const rect = minimap.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      this.minimapJumpTo(mx, my, rect);
    };
    minimap.addEventListener('mousedown', (event) => {
      this._minimapDragging = true;
      jump(event);
      event.preventDefault();
    });
    window.addEventListener('mousemove', (event) => {
      if (!this._minimapDragging) return;
      jump(event);
    });
    window.addEventListener('mouseup', () => {
      this._minimapDragging = false;
    });
  }

  // Compute the content bounding box in unscaled viewport space from the node layer.
  minimapContentBox() {
    const canvas = this.dom.canvas;
    const width = canvas ? canvas.clientWidth : 0;
    const height = Math.max(this.contentHeight, canvas ? canvas.clientHeight : 0);
    return { width: Math.max(width, 1), height: Math.max(height, 1) };
  }

  updateMinimap() {
    const canvasEl = this.dom.minimapCanvas;
    const layer = this.dom.nodeLayer;
    if (!canvasEl || !layer) return;

    const box = this.minimapContentBox();
    const mmW = canvasEl.clientWidth || canvasEl.offsetWidth || 190;
    const mmH = canvasEl.clientHeight || canvasEl.offsetHeight || 132;
    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = Math.round(mmW * dpr);
    canvasEl.height = Math.round(mmH * dpr);
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, mmW, mmH);

    const pad = 6;
    const sx = (mmW - pad * 2) / box.width;
    const sy = (mmH - pad * 2) / box.height;
    const scale = Math.min(sx, sy);
    this._minimapScale = scale;
    this._minimapPad = pad;
    this._minimapBox = box;

    const nodes = layer.querySelectorAll('.node');
    nodes.forEach(node => {
      const status = node.classList.contains('done') ? 'done'
        : node.classList.contains('in-progress') ? 'in-progress'
        : node.classList.contains('error') ? 'error' : 'pending';
      ctx.fillStyle = this.statusColor(status);
      const x = pad + node.offsetLeft * scale;
      const y = pad + node.offsetTop * scale;
      const w = Math.max(2, node.offsetWidth * scale);
      const h = Math.max(2, node.offsetHeight * scale);
      ctx.fillRect(x, y, w, h);
    });

    this.updateMinimapViewport();
  }

  updateMinimapViewport() {
    const vp = this.dom.minimapViewport;
    const canvas = this.dom.canvas;
    if (!vp || !canvas || !this._minimapScale) return;

    const scale = this._minimapScale;
    const pad = this._minimapPad || 6;
    const s = this.scale || 1;
    const rect = canvas.getBoundingClientRect();

    // Visible region in unscaled viewport space.
    const viewX = -this.translateX / s;
    const viewY = -this.translateY / s;
    const viewW = rect.width / s;
    const viewH = rect.height / s;

    vp.style.left = (pad + viewX * scale) + 'px';
    vp.style.top = (pad + viewY * scale) + 'px';
    vp.style.width = (viewW * scale) + 'px';
    vp.style.height = (viewH * scale) + 'px';
  }

  minimapJumpTo(mx, my, rect) {
    const canvas = this.dom.canvas;
    if (!canvas || !this._minimapScale) return;
    const scale = this._minimapScale;
    const pad = this._minimapPad || 6;
    const s = this.scale || 1;

    // Minimap point -> unscaled content coordinate.
    const contentX = (mx - pad) / scale;
    const contentY = (my - pad) / scale;

    // Center the viewport on that content point.
    const canvasRect = canvas.getBoundingClientRect();
    this.translateX = canvasRect.width / 2 - contentX * s;
    this.translateY = canvasRect.height / 2 - contentY * s;
    this.clampTranslate();
    this.applyTransform();
  }
}

window.codevizClient = new CodeVizClient();
window.codevizClient.start();
