'use strict';

/**
 * TimeServer —— 时间服务器
 * =====================================================================
 * 提供三类时间能力：
 *  1. HTTP 静态站点托管（前端页面）
 *  2. HTTP 时间 API（/api/now、/api/sync，NTP 风格四时间戳对时）
 *  3. UDP SNTP 服务器（RFC 4330，可让 Windows / macOS 系统级对时）
 *
 * 启动：
 *    node server.js                 # HTTP :3000，SNTP 关闭
 *    ENABLE_SNTP=true node server.js  # 额外尝试 UDP :123（Windows 需管理员权限）
 *
 * 环境变量：
 *   PORT          HTTP 端口，默认 3000
 *   ENABLE_SNTP   'true' 时启用 UDP SNTP 服务
 *   SNTP_PORT     SNTP 端口，默认 123
 * =====================================================================
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const os = require('os');

/* ------------------------------------------------------------------ */
/* 常量与配置                                                          */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT) || 3000;
const ENABLE_SNTP = process.env.ENABLE_SNTP === 'true';
const SNTP_PORT = Number(process.env.SNTP_PORT) || 123;
const HOST = process.env.HOST || '0.0.0.0';

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

// RFC 4330：SNTP 时间戳纪元为 1900-01-01，与 Unix 纪元相差 2208988800 秒
const UNIX_TO_NTP = 2208988800;

// 运行信息
const SERVER_STARTED_AT = Date.now();
const SERVER_PID = process.pid;
const HOSTNAME = os.hostname();
const REF_ID = (() => {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
})();

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

/** 将 JSON 序列化中可能出现的 BigInt 安全转为字符串 */
function jsonSafe(key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** 返回 JSON 响应 */
function sendJSON(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body, jsonSafe);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(payload);
}

