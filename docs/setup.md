# 部署每日 NocoBase 增长报告

本项目把代码和工作流保存在公共仓库，把真实指标、分析、HTML 和运行记录保存在单独的私有仓库，并把最新成功报告的 HTML 同步到 [私有在线查看器](https://nocobase-growth-reports.gong-ads.chatgpt.site)。查看器保持 **owner-private（仅所有者可访问）**，用站点所有者的 ChatGPT 账号登录。

首次部署依次完成：确认两个仓库与真实 repository ID、配置报告仓及模型凭证和实际模型 endpoint / model ID、配置网页同步、运行 preflight、运行一次真实 report 并核对私有归档及同步结果，最后启用每日定时任务。Google 凭证可稍后添加；未配置时先运行页面 SEO 巡检，仍能生成、归档和在线阅读报告。查看操作见 [私有网页说明](viewer.md)；查看器源码与部署步骤见 [viewer/README.md](../viewer/README.md)。

## 1. 准备两个仓库

| 仓库 | 可见性与分支 | 保存内容 |
| --- | --- | --- |
| `gchust/nocobase-growth` | Public，默认分支 `main` | 本项目代码、固定版本的 skill、工作流和合成测试数据 |
| `gchust/nocobase-growth-reports` | Private，默认分支 `develop` | 真实报告、指标、建议和跨日状态 |

私有仓库已在现有默认分支 `develop` 包含初始 README 和 `.gitignore`；归档直接使用该分支。两个仓库都保持 GitHub Pages 禁用；本项目没有 Pages 部署工作流。

在已登录 GitHub CLI 的本机查询目标元数据：

```sh
gh api repos/gchust/nocobase-growth-reports --jq '{id, full_name, private, visibility, archived, disabled, default_branch}'
```

当前私有报告仓的真实数字 ID `1414200278` 已写入 `sites/nocobase.json` 的 `archive.repository_id`。如果重新创建报告仓，必须重新查询并更新此 ID。目标必须是 `gchust/nocobase-growth-reports`，`private` 为 `true`、`visibility` 为 `private`、`archived` 和 `disabled` 为 `false`，默认分支为 `develop`。保留 `null` 或填写示例数字都会阻止真实运行。

归档器在读取前、写入 Git 对象前和更新分支前重新核对这些条件。目标不存在、改为公开、被转移、ID 不一致或接口无法确认时，流程停止。

## 2. 设置生产环境、凭证与模型接口

当前代码仓库已建立 `growth-production` 环境并保存仅允许 `main` 分支的规则；下面的环境创建步骤供重新部署时参考。首次使用请在现有环境中添加报告仓和模型两个必需凭证，并配置实际模型接口。

在公共代码仓库打开 **Settings → Environments**，创建 `growth-production`。其 **Deployment branches and tags** 选择 **Selected branches and tags**，只添加类型为 **Branch** 的 `main` 规则。这样环境凭证仅供选定分支使用；这是 GitHub 提供的环境分支限制机制。[GitHub 环境文档](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

在这个环境中配置以下 **Environment secrets**：

| Secret | 值 | 使用阶段 |
| --- | --- | --- |
| `REPORTS_TOKEN` | 仅授权私有报告仓库的 fine-grained PAT | `preflight`、`prepare`、`publish`、`failure`、`web-publish` |
| `GOOGLE_CREDENTIALS_JSON` | 可选，Google 服务账户的完整 JSON 凭证；未配置时运行页面巡检 | `collect` |
| `DEEPSEEK_API_KEY` | 用于本项目的 DeepSeek API key | `analyze` |
| `REPORT_VIEWER_TOKEN` | 仅用于私有查看器的 Sites 服务访问凭证 | 独立网页同步工作流的 `web-publish` |

在同一环境的 **Environment variables** 中配置模型服务和查看器；本地运行时使用同名环境变量：

| Variable | 用途 | 未设置时的默认值 |
| --- | --- | --- |
| `DEEPSEEK_BASE_URL` | 服务商提供的 Anthropic Messages 兼容 Base URL | `https://api.deepseek.com/anthropic` |
| `DEEPSEEK_MODEL` | 该服务商接受的精确模型 ID | `deepseek-flash` |
| `REPORT_VIEWER_URL` | 私有查看器的固定 HTTPS origin，配置要求见 [私有网页说明](viewer.md) | 网页同步必须配置 |

这些 Variables 属于非凭证配置。自定义网关应同时核对 endpoint、model ID 和对应 Key；不能把第三方 Key 配给默认官方 endpoint。Variables 可能显示在公开 Actions 的步骤环境中，因此 URL 不得携带 Key、用户名、密码或其它凭证。

各 secret 都不放入 job 级别环境变量。`preflight` 只接收 `REPORTS_TOKEN` 的真实值和模型凭证存在与否的布尔标记。Google 凭证只传给采集阶段；Claude 子进程只接收模型凭证和运行所需的白名单变量。独立网页同步步骤只接收报告仓和查看器凭证，不接收 Google 或模型凭证。

为本项目独立配置凭证。`nb3-factory` 只作为运行方式的参考，本项目不会读取其中保存的 secret。凭证文件、真实报告及完整模型输出都不提交到公共代码仓库。

### REPORTS_TOKEN

创建 fine-grained personal access token，Resource owner 选 `gchust`，Repository access 选 **Only select repositories**，只勾选 `nocobase-growth-reports`。Repository permissions 使用：

- **Contents: Read and write**：读取历史、创建 Git tree/commit、更新私有报告仓的 `develop`。
- **Metadata: Read-only**：核对目标仓库身份与私有状态。

可使用 [预填 Token 创建表单](https://github.com/settings/personal-access-tokens/new?name=NocoBase%20growth%20reports&description=Archive%20daily%20NocoBase%20growth%20reports&target_name=gchust&expires_in=90&contents=write&metadata=read)。链接预填名称、owner、权限和 90 天有效期；打开链接后仍需选择 **Only select repositories → nocobase-growth-reports**，核对后生成 Token，并直接保存到 `growth-production` 的 `REPORTS_TOKEN` Secret。

90 天是本项目的初始维护选择，可按维护周期调整；过期前更新环境 Secret。仓库筛选、权限和预填参数遵循 GitHub 的 fine-grained PAT 机制。[GitHub PAT 文档](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)

### REPORT_VIEWER_URL 与 REPORT_VIEWER_TOKEN

在 `growth-production` 中分别保存 Variable `REPORT_VIEWER_URL` 和 Environment secret `REPORT_VIEWER_TOKEN`。查看器保持 Sites 的 **owner-private** 访问控制：浏览器用户通过 ChatGPT 登录，GitHub Actions 使用专属站点服务凭证。不要把 GitHub PAT 当作站点服务凭证，也不要把凭证写进 URL 或公共代码。

`Publish private HTML report` 工作流读取已验证私有仓库的最新成功报告，用固定 commit 快照校验元数据和 HTML 后发往查看器。`REPORTS_TOKEN` 只发送到 GitHub API；`REPORT_VIEWER_TOKEN` 只发送到固定查看器 host。同步使用独立工作流，不改变私有 GitHub 归档，也不需要 Google 或模型请求。具体访问、手动同步和凭证配置方式见 [私有网页说明](viewer.md)，程序与部署细节见 [查看器 README](../viewer/README.md)。

### GOOGLE_CREDENTIALS_JSON（可选）

不设置或留空时，程序不请求 Google API，仍会检查配置的重点页面、比较前次页面状态、调用模型生成建议，并归档 HTML / Markdown 报告。报告标记为页面 SEO 巡检和 `limited`，GSC / GA4 标记 `not_configured`，`seo`、`analytics`、`data_through` 保持 `null`；不会生成点击、曝光、CTR 或排名趋势。

首次巡检用于建立基线；本次首次发现的问题不代表它刚刚发生。后续报告再与前次成功页面状态比较。

以后在同一环境添加此 Secret 即可自动接入 Google 数据，不必切换工作流模式。非空但无效的 JSON、过期凭证、属性授权和 API 错误仍会失败，不降级为未配置。准备接入时完成以下步骤：

1. 在用于本项目的 Google Cloud 项目启用 **Google Search Console API**。
2. 创建服务账户和 JSON 密钥，把完整 JSON 原样保存为环境 secret。
3. 在 Search Console 打开实际的 `nocobase.com` 属性。由属性所有者在 **设置 → 用户和权限** 中添加 JSON 的 `client_email`，授予读取效果数据所需的用户权限。当前任务只读取 Performance 数据，可使用 **Restricted user**；Google 的权限表包含其 Performance 查看权限。[Search Console 权限说明](https://support.google.com/webmasters/answer/7687615?hl=en)
4. 核对 `sites/nocobase.json` 的 `gsc.property` 与被授权的属性完全一致。默认使用域名属性 `sc-domain:nocobase.com`；如果实际授权的是网址前缀属性，应填写其完整前缀。

采集器请求 `https://www.googleapis.com/auth/webmasters.readonly`，只读取 Search Console 数据。[Search Console API 授权说明](https://developers.google.com/webmaster-tools/v1/how-tos/authorizing)

**GA4 可选。** 若要加入自然搜索会话、用户、关键事件等 GA4 数据，在同一 Cloud 项目启用 **Google Analytics Data API**，给服务账户添加目标 GA4 属性的读取权限，并把数字属性 ID 写入 `ga4.property_id`；`ga4.hostname` 填报告限定的网站主机名。默认 `property_id: null` 会明确标记 GA4 未配置。采集器使用 `analytics.readonly` scope。[Google Analytics API 设置说明](https://developers.google.com/analytics/devguides/reporting/data/v1/quickstart)

GSC 域名属性可能包含多个主机名；GA4 的 hostname 限定与 GSC 属性范围应在阅读报告时一并考虑。报告保留各数据源自己的时区和有效截止日。

### DeepSeek endpoint、模型 ID、Key 与 Claude Code

工作流在接收业务数据之前，从官方 npm registry 安装固定的 `@anthropic-ai/claude-code@2.1.296`。该安装步骤不接收业务凭证。升级版本时同时修改工作流与 `sites/nocobase.json`，并通过 CI。

站点文件的默认 API model ID 是 `deepseek-flash`，默认接口地址为 `https://api.deepseek.com/anthropic`，与 DeepSeek 官方 Anthropic 兼容接口示例一致。[DeepSeek 接口文档](https://api-docs.deepseek.com/guides/anthropic_api/)

如果使用自定义网关，在 `growth-production` 设置 `DEEPSEEK_BASE_URL` 和 `DEEPSEEK_MODEL`。例如你的服务将模型命名为 `deepseek-v4.1-flash`，就填写这个精确 ID；不根据展示名称自动猜测或改写。非空环境变量优先于 `sites/nocobase.json`，未设置或空白时使用文件默认值。`preflight` 和 `prepare` 使用同一解析规则；`prepare` 把结果保存到本次私有工作目录，后续分析使用已保存的配置。

`DEEPSEEK_BASE_URL` 映射到 Claude Code 的 `ANTHROPIC_BASE_URL`，`DEEPSEEK_MODEL` 同时用于 `--model` 和各个模型别名。填写完整 HTTPS Base URL，可以带网关的路径前缀和端口；不附加查询参数、fragment、用户名或密码，也不要把完整 `/v1/messages` 请求地址当作 Base URL。校验失败会在采集前以固定错误码停止。

**协议必须匹配。** 自定义地址需支持 Anthropic Messages 请求及流式响应。只提供 OpenAI `/chat/completions` 的服务需要额外的协议转换，不能只替换 URL。本项目没有内置这种转换器。应使用服务商给 Claude Code 的接入地址；详见 [Claude Code 网关协议](https://code.claude.com/docs/en/llm-gateway-protocol)。

准备可调用该 endpoint / 模型的 Key，并确保账户可用于 API 请求。报告分析所需的指标和页面检查信息会发送到所配置的服务。当前将 `DEEPSEEK_API_KEY` 同时用于 Claude 的 Bearer 和 `x-api-key` 凭证变量；如果网关要求不同的凭证方式，应先确认其接入文档。Claude 不拥有文件、终端或 MCP 工具；模型输出只负责分析字段，指标由代码计算，JSON 在本地通过闭合 schema 校验后才进入报告。

`preflight` 不发起 Google 或模型请求。首次真实 `report` 验证页面采集、模型分析和私有归档；配置了 Google 凭证时，还会验证 Google 权限和实际数据读取。

## 3. 先检查，再运行第一份报告

将配置和工作流合入公共仓库的 `main` 后，在 **Actions → NocoBase growth report → Run workflow** 操作：

1. 分支选 `main`，`mode` 保持默认 `preflight`。它核对 endpoint / model ID 的配置格式、目标私有状态及报告仓和模型的必需凭证，不测试模型或 Google 的网络连通性，也不触发网页同步。
2. preflight 成功后，手动选择 `mode: report`，`as_of` 留空。这次运行会检查重点页、读取已接入的 Google 数据、调用 DeepSeek 并归档真实报告。没有 Google 凭证也可完成。
3. 在私有报告仓库确认 `state/latest.json` 和它指向的报告已经出现；再检查自动触发的 **Publish private HTML report** 工作流。同步成功后，使用站点所有者的 ChatGPT 账号打开 [在线查看器](https://nocobase-growth-reports.gong-ads.chatgpt.site)，核对报告日期和内容。
4. 在公共代码仓库 **Settings → Secrets and variables → Actions → Variables**，将已建立的仓库变量 `GROWTH_ENABLED` 从 `false` 改为小写字符串 `true`。

只有 `GROWTH_ENABLED == 'true'` 时，定时事件才执行生产 job。删除这个变量或改为 `false` 可暂停定时报告，手动运行仍可使用。此变量须配置为 **Repository variable**，因为 job 条件在进入 `growth-production` 环境前就会求值。

定时任务设为 **Asia/Shanghai 每天 09:17**。定时日报或手动 `mode: report` 成功结束后，独立工作流自动同步最新成功报告到私有查看器；`preflight` 不触发同步。因此网页在采集、分析、归档和同步完成后更新，并非保证在 09:17 已有新报告。GitHub 的 schedule 在公共代码仓的默认分支 `main` 上运行，可能延迟；高负载时可能丢弃排队任务。公共仓库连续 60 天没有仓库活动时，定时工作流会自动禁用，届时需在 Actions 中重新启用。公共代码仓及生产环境规则保持 `main`，私有报告仓保持 `develop`。[GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

手动补跑时，`as_of` 可填写 `YYYY-MM-DD`，表示请求的 GSC 数据截止日；留空由程序选择可用的完整数据。这个输入通过环境变量传给程序并验证，不拼入 shell 命令。报告日期仍为本次运行在上海时区的日期，报告内同时显示实际数据截止日。

## 4. 查看报告与历史

日常阅读可打开 [NocoBase 增长报告](https://nocobase-growth-reports.gong-ads.chatgpt.site)，通过站点所有者的 ChatGPT 账号登录，查看最新 HTML、选择已同步的历史报告，或下载完整 HTML。站点应始终保持 **owner-private**；知道网址不代表获得访问权限。网页只保存 HTML 和查看目录，GitHub 私有仓库保留完整指标、分析、运行记录和跨日状态。页面操作与访问说明见 [私有网页说明](viewer.md)。

需要检查完整归档时，登录有权访问私有报告仓库的 GitHub 账户，打开 `state/latest.json`。其中的 `report_path` 和 `report_url` 指向最近一次推进状态的成功报告，`previous_report` 保存其前一份报告的引用。

| 私有仓库路径 | 用途 |
| --- | --- |
| `runs/YYYY-MM-DD/RUN_ID-ATTEMPT/report.html` | 完整 HTML，下载后在本地浏览器打开 |
| 同目录 `report.md` | 可直接在 GitHub 文件页阅读的报告 |
| 同目录 `report.json`、`metrics.json`、`analysis.json` | 完整结构化报告、指标与模型分析 |
| 同目录 `run.json` | 代码版本、执行状态、固定错误代码与归档标记 |
| `state/latest.json` | 当前成功报告入口和前次报告引用 |
| `state/summary.json` | 下次分析读取的前次摘要 |
| `state/site-checks.json` | 跨日比较页面检查结果的状态 |

GitHub 文件页中的 HTML 是代码文件，可下载后本地查看；在线阅读使用上述登录保护的查看器。GitHub Pages 保持禁用。

定时日报或手动 `mode: report` 成功后会触发 **Publish private HTML report**，同步当前 `state/latest.json` 对应的成功报告；`preflight` 不触发同步。也可在 **Actions → Publish private HTML report → Run workflow** 中选 `main` 手动同步。同步不重新采集或调用模型；失败时可单独重跑，GitHub 私有归档保留不变。同一报告重复同步返回 `unchanged`，不生成重复报告。首次尚无归档时，先完成一次 `mode: report`，再核对同步结果。

只有文件完整、状态为 `completed`，并且 `report_date` 比当前最新报告日期更晚、`data_through` 不早于现有截止日时，三个 `state` 文件才一起更新。页面巡检的截止日为显式 `null`，可按报告日推进页面状态，也可被后续带搜索数据的报告推进；已有搜索数据截止日后，无 Google 数据的报告只归档，不覆盖该最新状态。同日重跑、旧日期补跑或使用更旧数据的运行保留独立目录；已完成准备且被流程捕获的生成失败保留 `run.json`。现有成功状态继续供下次运行使用。

生产流程在一个 job 中顺序执行，所有生产运行共享固定 concurrency group，并设置 `cancel-in-progress: false`。归档使用 `force: false` 的 Git ref 更新和最多三次事务尝试；冲突后重新读取当前分支。发布响应丢失时先检查 run marker，已生成的报告直接重试归档，不再次调用模型。

## 5. 日常维护与故障定位

生产业务阶段只向 Actions 输出固定状态和错误代码；安装与 CI 保留常规输出。真实报告、指标、模型输出不会进入公共 artifact、cache、step summary、Issue 或 PR；临时目录在 workflow 末尾清理。CI 仅使用合成数据和模拟提供方，运行 `npm test`、`npm run check`、`npm run demo`，不绑定生产环境。

| 现象或错误代码 | 处理 |
| --- | --- |
| `CONFIG_REPORTS_REPOSITORY_ID_REQUIRED` | 创建并核实私有仓库后填写真实数字 ID |
| `ARCHIVE_TARGET_NOT_FOUND`、`ARCHIVE_TARGET_MISMATCH` | 核对仓库名称、ID、PAT 的目标仓库和访问权 |
| `ARCHIVE_TARGET_NOT_PRIVATE`、`ARCHIVE_TARGET_DISABLED` | 恢复目标私有且可写的状态，再手动运行 |
| `CONFIG_INVALID_MODEL_ENDPOINT`、`CONFIG_INVALID_MODEL` | 核对 `DEEPSEEK_BASE_URL` 为无凭证的完整 HTTPS Base URL、`DEEPSEEK_MODEL` 为服务商接受的模型 ID |
| Google 数据显示未配置 | 页面巡检可正常运行；需要搜索效果时添加 Google 凭证 |
| 已提供 Google 凭证，但发生授权或 API 错误 | 核对服务账户 JSON、属性授权、已启用的 API 与日期范围；不会自动忽略错误 |
| 模型凭证、超时或 JSON 校验错误 | 核对 DeepSeek 账户、API model id、Claude 版本和固定错误代码；校验失败的分析不会发布为成功报告 |
| 发布失败 | workflow 尝试归档已有的六个文件；仍失败时保留失败状态，可通过 GitHub 重跑产生新的 attempt |
| 网页没有最新报告，但私有归档已成功 | 查看 `Publish private HTML report` 的固定状态；修复配置后单独重跑同步，无需重新调用模型 |
| `WEB_PUBLISH_VIEWER_URL_REQUIRED`、`WEB_PUBLISH_VIEWER_URL_INVALID` | 核对环境 Variable `REPORT_VIEWER_URL`，使用规定的 HTTPS origin，不附加路径、query 或凭证 |
| `WEB_PUBLISH_VIEWER_TOKEN_REQUIRED`、`WEB_PUBLISH_TOKEN_DESTINATION_INVALID` | 核对环境 Secret `REPORT_VIEWER_TOKEN`；不能使用 GitHub PAT 代替 |
| `WEB_PUBLISH_REQUEST_REJECTED` | 分别核对 GitHub 归档访问权和站点服务访问权限，不把任一凭证用于另一目的地 |
| `WEB_PUBLISH_PRIVATE_REPOSITORY_INVALID`、`WEB_PUBLISH_ARCHIVE_INVALID` | 核对私有仓库身份、访问权和已成功归档的 latest/run/HTML；未通过校验的内容不会同步 |
| 每日任务没有执行 | 核对 `GROWTH_ENABLED`、默认分支、环境的 `main` 分支规则和工作流启用状态 |

`prepare` 尚未成功时不会向私有仓库写失败记录；这类配置或访问错误只在 Actions 显示安全错误代码。运行进入采集阶段后，可结合私有 `run.json` 查看阶段信息。不要把真实报告或凭证贴到公共仓库的故障讨论中。
