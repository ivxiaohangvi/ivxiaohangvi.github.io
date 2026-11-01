# moxo · 小航的无限空间

个人站点的源码：<https://moxo.cc>

用 [Astro](https://astro.build) 5 写的纯静态博客，构建产物直接丢给 GitHub Pages；Steam 在线状态那条接口挂在 Cloudflare Workers 上。仓库里只有站点本身需要的东西——私人日记、每日记录的原始导出、摄影测量的重建缓存都不在这里。

## 技术栈

- **Astro 5** + TypeScript，零客户端框架，输出纯静态页面
- **GitHub Pages** 托管，`.github/workflows/deploy.yml` 自动构建部署
- **Cloudflare Workers** 跑一个小接口：`moxo.cc/api/steam-status`
- **Pagefind** 做站内搜索，**GSAP** 做页面动效，**three.js** 只用在彩蛋页 `/infinity/`
- Node.js 22（构建脚本用到 `node --test` 与 `--experimental-strip-types`）

## 目录

```
src/
  config.ts            站点标题、作者、导航、社交链接（改站名先看这里）
  content.config.ts    内容集合的 schema
  content/
    blog/              文章（Markdown）
    friends/           友链
    tools/             工具页说明
    diary/             日记——只留占位，正文不入库
    moments/           动态——同上
    photos/            摄影——同上
  components/          页头页脚、抽屉柜、灯箱、Steam 留言墙等
  layouts/             页面骨架
  lib/                 归档、排版、LQIP、拼音词库等纯函数
  pages/               路由；/diary/、/moments/、/photos/ 的列表与归档页在这里
  scripts/             浏览器端脚本（解锁、打字机、胶片卷）
  styles/              全局样式
public/                静态资源：CNAME、robots.txt、图标、贴纸、Steam 头像
scripts/               构建与维护脚本（vault 编解码、LQIP、OTS、Steam 同步）
vault/                 Base64 存档：彩蛋页与几张隐蔽页面（不是加密，见下）
workers/steam-status/  Cloudflare Worker：Steam 状态接口
.github/workflows/     自动部署
base3                  旧站归档：一串 Base32 文本（原名 base3?，Windows 文件名不允许 ?）
test.zip               旧站归档：加密压缩包（约 4.4 MB，不进构建产物）
```

> `base3` 与 `test.zip` 只作为存档放在仓库根目录，不属于站点内容，部署时不会被发布。`public/tools/shamir.html` 是旧站那份混淆单页（`src/content/tools/shamir.md` 指向它）。

## 本地跑起来

```bash
npm ci
npm run dev          # http://localhost:4321
```

`predev` / `prebuild` 会先跑三个脚本：从 `vault/` 解码存档、生成推送信息、为图片生成 LQIP 占位。它们都不会联网。

## 构建与部署

```bash
npm run build        # 跑单元测试 → astro build → 校验 Steam 数据 → pagefind 建索引
npm run preview      # 预览 dist/
```

推送到 `main` 会触发 `.github/workflows/deploy.yml`：

1. `sync-steam`：抓 Steam 留言与头像，把结果提交回仓库（只在定时任务和手动触发时跑）
2. `ots-stamp`：给每篇文章生成 OpenTimestamps 时间戳
3. `build` + `deploy`：构建并发布到 GitHub Pages

仓库的默认分支必须是 `main`，Pages 的 Source 选 **GitHub Actions**，并到 Settings → Actions → General 把 Workflow permissions 设为 **Read and write**——`sync-steam` 与 `ots-stamp` 都要把数据提交回来，权限不够时这两步会被 `continue-on-error` 静默吞掉。

站点地址集中在两处：`astro.config.mjs` 的 `site` 和 `public/CNAME`。换域名时两处一起改，并同步 `public/robots.txt` 里的 sitemap 地址。

### 域名接入顺序（重要）

`moxo.cc` 同时要跑 Cloudflare 代理（CDN）和 GitHub Pages，顺序错了证书签不下来：

1. Cloudflare 先把根域 `moxo.cc` 指向 GitHub Pages，**此时必须是灰云（DNS only）**。两种写法都行：
   - CNAME 拉平（推荐，少一条记录）：类型 CNAME、名称 `@`、目标 `ivxiaohangvi.github.io`。DNS 规范本身不许根域挂 CNAME，但 Cloudflare 会在根域自动把它「拉平」成 A 记录返回，GitHub 看到的仍然是 Pages 的 IP。
   - A 记录（GitHub 文档的标准写法）：`185.199.108.153` / `.109.153` / `.110.153` / `.111.153`，外加 `www` 的 CNAME → `ivxiaohangvi.github.io`
2. 在仓库 Settings → Pages 填 `moxo.cc` 并保存，等 GitHub 校验 DNS、签发证书（Pages 页面会显示 Certificate issued）
3. 证书就绪后再把 Cloudflare 切回橙云代理，SSL/TLS 模式选 **Full (strict)**
4. Worker 路由 `moxo.cc/api/steam-status` 在橙云下由 Worker 直接应答，其余路径回源到 GitHub Pages

先橙云后绑域名的做法，GitHub 的 DNS 校验会失败，站点可能长期停在「无有效证书」。

## 内容写在哪

- 文章：`src/content/blog/<slug>.md`，frontmatter 里的 `draft: true` 不会进构建
- 友链：`src/content/friends/*.md`
- 工具页：`src/content/tools/*.md` + `public/tools/` 下的单页
- 日记、动态、摄影：schema 在 `src/content.config.ts`，但正文属于私人内容，不进这个仓库

## vault：Base64 存档，不是加密

`vault/` 里放的是 **Base64 编码** 的文本，目的是让私人正文和几张「不该被随手看到」的页面不被直接检索到，**它不提供任何机密性**——能读到仓库的人都能解出来。页面上的密码锁（`/diary/` 的解锁、封印日记的分享码）是另外一层，见下。

```bash
npm run vault:decode   # vault/ → src/content/diary、src/content/moments、src/pages/infinity.astro、public/admin.html 等
npm run vault:encode   # 把改动写回 vault/（提交前跑，源码树里留下的是 Base64）
```

编码产物都在 `.gitignore` 里：仓库只保存 `vault/` 这份存档，构建前再还原。

## 日记与动态

- 日记支持「封印」：正文用主密码派生密钥做 AES-256-GCM 加密。`npm run seal` 封印一篇，`npm run share` 生成/重签分享码；错三次跳 `/void/`。钥匙环、密文与封印前原图备份都只留在本机（`public/diary/`、`backups/`），`.gitignore` 已整目录挡住，不会进仓库。
- 从 Daily You 导入日记用 `npm run import:diary`，导入时会脱敏特定的词；导入的正文与图片同样落在被忽略的目录里。
- 动态与摄影的图片放在 `public/moments/`、`public/photos/`，构建时自动生成中等尺寸和缩略图，清单写进 `src/lib/image-lqip.json`。

## Steam 留言与在线状态

留言数据由 `scripts/sync-steam-comments.mjs` 抓取，写进 `src/data/steam-comments.json`；关于页的状态条和留言墙直接读静态数据。

实时状态走 Worker：

```bash
cd workers/steam-status
npx wrangler secret put STEAM_API_KEY   # 只在 Cloudflare 后台存，不落仓库
npx wrangler secret put STEAM_ID
npx wrangler deploy
```

`wrangler.toml` 把路由钉在 `moxo.cc/api/steam-status`，只允许 `moxo.cc` 与 `www.moxo.cc` 跨域，响应缓存 45 秒。Cloudflare 代理开启后，这条路径由 Worker 直接应答，不经过 GitHub Pages；其余路径才回源。想在本地联调，dev server 已经把这条路径代理到线上。

## OpenTimestamps

`npm run ots` 会先为每篇文章生成规范化的文本（`public/ots/blog/<slug>.txt`），再用 `opentimestamps-client` 打时间戳（`*.txt.ots`），最后把结果写进 `src/data/ots.json` 供页面展示。CI 里装的是 `opentimestamps-client`，本地需要自己准备 `python`（或用 `OTS_PYTHON` 指定解释器）。离线只想重建清单时加 `--offline`。

## 免费额度

站点是纯静态的，落在 GitHub 的免费范围里：

- GitHub Pages：单站 1 GB、每月 100 GB 带宽（软限制）
- GitHub Actions：公开仓库不计量分钟数；这里的定时任务是每 6 小时一次，单次两三分钟
- Cloudflare Workers：免费套餐每天 10 万次请求，这个接口的调用量远低于此

图片和模型都已经压到「够用就好」的尺寸，`dist/` 在几十 MB 量级。

## 许可

文字与照片版权归作者所有，转载前请先联系。代码部分可参考，但请勿直接搬走整站设计。
