/**
 * server.js - HTTP + WebSocket 服务
 * 零 npm 依赖，用 Node 22 内置模块
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseTasksMd, getStats } = require('./parser');
const { inferProgress } = require('./inferencer');

const PORT = 7878;
const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

async function createProjectPayload(project, options = {}) {
  const { useGit = true, useFiles = true, fullScan = false } = options;
  const content = fs.readFileSync(project.tasksPath, 'utf-8');
  const { phases, tasks } = parseTasksMd(content);
  const inferred = await inferProgress(tasks, project.root, { useGit, useFiles, phases, fullScan });
  const stats = getStats(inferred);

  return {
    projectId: project.id,
    projectName: project.name,
    tasksPath: project.tasksPath,
    phases,
    tasks: inferred,
    stats,
    timestamp: new Date().toISOString()
  };
}

function createServer(projectManager) {
  const clients = new Set(); // WebSocket 客户端

  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');

    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;

    // API: 兼容旧前端：获取默认项目的任务导图
    // 旧版本 client.js 会请求 /api/map；保留该端点可以避免浏览器缓存旧 JS 时页面空白。
    if (pathname === '/api/map') {
      const project = projectManager.listProjects()[0];
      if (!project) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
      }
      try {
        const payload = await createProjectPayload(project);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'tasks.md not found at ' + project.tasksPath }));
      }
      return;
    }

    // API: 获取项目列表
    if (pathname === '/api/projects') {
      const projects = projectManager.listProjects().map(p => ({
        id: p.id,
        name: p.name,
        root: p.root,
        tasksPath: p.tasksPath
      }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ projects }));
      return;
    }

    // API: 获取某项目的任务
    const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tasks$/);
    if (projectMatch) {
      const projectId = projectMatch[1];
      const project = projectManager.getProject(projectId);
      if (!project) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
      }
      try {
        const payload = await createProjectPayload(project);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      } catch (e) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'tasks.md not found at ' + project.tasksPath }));
      }
      return;
    }

    // 静态文件
    serveStatic(req, res);
  });

  // WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    // Only accept version 13 (RFC 6455); reject anything else cleanly.
    const version = req.headers['sec-websocket-version'];
    const key = req.headers['sec-websocket-key'];
    if (!key || (version && String(version) !== '13')) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      handleWebSocket(req, socket);
    } catch (e) {
      try { socket.destroy(); } catch (err) {}
    }
  });

  function serveStatic(req, res) {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(TEMPLATES_DIR, filePath);

    // 安全：禁止路径穿越
    if (!filePath.startsWith(TEMPLATES_DIR)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    try {
      const content = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8'
      };
      res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.end(content);
    } catch (e) {
      res.statusCode = 404;
      res.end('Not found');
    }
  }

  function handleWebSocket(req, socket) {
    // 简单的 WebSocket 握手（Node 原生实现）
    const key = req.headers['sec-websocket-key'];
    const accept = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const client = { socket, isAlive: true };
    clients.add(client);

    const cleanup = () => {
      clients.delete(client);
      if (client.pingTimer) {
        clearInterval(client.pingTimer);
        client.pingTimer = null;
      }
    };

    socket.on('end', cleanup);
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    // 解析客户端帧：响应 ping、处理 close，其余数据帧忽略。
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      buffer = consumeFrames(buffer, socket, client, cleanup);
    });

    // 心跳：每 30s ping 一次；上一轮未回 pong 的连接判定为死连接并清理。
    client.pingTimer = setInterval(() => {
      if (!client.isAlive) {
        cleanup();
        try { socket.destroy(); } catch (e) {}
        return;
      }
      client.isAlive = false;
      try {
        sendControlFrame(socket, 0x9); // ping
      } catch (e) {
        cleanup();
      }
    }, 30000);
    if (client.pingTimer.unref) client.pingTimer.unref();
  }

  // 逐帧消费缓冲区，返回剩余未解析的字节。只处理客户端 -> 服务端方向。
  function consumeFrames(buffer, socket, client, cleanup) {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) === 0x80;
      let len = buffer[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < offset + 2) break;
        len = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buffer.length < offset + 8) break;
        // 忽略高 32 位（进度消息不可能这么大）
        len = buffer.readUInt32BE(offset + 4);
        offset += 8;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) break; // 帧未接收完整

      // 跳过 payload（我们不消费客户端数据内容），但需解析控制帧
      const frameEnd = offset + maskLen + len;

      if (opcode === 0x8) {
        // close：回一个 close 并清理
        try { sendControlFrame(socket, 0x8); } catch (e) {}
        cleanup();
        try { socket.end(); } catch (e) {}
        return Buffer.alloc(0);
      } else if (opcode === 0x9) {
        // ping：回 pong
        try { sendControlFrame(socket, 0xA); } catch (e) {}
      } else if (opcode === 0xA) {
        // pong：标记存活
        client.isAlive = true;
      }
      // 其余（文本/二进制）忽略

      buffer = buffer.slice(frameEnd);
    }
    return buffer;
  }

  // 发送无 payload 的控制帧（ping/pong/close）。
  function sendControlFrame(socket, opcode) {
    const header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
    header[1] = 0x00; // 无 payload、服务端不加 mask
    socket.write(header);
  }

  // 广播消息给所有客户端
  function broadcast(message) {
    const data = JSON.stringify(message);
    for (const client of clients) {
      try {
        sendWebSocketFrame(client.socket, data);
      } catch (e) {
        clients.delete(client);
      }
    }
  }

  function sendWebSocketFrame(socket, data) {
    const payload = Buffer.from(data);
    const payloadLen = payload.length;

    let header;
    if (payloadLen < 126) {
      header = Buffer.alloc(2);
      header[1] = payloadLen;
    } else if (payloadLen < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(payloadLen, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeUInt32BE(Math.floor(payloadLen / 0x100000000), 2);
      header.writeUInt32BE(payloadLen % 0x100000000, 6);
    }
    header[0] = 0x81; // FIN + text frame

    socket.write(Buffer.concat([header, payload]));
  }

  // 关闭服务前先销毁所有跟踪的 WebSocket 连接，否则残留连接会让 server.close() 挂起。
  const originalClose = server.close.bind(server);
  server.close = (cb) => {
    for (const client of clients) {
      if (client.pingTimer) {
        clearInterval(client.pingTimer);
        client.pingTimer = null;
      }
      try { client.socket.destroy(); } catch (e) {}
    }
    clients.clear();
    return originalClose(cb);
  };

  return { server, broadcast, clients };
}

module.exports = { createServer, createProjectPayload, PORT };
