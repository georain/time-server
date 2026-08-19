# TimeServer · 时间服务器网站

一个集**实时时钟展示**、**网络对时**、**秒表/倒计时工具**与**时间 API**于一体的时间服务器网站。

- 前端：液态玻璃（Glassmorphism）风格单页应用，暗色主题，毫秒级实时时钟
- 后端：Node.js 原生 HTTP 服务，零依赖
- 特色：NTP 风格四时间戳对时接口、可选 UDP SNTP（RFC 4330）系统级对时

## 快速开始

```bash
# 启动 HTTP 服务（默认 :3000）
node server.js

# 启用 UDP SNTP 系统级对时（Windows 需管理员权限）
ENABLE_SNTP=true node server.js
```

打开 <http://localhost:3000> 即可访问。

## HTTP API

| 接口 | 说明 |
| --- | --- |
| `GET /api/now` | 服务器当前时间快照（unix 毫秒、ISO、UTC、运行信息） |
| `GET /api/sync?t0=<发送时刻ms>` | NTP 风格四时间戳对时，返回 `t0/t1/t2`，配合本地 `t3` 计算偏移与延迟 |
| `GET /health` | 健康检查 |

### 对时算法

```
offset = ((t1 − t0) + (t2 − t3)) / 2
delay  = (t3 − t0) − (t2 − t1)
```

前端每 60 秒自动对时一次，取 5 次采样的中位数偏移，实时校准页面时钟。

## UDP SNTP（系统级对时）

`ENABLE_SNTP=true` 时服务器在 UDP 123 端口提供 SNTP 服务，Windows / macOS 系统时间客户端可直接同步：

```bash
# Windows（管理员）
w32tm /config /manualpeerlist:"localhost,0x8" /syncfromflags:manual /update
w32tm /resync
w32tm /query /status
```

> 注意：Windows 下绑定 UDP 123 需要管理员权限；端口可能被系统时间服务占用，若冲突可改用
> `SNTP_PORT=其他端口` 并配合端口转发使用。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 端口 |
| `ENABLE_SNTP` | `false` | 是否启用 UDP SNTP 服务 |
| `SNTP_PORT` | `123` | SNTP UDP 端口 |
| `HOST` | `0.0.0.0` | 监听地址 |

## 项目结构

```
time-server/
├── server.js        # HTTP + SNTP 服务器
├── index.html       # 主页面
├── css/style.css    # 液态玻璃样式
├── js/app.js        # 前端逻辑
└── package.json
```

## 说明

- 页面可脱离后端以纯静态方式打开（此时时钟使用本机时间，仅显示"仅本地"状态）
- 挂载到反向代理时，`/api/*` 路径需透传给本服务
