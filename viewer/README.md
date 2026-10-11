# NocoBase 私有日报查看器

这里是每日增长报告网站的完整部署源码。它运行在 **owner-private ChatGPT Sites**，登录后的站点所有者可以阅读、切换和下载日报。公开仓库只保存程序与构建配置；真实 HTML、索引和历史数据留在私有报告仓库及站点的私有 R2 存储中。

## 访问边界

**必须保留 Sites 平台的 owner-private 访问策略。** 平台在请求进入 Worker 前验证访问者身份，或验证站点专用的服务凭据；本项目的 HTTP 路由依赖这一访问边界。单独部署到公开 Cloudflare Worker、GitHub Pages 或其他匿名站点，不会自动获得相同的保护。

`app/chatgpt-auth.ts` 是模板提供的登录辅助代码，登录身份本身不等于所有者授权。不要将模拟的本地身份、请求方自行提交的身份头或隐藏网址视为生产访问控制。应用不接收 GitHub、Google 或模型 API 密钥，也没有要求读者输入 PAT 的界面。

GitHub Actions 负责采集、分析和私有归档，然后通过站点专用服务凭据同步日报数据。**Actions 不部署网站源码，不改变站点的可见范围。** 查看器代码变更需要单独经过 Sites 的构建与私有发布流程。站点服务凭据应仅存在于生产环境的 GitHub Actions Secret，不写入此目录。

## 源码结构

| 路径 | 用途 |
| --- | --- |
| `app/page.tsx`、`app/globals.css`、`app/layout.tsx` | 阅读界面、响应式样式和网页元信息 |
| `app/api/reports/route.ts` | 读取日报目录，以及供授权同步任务写入日报的接口 |
| `app/reports/[date]/[run]/route.ts` | 读取完整 HTML，支持 `?download=1` 下载 |
| `server/` | 与框架独立的 R2 存储、完整性校验和 HTTP 边界 |
| `.openai/hosting.json` | 站点公开标识及存储绑定；`r2` 必须为 `BUCKET` |
| `vite.config.ts`、`build/`、`scripts/`、`lib/` | 保留的 Sites/Vinext 构建、运行和模板基础设施 |
| `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` | 包管理器版本、锁定依赖及安装策略 |
| `db/`、`drizzle/`、`drizzle.config.ts` | 模板的空数据库结构；当前没有启用 D1 |
| `vendor/`、`build/sites-vite-plugin.LICENSE` | 模板附带文件及其许可证 |
| `README.template.md` | 原始模板说明，保留作上游参考 |

当前界面不使用模板的大量 `components/ui`、示例页面和默认图片，因此未复制这些未引用的文件。依赖清单及锁文件保持与部署项目一致，没有手动改写锁定版本。

## 从源码重建

使用 Node.js `>=22.13.0` 和 `pnpm 11.25.0`。仓库根目录的 Node.js 项目与本目录分别管理依赖；以下命令在 `viewer/` 内执行。

```sh
cd viewer
corepack pnpm install --frozen-lockfile
corepack pnpm run build
```

如果没有 Corepack，先按本机环境安装 `pnpm 11.25.0`，再将上面的 `corepack pnpm` 换成 `pnpm`。受管理的 Linux Sites 环境使用 Sites 技能的安装与构建 helper；`npm run install:ci` 对应保留的 Linux 安装脚本，依赖 Bash、`flock` 和 GNU `timeout`。原始模板说明中的旧 npm 锁文件安装描述不适用于当前保留的 pnpm 锁文件。

构建由 Vinext/Vite 生成 `dist/client` 与 `dist/server`，Cloudflare Worker 配置由构建生成，不需要另建 `wrangler.jsonc`。源码中的 `.openai/hosting.json` 保留当前站点 ID；它是标识而非凭据。若为另一个所有者创建独立站点，必须使用 Sites 新建站点返回的 ID，并单独配置 owner-private 与 `BUCKET`，不能仅复制旧 ID。

```sh
# 可选：仅在本机回环地址查看已构建 Worker
corepack pnpm run start
```

本地存储初始为空；仅使用虚构数据验证。不要将生产报告、凭据、`node_modules/`、`dist/`、`.env*`、运行时状态或源仓库认证文件提交到公开仓库。构建成功只验证代码可以打包，生产登录及所有者访问边界仍须由 Sites 私有发布流程保证。

## 阅读与同步行为

- `GET /api/reports` 返回 `{ latest, reports }`，每条元数据使用 `report_id`，格式为 `YYYY-MM-DD/run_id-attempt`。
- `GET /reports/<report_id>` 返回完整 HTML；加 `?download=1` 可下载。
- 首页默认展示最新报告；`/?r=<report_id>` 可直接选择目录中的历史报告。
- 刷新失败会保留上次打开的报告并显示“未更新”；空目录与请求失败分别呈现。
- 没有 Google 数据的日报显示“页面巡检 / 数据受限”，不将缺失指标补零。
- HTML 保留原报告样式，在禁用脚本与同源访问的 iframe 中阅读。后端提供独立的内容安全策略、私有缓存头和完整性校验。
- 不可变的 HTML 与元数据写入 R2；目录支持有界冲突重试。旧日期补跑及较旧数据截止日不会覆盖更新的默认日报。

报告生成与私有归档配置见仓库根目录的 [README](../README.md) 和 [setup](../docs/setup.md)。
