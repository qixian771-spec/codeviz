#!/usr/bin/env node
/**
 * realtime.test.js - 验证 WebSocket 实时刷新广播
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { ProjectManager } = require('../src/project-manager');
const { createServer } = require('../src/server');

const testDir = path.join(__dirname, 'temp-project');
const testTasksMd = path.join(testDir, 'tasks.md');

// 准备临时测试项目
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}
fs.writeFileSync(testTasksMd, `# Tasks: Demo
## Phase 1: Setup
- [ ] T001 Task 1
`);

async function testRealtimeBroadcast() {
  const manager = new ProjectManager();
  const project = manager.addProject(testDir);

  const { server, broadcast, clients } = createServer(manager);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  console.log(`[test] 临时测试服务启动于端口 ${port}`);

  // 用原生 HTTP client 模拟 WebSocket 握手
  const wsKey = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    port,
    host: '127.0.0.1',
    path: '/ws', // 必须传 /ws 否则会被 server.on('upgrade') 里 if (req.url !== '/ws') 拒绝
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': wsKey,
      'Sec-WebSocket-Version': '13'
    }
  });

  const wsConnected = new Promise((resolve, reject) => {
    req.on('upgrade', (res, socket) => {
      // 成功握手
      resolve(socket);
    });
    req.on('error', reject);
  });
  req.end();

  const socket = await wsConnected;
  console.log('[test] WebSocket 模拟连接成功');

  // 等待握手完成，客户端列表同步
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(clients.size, 1, 'Server should have 1 connected client');

  // 模拟文件变化，触发广播
  const messagePromise = new Promise((resolve) => {
    socket.on('data', (chunk) => {
      // 解析 WebSocket 帧的文本内容（简化解析：不带 mask 的 text frame）
      if (chunk[0] === 0x81) {
        let len = chunk[1] & 0x7f;
        let offset = 2;
        if (len === 126) {
          len = chunk.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          len = chunk.readUInt32BE(6); // 忽略高位直接读低 32 位
          offset = 10;
        }
        const data = chunk.slice(offset, offset + len).toString('utf-8');
        resolve(JSON.parse(data));
      }
    });
  });

  // 触发广播
  broadcast({
    type: 'tasks.updated',
    projectId: project.id,
    projectName: project.name,
    tasks: [{ id: 'T001', name: 'Task 1', status: 'in-progress' }]
  });

  const received = await messagePromise;
  assert.strictEqual(received.type, 'tasks.updated');
  assert.strictEqual(received.projectId, project.id);
  assert.strictEqual(received.tasks[0].status, 'in-progress');
  console.log('✓ WebSocket broadcast verified successfully');

  // 清理
  socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(testDir, { recursive: true, force: true });
}

testRealtimeBroadcast().then(() => {
  console.log('CodeViz realtime refresh tests passed.');
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
