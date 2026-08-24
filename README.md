# 同映 · 在线放映室

一个基于 React、DPlayer、Cloudflare Pages、Workers 和 Durable Objects 的轻量在线放映室。

房主可以创建公开或密码房间，设置普通视频或直播地址并分享房间链接。房主负责播放控制，其他观众可以一起观看、发送实时弹幕、投屏，并按自己的设备调整弹幕显示。

- 线上地址：[https://play.lacknb.com](https://play.lacknb.com)
- 播放器：[tsukumijima/DPlayer](https://github.com/tsukumijima/DPlayer) `v1.32.7`
- Node.js：`20` 或更高版本

## 功能

- 6 位房间号，支持公开房间和密码房间
- 视频与直播两种模式，支持浏览器可播放的 MP4、WebM、HLS（`.m3u8`）等格式
- 连接支持 Basic Auth / 应用密码的 WebDAV，按文件夹分页浏览资源
- WebDAV 视频文件支持一键创建房间，文件名可自动作为放映标题
- 支持保存、切换和删除多个 WebDAV 配置；本地配置使用设备密钥加密
- WebDAV 账号密码在 HTTPS 之外再使用 AES-GCM + RSA-OAEP 封装传输
- 房主控制播放、暂停、快进和倍速
- 普通观众默认只在进入或刷新时同步一次进度，可自行开启持续进度跟随
- 实时在线成员列表与断线重连
- 实时弹幕、右侧弹幕列表、滚动/顶部/底部弹幕
- 弹幕显示区域、不透明度、字号、速度及颜色设置
- 弹幕仅通过 WebSocket 实时转发，服务端不存储
- 最后一人离开后保留房间 1 小时，期间有人重新进入会取消解散倒计时
- 自动适配影片原始宽高比
- AirPlay、Chromecast、画中画及手机原生全屏
- 电脑、平板和手机响应式布局

## 架构

```text
浏览器
  │
  ├─ /、/room/* ─────── Cloudflare Pages（React 静态前端）
  │
  └─ /api/* ─────────── Cloudflare Worker
                              ├─ WebDAV PROPFIND 目录浏览
                              ├─ WebDAV 媒体 Range 请求转发
                              │
                              └─ Durable Object（每个房间一个实例）
                                   ├─ 房间与播放状态
                                   ├─ WebSocket 在线连接
                                   ├─ 房间期内的 WebDAV 上游凭据
                                   ├─ WebDAV 传输加密 RSA 密钥库
                                   └─ 1 小时空房清理闹钟
```

生产环境通过 `play.lacknb.com/api/*` 同源路由访问 Worker，避免移动网络访问独立 `workers.dev` 域名时出现 DNS、TLS 或跨域问题。

Durable Object 只保存房间信息、密码摘要、房主令牌摘要和最新播放状态。房间解散时会删除这些数据。弹幕不会写入 Durable Object Storage。

WebDAV 目录通过标准的 `PROPFIND Depth: 1` 读取。目录内容在 Worker 中排序、分页后返回，WebDAV 密码不会出现在资源列表或房间状态里。用 WebDAV 视频建房时，该房间的 Durable Object 会暂存上游地址和认证头，并通过房间媒体地址转发 `GET`、`HEAD` 与 HTTP Range 请求；最后一人离开且房间到期后，这些信息会随房间数据一起删除。

浏览器会把多个 WebDAV 配置合并加密后写入 `localStorage`，不可导出的 AES-GCM 设备密钥保存在 IndexedDB。发送凭据时，浏览器生成一次性 AES-GCM 密钥加密账号密码，再使用 Worker 公布的 RSA-OAEP 公钥封装该密钥；请求 JSON 只包含 `encryptedKey`、`iv` 和 `ciphertext`。密文通过 AES-GCM Additional Authenticated Data 与对应 WebDAV 地址绑定，不能改配到其他地址重放。RSA 私钥由一个专用 Durable Object 自动生成并持久化，不需要手工配置部署密钥。

应用层加密用于减少请求日志、调试工具和普通本地存储泄漏明文的风险，但不能替代 HTTPS。生产环境仍必须使用 HTTPS 来验证服务器身份、保护完整请求并抵御中间人攻击；同源脚本若已经获得页面执行权限，仍可能访问用户在页面中解密后的配置。

> WebDAV 服务必须能从公网访问并支持 HTTP(S)。出于安全考虑，本机地址、私有网段和 `.local` 地址不会被代理。建议使用服务商提供的应用密码，不要使用主账号密码。

## 目录结构

```text
.
├── public/                 # 静态资源和 Pages 单页应用回退规则
├── src/
│   ├── components/         # 房间、播放器、弹幕及页面组件
│   ├── lib/                # API 与投屏相关逻辑
│   ├── App.tsx             # 首页与前端路由入口
│   ├── styles.css          # 全站及响应式样式
│   └── types.ts            # 前后端消息与房间类型
├── worker/
│   ├── src/index.ts        # Worker、WebSocket 与 Durable Object
│   └── wrangler.jsonc      # Worker、路由、变量和 DO 配置
├── wrangler.pages.jsonc    # Pages 配置
├── .env.example            # 环境变量示例
└── package.json            # 开发、检查、构建和部署命令
```

## 本地开发

### 1. 安装依赖

```bash
git clone git@github.com:umuo/video-online.git
cd video-online
npm ci
```

### 2. 启动实时服务

打开第一个终端：

```bash
npm run dev:worker
```

Worker 默认运行在 `http://localhost:8787`，本地 Durable Object 数据保存在 `.wrangler/` 中。

### 3. 启动网页

打开第二个终端：

```bash
npm run dev
```

Vite 默认运行在 `http://localhost:5173`。页面请求同源的 `/api/*`，Vite 会把 HTTP 和 WebSocket 请求代理到 `http://localhost:8787`，因此本地开发不依赖浏览器跨域配置，通常也不需要创建 `.env` 文件。

如果端口被占用，请以终端输出的实际地址为准。

### 4. 本地验证

```bash
npm run check
npm run build
npm run preview
```

`npm run check` 会执行 TypeScript 和 ESLint 检查，`npm run build` 会生成 `dist/`，`npm run preview` 用于预览生产构建。

## 环境变量

`.env.example` 中列出了当前使用的变量：

| 变量 | 使用位置 | 说明 |
| --- | --- | --- |
| `VITE_REALTIME_URL` | Vite 构建 | 可选。仅在前端和 Worker 不同源部署时覆盖实时服务地址；本地开发通常不需要 |
| `ALLOWED_ORIGIN` | Worker | 允许访问 API 和 WebSocket 的网页来源，多个值使用英文逗号分隔 |
| `ROOM_EMPTY_TTL_MS` | Worker | 空房自动解散时间，默认 `3600000` 毫秒，即 1 小时 |

注意：生产 Worker 当前直接从 `worker/wrangler.jsonc` 读取 `ALLOWED_ORIGIN` 和 `ROOM_EMPTY_TTL_MS`。仅修改 `.env` 不会改变线上 Worker 配置。

## 部署到 Cloudflare

### 前置条件

- 一个 Cloudflare 账号
- 已接入 Cloudflare 的域名；当前配置使用 `lacknb.com`
- 本机已安装 Node.js 20+
- 已通过 Wrangler 登录：

```bash
npx wrangler login
```

### 1. 修改部署配置

如果部署到自己的账号或域名，请先修改以下内容。

`worker/wrangler.jsonc`：

- `name`：Worker 名称
- `routes[].pattern`：Worker 自定义域名及同源 `/api/*` 路由
- `routes[].zone_name`：Cloudflare Zone 名称
- `ALLOWED_ORIGIN`：Pages 域名和自定义站点域名
- `ROOM_EMPTY_TTL_MS`：空房解散时间

`wrangler.pages.jsonc` 和 `package.json`：

- Pages 项目名称；当前为 `tongying-room`

如果使用同源路由，推荐配置形式如下：

```jsonc
"routes": [
  {
    "pattern": "play.example.com/api/*",
    "zone_name": "example.com"
  }
]
```

`play.example.com` 本身应绑定到 Cloudflare Pages。Worker 路由只接管 `/api/*`，其余路径继续访问 Pages。

### 2. 部署 Worker

```bash
npm run deploy:worker
```

首次部署会创建 Durable Object namespace，并应用 `worker/wrangler.jsonc` 中的迁移和路由。

### 3. 构建并部署 Pages

```bash
npm run build
npm run deploy:pages
```

也可以执行完整部署：

```bash
npm run deploy
```

它会依次部署 Worker、构建前端并上传 Pages。

如果 Pages 项目尚未创建，可以先执行：

```bash
npx wrangler pages project create tongying-room
```

`public/_redirects` 已配置单页应用回退，因此 `/room/XXXXXX` 分享链接可以直接打开。

### 4. 绑定 Pages 自定义域名

在 Cloudflare 控制台进入：

```text
Workers & Pages → tongying-room → Custom domains
```

绑定站点域名后，确认 `worker/wrangler.jsonc` 中存在对应的 `域名/api/*` Worker Route，再重新部署 Worker。

### 5. 部署后检查

```bash
# 首页应返回 HTML
curl -I https://play.example.com/

# API 应返回 JSON；不存在的房间通常为 404
curl -i https://play.example.com/api/rooms/ABCDEF
```

然后使用两个不同浏览器或无痕窗口测试：创建房间、加入房间、播放/暂停、弹幕和 WebSocket 重连。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 启动 Vite 前端开发服务 |
| `npm run dev:worker` | 启动本地 Worker 和 Durable Object |
| `npm run check` | 运行 TypeScript 与 ESLint 检查 |
| `npm run build` | 构建生产前端到 `dist/` |
| `npm run preview` | 本地预览生产构建 |
| `npm run deploy:worker` | 部署 Worker、DO 和路由 |
| `npm run deploy:pages` | 上传 `dist/` 到 Cloudflare Pages |
| `npm run deploy` | 部署 Worker，构建并部署 Pages |

## 媒体地址要求

- 生产环境应使用 HTTPS 媒体地址，避免浏览器拦截混合内容。
- 视频服务器应支持 HTTP Range 请求；MP4 拖动和 iOS 播放通常需要返回 `206 Partial Content`。
- HLS 播放列表和所有分片都必须能被观众设备直接访问，并正确配置 CORS。
- 移动端兼容性最好的组合是 MP4/HLS + H.264 视频 + AAC 音频。
- HDR、HEVC/H.265、Dolby Vision、DTS 等格式取决于设备、系统和浏览器支持，建议同时提供 SDR/H.264/AAC 版本。
- Chromecast 必须能从公网直接访问媒体地址；依赖登录 Cookie 或仅限局域网的地址通常无法投屏。
- 请确保分享和播放的内容拥有合法授权。

### WebDAV 要求

- 当前认证方式为 HTTP Basic Auth，兼容常见的应用密码；需要 Digest、OAuth 或网页登录 Cookie 的服务暂不支持。
- HTTPS WebDAV 必须使用 Worker 能验证的公开 CA 证书；自签名证书会在服务端连接阶段失败。
- 一键建房支持 WebDAV 返回 `video/*` MIME 类型，或扩展名为 MP4、WebM、MOV、M4V、MKV、AVI、MPEG、TS 等的视频文件。
- WebDAV 服务应支持 `HEAD`、`GET` 和 Range 请求，否则可能无法获取时长或拖动进度。
- WebDAV 媒体经 Worker 转发会产生 Worker 流量；大规模公开放映建议使用带签名 URL 的对象存储或 CDN。

## 常见问题

### 一直显示“正在寻找放映室”

确认页面能够访问 `/api/rooms/<房间号>`，并检查 Pages 自定义域名上的 `/api/*` Worker Route。前端请求超过 10 秒会显示重新连接按钮。

### 提示“当前来源未被允许”

将实际网页来源加入 `worker/wrangler.jsonc` 的 `ALLOWED_ORIGIN`，然后重新部署 Worker。来源需要包含协议，例如 `https://play.example.com`。

### 电脑能播放，手机不能播放

优先检查媒体编码、音频格式、HTTPS、CORS 和 Range 支持。DPlayer 提供控制界面，实际解码能力由浏览器和系统决定。

### 弹幕会保存吗？

不会。弹幕只广播给当时在线的连接；右侧实时弹幕列表也只存在于当前页面内存中。

## 数据与安全说明

- 房间密码只保存 SHA-256 摘要，不保存明文。
- 房主令牌只保存在房主浏览器中，分享链接不会携带房主身份。
- WebDAV 凭据仅在浏览请求中使用；建房后暂存在对应 Durable Object 中，不返回前端观众，并在房间自动解散时删除。
- 已保存的 WebDAV 配置在 `localStorage` 中是 AES-GCM 密文，密钥作为不可导出的 `CryptoKey` 保存在 IndexedDB；清理任一站点存储都可能使配置无法恢复。
- 服务端不代理或存储视频文件，播放流量由观众设备直接访问媒体源。
- 例外：通过 WebDAV 创建的房间会流式转发所选视频，但不会把视频内容写入持久化存储。
- 房间解散后，Durable Object 会清除该房间的持久化数据。
- 该项目没有用户账号系统，适合轻量、临时的私人放映场景。