/** 生成一次完整的时间快照 */
function timeSnapshot() {
  const now = Date.now();
  return {
    unix: now,                                    // 毫秒时间戳
    iso: new Date(now).toISOString(),             // UTC ISO 8601
    utc: new Date(now).toUTCString(),             // 可读 UTC
    seconds: Math.floor(now / 1000),              // 秒级时间戳
    nanoseconds: process.hrtime.bigint(),         // 高精度单调时钟
    server: {
      hostname: HOSTNAME,
      pid: SERVER_PID,
      startedAt: SERVER_STARTED_AT,
      uptimeSeconds: Math.floor((now - SERVER_STARTED_AT) / 1000),
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 时间 API                                                       */
/* ------------------------------------------------------------------ */

const HTTP_HANDLERS = {

  /** GET /api/now —— 获取服务器当前时间 */
  '/api/now': (req, res) => {
    sendJSON(res, 200, timeSnapshot());
  },

  /**
   * GET /api/sync —— NTP 风格四时间戳对时
   *
   * 返回：
   *   t0 客户端发送时刻（由客户端在请求前写入 query 参数 t0）
   *   t1 服务器接收时刻
   *   t2 服务器发送时刻
   *   t3 客户端接收时刻（客户端本地计算）
   *
   * 客户端可据此计算与服务器的时钟偏移：
   *   offset = ((t1 - t0) + (t2 - t3)) / 2
   *   delay  = (t3 - t0) - (t2 - t1)
   */
  '/api/sync': (req, res, parsedUrl) => {
    const now = Date.now();
    const t0 = Number(parsedUrl.searchParams.get('t0')) || null;
    sendJSON(res, 200, {
      t0,                       // 客户端发送时刻（回显）
      t1: now,                  // 服务器接收时刻
      t2: now,                  // 服务器发送时刻（近似）
      receiveIso: new Date(now).toISOString(),
    });
  },

  /** GET /health —— 健康检查 */
  '/health': (req, res) => {
    sendJSON(res, 200, {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
      time: new Date().toISOString(),
    });
  },
};

/* ------------------------------------------------------------------ */
/* 静态文件服务                                                        */
/* ------------------------------------------------------------------ */

function serveStatic(req, res, pathname) {
  let filePath = path.normalize(path.join(ROOT, pathname));
  // 目录 → index.html
  if (filePath === ROOT || filePath.endsWith(path.sep)) {
    filePath = path.join(filePath, 'index.html');
  }
  // 防目录穿越
  if (!filePath.startsWith(ROOT)) {
    sendJSON(res, 403, { error: 'Forbidden' });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Server Error');
      }
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // 页面与脚本不缓存，保证前端更新即时生效；图片等静态资源短缓存
    const noCache = ['.html', '.js', '.css', '.json'].includes(ext);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-store' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* UDP SNTP 服务器（RFC 4330 简化实现）                                 */
/* ------------------------------------------------------------------ */

/**
 * 生成 SNTP 响应包（48 字节）
 * 支持与 Windows 时间服务 / macOS 系统时间客户端互通。
 */
function buildSntpResponse(request, receivedAtMs) {
  const response = Buffer.alloc(48);
  response.fill(0);

  // 第 0 字节：LI=0（无告警）、VN=4（SNTPv4）、Mode=4（Server）
  response[0] = 0x24;

  // 第 1 字节：Stratum = 2（二级服务器）
  response[1] = 2;

  // 第 2 字节：Poll = 6（2^6 = 64 秒）
  response[2] = 6;

  // 第 3 字节：Precision = -6（约 15.6ms 分辨率）
  response[3] = 0xFA; // -6 的二进制补码

  // 第 4-7 字节：Root Delay（固定 0.1 秒，0x00019999 是 0.1 的 16.16 定点表示）
  response.writeUInt32BE(0x00019999, 4);

  // 第 8-11 字节：Root Dispersion（固定 0.01 秒）
  response.writeUInt32BE(0x000028F6, 8);

  // 第 12-15 字节：Reference ID（本机 IPv4）
  const ref = REF_ID.split('.').map((n) => Number(n) & 0xff);
  response[12] = ref[0];
  response[13] = ref[1];
  response[14] = ref[2];
  response[15] = ref[3];

  // 时间戳（64 位：32 位秒 + 32 位小数），纪元 1900
  const nowSec = Math.floor(receivedAtMs / 1000) + UNIX_TO_NTP;
  const frac = Math.floor(((receivedAtMs % 1000) / 1000) * 0xffffffff);

  // 第 16-23 字节：Reference Timestamp（服务器最近一次同步时刻，用当前时刻近似）
  response.writeUInt32BE(nowSec, 16);
  response.writeUInt32BE(frac, 20);

  // 第 24-31 字节：Origin Timestamp —— 回显客户端请求的 Transmit Timestamp
  const clientTxSec = request.readUInt32BE(40);
  const clientTxFrac = request.readUInt32BE(44);
  if (clientTxSec !== 0 || clientTxFrac !== 0) {
    response.writeUInt32BE(clientTxSec, 24);
    response.writeUInt32BE(clientTxFrac, 28);
  }

  // 第 32-39 字节：Receive Timestamp —— 服务器收到请求的时刻
  response.writeUInt32BE(nowSec, 32);
  response.writeUInt32BE(frac, 36);

  // 第 40-47 字节：Transmit Timestamp —— 服务器发出响应的时刻
  response.writeUInt32BE(nowSec, 40);
  response.writeUInt32BE(frac, 44);

  return response;
}

function startSntpServer() {
  const socket = dgram.createSocket('udp4');

  socket.on('message', (msg, rinfo) => {
    // 仅处理 >= 48 字节的 NTP 请求
    if (msg.length < 48) return;
    const mode = msg[0] & 0x07;
    if (mode !== 3) return; // Mode=3 为客户端请求
    const response = buildSntpResponse(msg, Date.now());
    socket.send(response, 0, response.length, rinfo.port, rinfo.address, (err) => {
      if (err) console.error('[SNTP] 发送响应失败:', err.message);
    });
  });

  socket.on('error', (err) => {
    if (err.code === 'EACCES') {
      console.error(
        `[SNTP] 无法绑定 UDP ${SNTP_PORT}（权限不足）。` +
        'Windows 下请以管理员身份运行；或通过 ENABLE_SNTP=false 关闭 SNTP。'
      );
    } else {
      console.error('[SNTP] 错误:', err.message);
    }
    socket.close();
  });

  socket.bind(SNTP_PORT, HOST, () => {
    console.log(`[SNTP] 已监听 udp://${HOST}:${SNTP_PORT} (RFC 4330)`);
  });
}

/* ------------------------------------------------------------------ */
/* HTTP 服务器                                                         */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && HTTP_HANDLERS[pathname]) {
    try {
      HTTP_HANDLERS[pathname](req, res, parsedUrl);
    } catch (err) {
      console.error('[HTTP] 处理接口出错:', err);
      sendJSON(res, 500, { error: 'Internal Server Error' });
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  sendJSON(res, 405, { error: 'Method Not Allowed' });
});

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

server.listen(PORT, HOST, () => {
  console.log('==============================================');
  console.log('  TimeServer 时间服务器已启动');
  console.log('==============================================');
  console.log(`  站点页面   http://localhost:${PORT}/`);
  console.log(`  时间接口   GET /api/now`);
  console.log(`  对时接口   GET /api/sync?t0=<发送时刻ms>`);
  console.log(`  健康检查   GET /health`);
  console.log(`  主机名     ${HOSTNAME}`);
  console.log(`  参考标识   ${REF_ID} (Stratum 2)`);
  console.log('----------------------------------------------');
});

if (ENABLE_SNTP) {
  startSntpServer();
} else {
  console.log('[SNTP] 已关闭（设置 ENABLE_SNTP=true 可启用 UDP 系统级对时）');
}

process.on('uncaughtException', (err) => {
  console.error('[FATAL] 未捕获异常:', err);
  process.exit(1);
});
