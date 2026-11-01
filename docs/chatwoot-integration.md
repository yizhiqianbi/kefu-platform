# Chatwoot 接入方案

状态：第 1 期已在本机跑通（Chatwoot v4.19.1，接口收件箱联调），真实渠道待接。日期：2026-10-30。

## 1. 要解决什么

现在平台只有两个对外渠道：网页咨询页（`/muxu/c/{slug}`）和达人邮件外联（`mailer.py`）。外贸客户的询盘主要来自 WhatsApp、Instagram、Facebook、邮件和 TikTok，每个渠道单独对接成本太高。

方案：用 Chatwoot 当**渠道层和人工收件箱**，平台继续当**大脑**。

| 归 Chatwoot 管 | 归平台管（不变） |
|---|---|
| 接入各渠道、收发消息、附件、已读回执 | 知识库、AI 回答、引用出处 |
| 人工坐席收件箱、分配、快捷回复、内部备注 | 测试集、评测、待补问题（gaps） |
| 联系人基础资料、标签 | 达人和客户名单、评分、自动运营 |
| 渠道合规（24 小时窗口、模板消息） | 什么情况必须转人工的规则 |

不用 Chatwoot 自带的 AI（Captain），自部署要付费，而且答案没有平台的知识库和评测做保证。

## 2. 总体架构

```
 客户                         海外服务器（香港 / 新加坡）
 ─────                        ─────────────────────────────────────────────
 WhatsApp ─┐
 Instagram ┤                  ┌──────────────┐  ① Agent Bot 回调   ┌───────────────┐
 Messenger ┤   各平台回调      │   Chatwoot   │ ──────────────────▶ │  平台（muxu） │
 TikTok    ┼─────────────────▶│  每个客户    │                     │  chatwoot.py  │
 Telegram  ┤                  │  一个 account │ ◀────────────────── │               │
 LINE      ┤                  └──────────────┘  ② 发回复 / 转人工   └──────┬────────┘
 邮件      ┘                        ▲                                      │ ③ 问答
                                    │ 人工坐席在这里接手                    ▼
 微信客服 ── 转发服务（第三期）──────┘                              ┌───────────────┐
                                                                  │ RAGFlow + 模型 │
                                                                  └───────────────┘
```

一条消息的流程：

1. 客户在任一渠道发消息，Chatwoot 建会话。收件箱绑了 Agent Bot，会话初始状态是 `pending`，人工坐席默认看不到。
2. Chatwoot 把 `message_created` 事件推给平台的回调地址。
3. 平台立即返回 200，后台任务里：取这个会话的最近几轮消息，交给该客户的 RAGFlow 助手回答。
4. 能答：调用 Chatwoot「发消息」接口把回答发出去，会话保持 `pending`。
5. 需要人工：把会话改成 `open`，再加一条内部备注（客户要什么、AI 为什么不答、建议回复），坐席在 Chatwoot 收件箱接手。同时在平台记一条转人工记录和待补问题。
6. 坐席处理完，可以把会话改回 `pending` 交还给机器人。

### 2.1 部署位置

**Chatwoot 必须放海外。** 内地服务器连不上 Meta、TikTok、Telegram 的接口，这些平台的回调也打不进来。在内地服务器上自建代理出海违反云厂商条款；正规的跨境专线（阿里云 CEN、腾讯云 CCN）只用于自家国内和海外机器互联。

结论：**平台、RAGFlow、Chatwoot 放同一台香港机器**（腾讯云轻量香港 8 核 32GB，约 820 元/月，见 2.2）。

- 外贸客户用现有的 `migrate.py export/import` 按客户搬过去。
- 国内客户的访客数据放香港算数据出境。不想出境的客户留在现在的内地部署，不接 Chatwoot。
- 模型服务要换成海外能稳定访问的地址，比如百炼国际站或 OpenRouter。
- Cloudflare 只做前置（域名、证书、防护、Tunnel），附件可以存 R2；后端放不上去（容器磁盘不持久，内存上限 12GB）。

### 2.2 服务器配置

Chatwoot 官方的最低要求：

- **CPU 和内存**：4 核 4GB，每天最多约 1 万个会话。另外至少加 1GB 交换空间，否则升级时容易内存不够。
- **组件**：PostgreSQL 16（要带 pgvector 扩展，镜像用 `pgvector/pgvector:pg16`）、Redis 7 以上、Sidekiq 后台任务。

再加上平台和 RAGFlow（Elasticsearch、MySQL、MinIO、Redis 就要 8 到 10GB），海外机器建议 **8 核 32GB**，16GB 能跑但紧。附件存到对象存储（R2、OSS 或 S3），不要放本地。

## 3. 多客户映射

平台的一个客户（tenant）对应 Chatwoot 的一个 account，彼此看不到对方的数据。

| 平台 | Chatwoot | 怎么建 |
|---|---|---|
| tenant | account | Platform API `POST /platform/api/v1/accounts` |
| 客户的运营成员 | user，加入对应 account | `POST /platform/api/v1/users`，再 `POST /platform/api/v1/accounts/{id}/account_users` |
| 该客户的 AI | agent bot（只属于这个 account） | `POST /platform/api/v1/agent_bots`，回调地址带这个客户专用的随机令牌 |
| 运营台「打开收件箱」按钮 | 免密登录链接 | `GET /platform/api/v1/users/{id}/login` |

Platform API 只有自部署版有，要先在 `/super_admin/platform_apps` 建一个 Platform App 拿令牌。这个令牌只能操作它自己建出来的 account 和 user，所以**所有 account 都必须由平台建**，不要在 Chatwoot 界面里手动建。

平台新增一张表 `chatwoot_links`：

| 字段 | 说明 |
|---|---|
| tenant_id | 平台客户 |
| account_id | Chatwoot account |
| bot_id | agent bot |
| hook_token | 回调地址里的随机令牌，用来认出是哪个客户、防伪造 |
| enabled | 机器人开关，关掉后新会话直接给人工 |
| created | 创建时间 |

Bot 的 access token 和 Platform App 令牌都不进数据库，跟邮箱密码一样存成 `DATA_DIR/chatwoot/{tid}.secret`，权限 600。

开通时还会建一个**平台服务号**（`svc-{slug}-…@kefu.local`，account 管理员）。原因是 bot 令牌权限很窄（源码 `AccessTokenAuthHelper::BOT_ACCESSIBLE_ENDPOINTS`）：只能读会话、发消息、改状态、加标签，**不能读消息列表**，也不能建收件箱、给收件箱挂 bot。这些操作用服务号的令牌做。

已在源码里确认的几点：

- Platform API 建 user 和 agent bot 时会直接返回 `access_token`；建 user 时如果邮箱已存在，返回已有用户，不会报错。
- Agent bot 回调**有签名**：请求头带 `X-Chatwoot-Timestamp`，以及 `X-Chatwoot-Signature: sha256=HMAC(bot secret, "{timestamp}.{原始请求体}")`。bot secret 只有 account 管理员能读到（`GET /api/v1/accounts/{id}/agent_bots/{bot_id}`），开通时读出来存进 secret 文件。
- 回调里的会话 `id` 就是 display_id，可以直接用于会话接口。
- 回调失败（超时或非 2xx）时，Chatwoot 会自己把 `pending` 会话改成 `open`，并加一条「机器人出错」提示，客户不会没人管。

## 4. 平台要改的地方

### 4.1 新模块 `chatwoot.py`

- `client(tid)`：带 bot token 的 httpx 客户端。
- `provision(tenant)` / `deprovision(tenant)`：建或删 account、bot、成员。在「新建客户」和「删除客户」时调用。
- `history(account_id, conversation_id, n=10)`：取最近 n 条消息，转成 RAGFlow 要的 `messages` 格式。
- `reply(...)`、`note(...)`（内部备注，`private=true`）、`handoff(...)`（`toggle_status` 改成 `open`）。
- `sync_members(tenant)`：平台成员增删时同步到 Chatwoot。

### 4.2 新接口 `POST /muxu/api/chatwoot/hook/{hook_token}`

收到事件后按顺序处理：

1. **认来源**：用 `hook_token` 找到客户，找不到返回 404；验 HMAC 签名，不对或超过 5 分钟返回 401。即使验签通过，也只取 account 和会话 ID，内容回查 Chatwoot 拿。
2. **过滤**：只处理 `message_created`，消息类型是 `incoming`（客户发的），会话状态是 `pending`。坐席已接手（`open`）的会话机器人不插话。
3. **去重**：按 Chatwoot 消息 ID 去重，回调重发不会回答两次。
4. **合并连发**：客户 3 秒内连发几条，合成一个问题回答一次。
5. **额度和限流**：沿用 `quota_month` 和 `public_rate` 的逻辑，按会话限流。
6. **回答**：调 `engine.ask`（不用流式），结果写进 `messages` 表。`channel` 记成具体渠道（`whatsapp`、`instagram`、`email` 等），`session_id` 记成 `cw:{account}:{conversation}`。
7. **判断转人工**，满足任一条就转：
   - 回答命中现有的 `HANDOFF_RE`，或者 `could_not_answer` 判定答不上；
   - 客户消息命中价格、佣金、合同、退款、投诉一类的词（复用 `outreach.TERMS_RE`）；
   - 客户明确要找人；
   - 同一会话连续 2 次答不上；
   - 渠道限制下发不出去（见第 5 节）。
8. **记录**：转人工时写 `handoffs`（新增字段 `chatwoot_url`，运营台可以直接点开会话），答不上的写 `gaps`，现有的补问题流程照常用。

回调必须在几秒内返回，所有慢操作放后台任务里做。

### 4.3 运营台新增「收件箱」和「渠道」两页

**收件箱**：Chatwoot 坐席界面直接嵌在运营台里（iframe），坐席不用另开系统。

- 每个客户第一次打开时，平台用 Platform API 的免密登录链接（`GET /platform/api/v1/users/{id}/login`）自动登录。平台账号和 Chatwoot 用户一一对应，客户管理员对应 Chatwoot 的 administrator，运营对应 agent。
- 「转人工」页的记录有「在收件箱里打开这个会话」，点了直接跳到收件箱页的那个会话。
- **嵌入的前提：运营台和 Chatwoot 必须同站。** Chatwoot 的登录 cookie 是 `SameSite=Lax`，跨站的 iframe 里带不上。正式部署用同一个主域名下的两个子域名，比如 `kefu.example.com` 和 `inbox.example.com`；本机平台只对外开放 21048 一个 Web 端口，Chatwoot 和运营台共用它（同源）。
- 跨子域名部署时，Chatwoot 默认返回的 `X-Frame-Options: SAMEORIGIN` 会挡住嵌入，nginx 要去掉这个头，改成 `Content-Security-Policy: frame-ancestors <运营台地址>`，只允许运营台嵌入。本机同源，不用改。

**渠道**：

- 开通按钮（客户管理员可点），显示各收件箱和 AI 是否接管。
- AI 自动回答的总开关：关掉后新消息直接给人。
- 「给新收件箱接上 AI」：在 Chatwoot 里新加的 WhatsApp、邮箱等收件箱默认没挂 bot，点一下全部挂上。
- 本月按渠道统计：客户提问数、转人工数、AI 独立解决率。
- 渠道的授权和绑定（扫码、Meta 登录）在收件箱的「设置 → 收件箱」里做。
- 页面下方是接入教程：每个渠道一张卡片，写了要准备什么、超级管理员后台填哪些密钥、各平台后台怎么配、可复制的回调地址和限制。

**收件箱界面的精简和换肤**：改了 Chatwoot 前端源码，补丁在 `chatwoot-local/patches/kefu-ui.patch`。升级 Chatwoot 时在新源码上 `git apply` 这个补丁，再 `rake assets:precompile` 并重启 puma。

- 侧边栏只留：会话（全部、提及、未处理、渠道、标签）、联系人、设置（收件箱、客服、WhatsApp 模板、标签、快捷回复）。去掉了 Captain（企业版付费推广）、通话、公司、报表、营销活动、帮助中心，以及机器人、集成、自动化等容易把 AI 接管弄坏的设置。页面本身没删，知道网址仍能打开。
- 头像菜单去掉「外观」和「退出登录」：登录由运营台免密登录管理，主题只做了浅色。
- 配色、字体换成运营台的：`_kefu-theme.scss` 覆盖颜色变量，`theme/colors.js` 的 `brand` 改成胡桃木色，`tailwind.config.js` 换中文字体。AI 的回复是米色气泡，同事的回复是浅木色。
- 安装名称 `INSTALLATION_NAME`、`BRAND_NAME` 改成「智能客服」，Chatwoot 会按自定义品牌实例处理，隐藏官方文档和更新日志链接。
- 每个 Chatwoot 账号关掉 `captain_tasks`、`help_center`、`campaigns`。新开通的客户由 `chatwoot.py` 建账号时自动关闭。

### 4.4 已实现（第 1 期）

| 部分 | 位置 |
|---|---|
| Chatwoot 接口、开通、单点登录、验签、长消息切分 | `chatwoot.py` |
| 回调接口、3 秒合并连发、去重、额度和限流、转人工、记录 | `server.py`「chatwoot channels」一节 |
| 运营台接口：`GET/PUT /muxu/api/console/channels`、`POST …/channels/link`、`…/attach`、`…/login` | `server.py`「console: channels」一节 |
| 收件箱页、渠道页、转人工记录跳转 | `static/console.js`、`console.css` |
| 新表 `chatwoot_links`，`handoffs.chatwoot_url` 新列，`messages.channel` 记具体渠道 | `db.py`（启动时自动加） |
| 配置项 | `.env.example` 里的 `CHATWOOT_*`、`MUXU_PUBLIC_URL` |

额度和用量统计改成「除运营台试聊外都算」，各渠道的消息和网页咨询共用一个月额度。

还没做：海外部署的编排（`deploy/`）、24 小时窗口和模板消息、删除客户时删 Chatwoot account、平台成员增删时同步到 Chatwoot。

### 4.5 本机运行

| 组件 | 位置 / 端口 |
|---|---|
| Chatwoot 源码、Ruby 3.4.4、Node 24 | `/home/hubin/chatwoot-local/`（`src/`、`tools/`） |
| PostgreSQL 16 + pgvector | 系统 apt 安装，127.0.0.1:5432，库 `chatwoot_production` |
| Redis（Chatwoot 专用，和 RAGFlow 的分开） | 127.0.0.1:6380 |
| Chatwoot web / sidekiq | 127.0.0.1:3000，和 RAGFlow 共用 nginx `21048`，按 Chatwoot 的路径前缀（`/app`、`/auth`、`/cable`、`/vite`、`/api/v1/accounts` 等）分流，见 `nginx/chatwoot.conf` |
| 密码和令牌（600） | `chatwoot-local/.pgpw`、`.redispw`、`.superadmin`、`src/.env`；平台侧 `muxu/data/.chatwoot_platform_token` |
| 启动 | `bash /home/hubin/chatwoot-local/start.sh`（`start_ragflow.sh` 和 `keepalive.sh` 已带上） |

**用社区版**：`enterprise/` 目录的代码要买 Chatwoot 企业授权才能在生产用。本机由 `start.sh` 和 `src/.env` 设 `DISABLE_ENTERPRISE=true`，正式部署用官方带 `-ce` 后缀的镜像。平台用到的 Platform API、Agent Bot 回调、会话和联系人接口、各渠道都在社区版里，已在社区版模式下跑通全流程（分流、草稿审核、以同事身份发消息、托管切换、免密登录、功能开关）。社区版没有 Captain、自定义角色、SLA、语音通话，平台都不用。

本机部署踩过的坑：

- `RAILS_ENV=production` 必须在命令行导出。写在 `.env` 里太晚，rake 会去加载开发用的 `annotate_rb`，然后报错。
- 命令行建的超级管理员不会清「首次安装引导」标记，所有页面都会跳到 `/installation/onboarding`。要手动删 Redis 键 `CHATWOOT_INSTALLATION_ONBOARDING`。
- 平台和 Chatwoot 同机时，回调地址是内网地址，Chatwoot 的 SSRF 保护会拦。要设 `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`。
- sidekiq 启动后会改进程名，守护脚本要用 pid 文件判断它是否在跑。

联调方法：在 Chatwoot 里临时建一个 API 收件箱，用它的客户端 API（`/public/api/v1/inboxes/{inbox_identifier}/contacts/...`）模拟客户发消息，测完删掉收件箱和测试数据。开通客户时不会自动建这个收件箱。已测：

- 普通产品问题：AI 回答，会话保持 `pending`。
- 3 秒内连发两条：合并成一个问题，只回答一次。
- 问底价、要找真人：先回一句「请同事跟进」，会话转 `open`，附内部备注，记转人工和待补问题。
- 坐席接手期间：AI 不插话。
- 交还机器人后：AI 接着答，答不上会再转人工。
- 回调没签名返回 401，令牌不对返回 404。
- 运营台收件箱页：自动登录，从转人工记录能跳到对应会话。

### 4.6 运营台按业务重排（第 2 期）

侧边栏改成 6 个模块，原来的页面变成模块里的标签页，网址（`#kb`、`#outreach` 等）不变：

| 模块 | 标签页 |
|---|---|
| 总览 | 老板视角：今天提问数和各渠道分布、AI 独立解决率、转人工、要处理的事、近 7 天趋势、意向客户（询价、样品、谈判阶段）、外联漏斗、知识库缺口 |
| 知识库 | 资料和问答、对话（试聊）、待补问题、上线状态（原总览的助手和上线检查）、测试题、回归测试、检索调试 |
| 邮件 | 收件（Chatwoot 邮件收件箱的会话）、外联（原「主动跟进」） |
| 社媒消息 | 会话（除邮件外的所有渠道）、转人工记录、渠道设置、完整收件箱（Chatwoot 原界面，从会话里点进去） |
| 客户 | 各渠道联系人合并成一份档案：类型、渠道、进展、状态、备注、会话和外联往来 |
| 设置 | 不变 |

**会话界面是自己做的，Chatwoot 只当引擎**：左边会话列表（进行中、需要人工、AI 托管、待审核、已结束，按渠道筛、搜索），中间聊天窗（AI 托管和人工切换、结束会话、AI 草稿审核框、回复、内部备注、AI 帮写），右边客户、跟进进度和回复时限。每 6 秒刷新一次。同事用自己的 Chatwoot 账号发消息（Platform API 取用户的 `access_token`），Chatwoot 里能看到是谁回的。

**托管规则**：

- 每个会话有 `cw_convs.mode`（`ai` 或 `human`），Chatwoot 的状态跟着它：AI 托管是 `pending`，人工是 `open`。在 Chatwoot 原界面里改状态，也会通过状态事件同步回来。
- 每个收件箱有「新会话默认」开关（`cw_inboxes.hosted`，默认 AI 托管），在「渠道设置」里改。会话结束后恢复成默认值。
- AI 托管时按客户消息分流：咨询类 AI 直接回；报价、样品、合同、佣金一类先回一句「稍后答复」，正式回复起草进 `cw_drafts` 等人审核；投诉或要找人的转人工。
- 同事在 AI 托管的会话里发了消息，会话自动转人工。内部备注不算。
- AI 跟进（`convs.loop`，每 5 分钟）：AI 托管、我们最后回复、客户一直没回的会话，到时起草一条跟进等审核。有回复时限的渠道（WhatsApp、Instagram、Messenger 24 小时，TikTok 48 小时）在客户沉默 20 小时、且时限还剩至少半小时时起草；没有时限的渠道 72 小时后起草。同一会话最多跟进 2 次。同一个循环还会给有新消息的会话做总结：所处阶段、一句话总结、下一步。

**外联改走 Chatwoot 邮件收件箱（可选）**：在「外联 → 自动运营 → 发信方式」选「用社媒消息里接入的邮件收件箱发」，每位达人一个 Chatwoot 会话（标了 `kefu_outreach`），对方回复后照旧进外联的「待审核」，往来邮件在「邮件 → 收件」也能看到。用这个方式时不再走 IMAP 收信。

新表 `cw_inboxes`、`cw_convs`、`cw_drafts`，`contacts` 加了 `phone`、`cw_contact_id`，客户类型多了「询盘客户」（社媒和邮件里来咨询的人自动建档）。接口都在 `server.py`「console: inbox」「customers」「dashboard」几节，后台循环和起草在 `convs.py`。

联调（临时 API 收件箱，测完已删）：问保修 AI 直接回；要报价先回「稍后答复」、起草报价等审核，草稿会根据知识库提醒「产品线里没有车顶帐篷」；投诉直接转人工；审核发送、人工回复自动转人工、内部备注、手动切托管、结束会话后恢复默认托管、AI 帮写、AI 总结都正常。

### 4.7 个人号（第 3 期）

官方渠道要平台开发者审核，还要一个外网能访问的 HTTPS 域名（平台把消息推过来）。个人号这条路两样都不要：由我们主动连平台，用个人账号收发私信。在「社媒消息 → 渠道设置 → 个人号」里添加和登录，管理员才能操作。

| 平台 | 怎么连 | 登录 | 风险 |
|---|---|---|---|
| Telegram | 官方用户协议 MTProto（Telethon），平台允许 | 先在 my.telegram.org 申请 api_id / api_hash，再用手机号 + Telegram App 里收到的验证码，开了两步验证再填云密码 | 低 |
| WhatsApp | Baileys，社区逆向的 WhatsApp Web 协议，跑在 `wa-bridge/`（Node） | 手机 WhatsApp「已关联的设备」扫码，或填手机号用 8 位配对码 | 中：自动回复量大、被举报会封号 |
| Instagram | instagrapi，社区逆向的 App 私有接口，每 25–45 秒拉一次私信 | 用户名 + 密码（只用这一次，不保存），按提示填短信、邮箱或验证器里的码 | 高：风控最严；从共用代理 IP 登录容易被要求验证或限流 |
| Messenger | ws3-fca，社区逆向的 Facebook 网页接口，消息走 MQTT 长连接实时到；一个号一个 Node 进程（`fb-bridge/`） | 账号密码由服务器上的浏览器去 facebook.com 登录（要验证时弹窗里显示页面截图，可在手机上点确认或填码），或贴浏览器导出的 cookie | 高：Facebook 对新设备、新 IP 登录很敏感 |
| TikTok | 没有接口也没有库，服务器上的无界面浏览器一直开着这个号的网页版私信，每 20–35 秒看一次有没有新消息，回复时在网页里打字发送 | 手机 TikTok 扫码 | 中：页面改版就要调选择器；一个号常驻一个浏览器，约占 300 MB 内存 |

LINE 的个人号私信没有还在维护的开源实现，没做。详见 4.9。

**怎么接进现有流程**：每个个人号在 Chatwoot 里是一个 API 收件箱，名字是「WhatsApp 个人号 · 备注名」，渠道名是 `wa_personal` / `tg_personal` / `ig_personal` / `fb_personal` / `tt_personal`（会话页、客户页、AI 提示词里显示「WhatsApp 个人号」等）。

- 对方的私信由 `personal.py` 写进收件箱当客户消息，AI 托管、分流、起草审核、转人工、跟进全部照旧。
- 收件箱里发出的消息（AI 或同事）由 Chatwoot 推到 `POST /muxu/api/personal/hook/{token}`，再用个人号发出去。Chatwoot 只等 5 秒，所以先回 200，在后台发；发失败在会话里留一条内部备注。
- 号主在手机上亲自回的消息也同步进会话；如果会话在 AI 托管，自动转人工，AI 不再插话。
- 防回声：我们写进 Chatwoot 的不再发回平台；我们在平台发出的，平台回显时不再写进 Chatwoot；同一条消息重复到达只收一次。
- 只收登录之后的消息，登录前的聊天记录不导入。群聊、频道、公众号消息不收。

**文件和进程**：会话文件和 Telegram 的 api_id / api_hash 在 `data/personal/{id}/`（目录 700、文件 600），不进数据库，也不回给浏览器。WhatsApp 的 `wa-bridge/` 只听 127.0.0.1:8771，和 muxu 用 `data/personal/wa-bridge.token` 互相认证；第一次登录 WhatsApp 时由 muxu 拉起，muxu 重启它不跟着重启，连接不断。muxu 启动时会自动重连所有登录过的号。新表 `personal_accounts`、`personal_peers`。

**部署**：`pip install telethon "python-socks[asyncio]" instagrapi playwright && playwright install chromium`；`cd wa-bridge && npm install`；`cd fb-bridge && npm install --ignore-scripts`。连平台走 `PERSONAL_PROXY`，不填就用本机的 `HTTPS_PROXY`；海外服务器上留空直连。

联调（本机，没有登录真实账号，测完已删）：WhatsApp 能拿到登录二维码和配对码；Telegram 返回「API ID 不对」、Instagram 返回「等几分钟再试」，说明这台机器经代理都能连上平台。把一个 Telegram 测试号标成在线，模拟对方发来「保修期多久」：私信进了收件箱，AI 回复了，回复也推回了个人号模块（测试号没真登录，所以在会话里留了「没发出去」的备注）。防回声和去重单独测了五种情况，都对。真实账号的收发要用你自己的号登录后再验证。

### 4.8 企业微信 · 微信客服（第 3 期）

和个人号共用 `personal.py` 那一套（API 收件箱、去重防回声、手机或客户端里亲自回复就转人工），平台名 `wecom`，渠道名 `wecom_kf`，显示「企业微信客服」。在「社媒消息 → 渠道设置 → 个人号和企业微信 → 添加 → 企业微信」里配置。

**企业微信后台要做的**（弹窗里也有提示）：

1. 「应用管理 → 自建 → 创建应用」，可见范围包含接待的同事，记下 Secret；企业 ID 在「我的企业」最下面。
2. 「微信客服 → API」：「可调用接口的应用」选这个自建应用；「通过 API 管理微信客服账号」选上要接的客服账号。选上后这个账号的消息全部交给接口，企业微信里原来的接待规则不再生效。
3. 应用的「企业可信 IP」加上服务器的出口 IP（填错时报错里会写出来）。2022 年 6 月以后新建的应用，要先配好「接收消息服务器 URL」或可信域名，才能填可信 IP。

**收消息**：

- 有公网地址（`CALLBACK_BASE_URL`）时用回调：在应用「接收消息 → 设置 API 接收」填弹窗给出的 URL（`/muxu/api/wecom/callback/{token}`），Token 和 EncodingAESKey 随机生成后抄进弹窗。先在我们这边点完成，再回企业微信点保存，它会来校验。回调只通知「有新消息」，带一个 10 分钟有效的 token，我们拿它调 `kf/sync_msg` 增量拉取（游标存在 `data/personal/{id}/wecom.json`），另外每 2 分钟兜底拉一次。
- 没有公网地址时每 15 秒拉一次。官方说不带回调 token 的拉取「有严格的频率限制」，被限流会自动退避，最长 10 分钟。

**发消息的限制**（官方规则，在驱动里先拦下）：客户发一条消息后 48 小时内最多回 5 条；客户再发，额度重新算。超了不调接口，会话里留内部备注说明原因。AI 跟进按 48 小时时限起草。单条按 600 字切分（接口上限 2048 字节）。接待同事在企业微信客户端里回复的消息（`origin=5`）也同步进会话，并把会话转人工。

**这台机器上的情况**：企业微信接口要走代理才能连上，企业微信看到的出口 IP 是 `150.109.196.248`（公司共用的代理出口）。这台机器只有公司内网域名，企业微信的回调推不进来，又因为上面第 3 条，新建应用配不了可信 IP。所以要真正用起来，得部署到有公网 HTTPS 域名的服务器上，或者用一个 2022 年 6 月以前建的自建应用。

联调（假的企业 ID，测完已删）：回调加解密用官方示例数据核对通过；保存回调时的 URL 校验、签名不对时拒绝、收到新消息通知后去拉取都正常；模拟客户发「便携空调保修多久」，AI 用中文回答「整机保修期为一年」，回复交给企业微信去发（因为企业 ID 是假的，会话里留了「没发出去：企业 ID 不对」）；登录前的旧消息不收；48 小时 5 条、客户再发后恢复、超过 48 小时、同事在企业微信里回复转人工都按预期。

### 4.9 Messenger 和 TikTok 个人号（第 3 期）

**选库前先审代码**：用户的 Facebook 登录凭据会交给这个库，所以下载 npm 包源码逐个看过。
- `@dongdev/fca-unofficial` 不用：它在运行时自己执行 `npm i` 装最新版，等于作者随时能往服务器推代码，还内置了一个第三方服务器地址。
- 选了 `ws3-fca` 3.5.2：没有混淆代码、没有执行外部命令、除 Facebook 外不连别的地址。
- `package.json` 锁死版本，`npm install --ignore-scripts` 装，不跑任何安装脚本。

**Messenger**：
- `ws3-fca` 把登录状态放在模块的全局变量里，同一个进程只能挂一个号。所以每个号单独起一个 `node fb-bridge/worker.js data/personal/{id}`。它和 muxu 走标准输入输出，一行一个 JSON，不开端口；库自己的日志写到 `logs/fb-bridge.log`。
- 登录后的 cookie 存在 `data/personal/{id}/messenger.json`（600），每 10 分钟刷新一次。浏览器登录用的临时资料目录登录完就删。
- 进程意外退出会自动重连，等待时间从 30 秒起翻倍，最长 10 分钟。cookie 失效时状态显示「需要重新登录」。
- 断线期间到的消息不会补收。

**TikTok**：
- 浏览器资料目录在 `data/personal/{id}/tiktok-browser/`，登录状态靠里面的 cookie。muxu 重启时自动重新打开。
- 刚登录时，把私信列表前 20 个会话已有的消息记下来，只有之后的新消息才交给 AI。之后每次只打开列表里预览有变化的会话。新消息判断：比对上次看到的最后一条；没见过的会话，只取我们最后一次回复之后的消息。
- 页面上没有消息时间，所以「只收登录后的消息」靠上面这套比对，不靠时间。
- 页面选择器集中在 `personal.py` 的 `TT` 里，TikTok 改版时只改那里。

**联调**（这台机器，没有登录真实账号，测完已删）：
- **TikTok**：扫码登录页经代理能打开，拿到的二维码解出来是 TikTok 的登录链接，弹窗里能显示。做了一个和网页版结构相同的模拟私信页，以下都按预期：登录前的旧消息不收；新客户私信进收件箱、AI 回复；两行回复用 Shift+Enter 换行发出；自己发的不重复收；号主在手机上回复后会话转人工。
- **Messenger**：库经代理能连上 Facebook；cookie 缺 `c_user` / `xs` 时直接提示，假 cookie 报「需要重新登录」并删掉 cookie 文件，代理不通报「断开」；浏览器登录在密码不对时停下，并把 Facebook 的页面截图给用户看。用假子进程测了：收私信；同一条重复到达只收一次；发送拿到消息 id；自己发的不重复收；进程崩溃后自动重连回「在线」。
- 用真实账号收发还没验证，要你用自己的测试号登录后再看。

## 5. 渠道清单

除特别说明外，所有渠道的回调地址都是 Chatwoot 的域名，需要 **HTTPS 公网域名**，下表用 `cw.example.com` 示意。

| 渠道 | 需要准备 | Chatwoot 里配置 | 平台回调地址 | 限制 |
|---|---|---|---|---|
| **邮件** | 一个**询盘专用**邮箱（企业邮箱、Gmail 或 Microsoft 365） | 新建 Email 收件箱：IMAP/SMTP，或 Google、Microsoft 登录授权 | 无 | 没有时间窗口；单条最长 25,000 字 |
| **WhatsApp** | Meta 商业账号（建议做企业认证）、一个没注册过 WhatsApp 的号码、Meta 开发者应用 | 超级管理员后台 `/super_admin/app_config?config=whatsapp_embedded` 填 `WHATSAPP_APP_ID`、`WHATSAPP_APP_SECRET`、`WHATSAPP_CONFIGURATION_ID`；客户在收件箱里点「Connect with WhatsApp Business」 | Meta 自动配置 | 客户最后一条消息 24 小时后只能发审核过的模板消息；按条收费；Meta 禁止通用 AI 助手，只能回答本企业业务 |
| **Facebook Messenger** | 公司主页、Meta 开发者应用（`pages_messaging` 权限要过审核） | `.env` 填 `FB_APP_ID`、`FB_APP_SECRET`、`FB_VERIFY_TOKEN` | `https://cw.example.com/bot` | 24 小时窗口；单条最长 2,000 字 |
| **Instagram** | Instagram 专业账号、Meta 应用（Instagram 产品，要过审核，应用必须切到 Live） | `/super_admin/app_config?config=instagram` 填 `INSTAGRAM_APP_ID`、`INSTAGRAM_APP_SECRET`、`INSTAGRAM_VERIFY_TOKEN` | 回调 `https://cw.example.com/webhooks/instagram`，跳转 `https://cw.example.com/instagram/callback` | 24 小时窗口；申请 `human_agent` 权限后人工可延长到 7 天；单条最长 1,000 字 |
| **TikTok** | TikTok 企业号、TikTok 开发者应用（商家私信权限，能否申请到取决于地区，要实际确认） | `/super_admin/app_config?config=tiktok` 填 `TIKTOK_APP_ID`、`TIKTOK_APP_SECRET` | 回调 `https://cw.example.com/webhooks/tiktok`，跳转 `https://cw.example.com/tiktok/callback` | 只能回复别人发来的私信，**不能主动给达人发**；对方最后一条消息 48 小时内能回；单条最长 950 字。授权时 9 个权限范围（user.info.basic、user.info.username、user.info.stats、user.info.profile、user.account.type、user.insights、message.list.read、message.list.send、message.list.manage）必须全给，少一个就失败 |
| **Telegram** | 找 BotFather 建一个 bot，拿到 token | 新建 Telegram 收件箱，填 token | Chatwoot 自动注册 | 不能主动发起会话；最适合拿来做联调测试 |
| **LINE** | LINE 官方账号、LINE Developers 的频道凭证 | 新建 LINE 收件箱 | 按 Chatwoot 页面提示填到 LINE 后台 | 单条最长 2,000 字；不支持已读回执 |
| **短信** | Twilio 或 Bandwidth 账号和号码 | 新建 SMS 收件箱 | 按提示填到 Twilio | 单条最长 320 字（Twilio）；按条收费 |
| **网站聊天** | 无 | 见下面第 5.1 节 | 无 | 无 |
| **微信客服 / 企业微信** | 企业微信、微信客服账号，开发者回调 | 新建 API 收件箱 | 自己写转发服务 | 第三期再做，见下面第 5.2 节 |

所有 Meta 系渠道（WhatsApp、Messenger、Instagram）可以共用一个 Meta 开发者应用，只需一次企业认证。审核通常要几天到几周，**这是整个项目最长的等待项，应该第一周就提交**。

各渠道单条长度不同，回答超长时平台按句子切成几条发，不要硬截断。

### 5.1 网站聊天

现在的咨询页有品牌样式、流式输出和引用出处，比 Chatwoot 自带的聊天窗口好。第一、二期**保留现有咨询页**。

第三期再用 Chatwoot 的 API 收件箱把网页会话同步进去：机器人仍由平台回答，转人工后坐席在 Chatwoot 收件箱回复，回复推回咨询页。这样坐席只看一个收件箱。

### 5.2 微信客服和企业微信

已接入（见 4.8），走企业微信的微信客服接口：客户在普通微信里点客服链接或扫码就能聊。企业微信的「客户联系」（员工和客户的单聊）没有收发消息的接口，接不了。

### 5.3 和达人自动运营的关系

- **TikTok 达人外联**：Chatwoot 的 TikTok 渠道只能回私信，不能主动给达人发。所以外联还是现在的做法：起草好，人工去 TikTok 发。
- **邮件外联**：两种发法。用平台的 `mailer.py`（SMTP 发、IMAP 收）时，**要和询盘用不同的邮箱**，两边同时读一个邮箱会抢同一批邮件。改用 Chatwoot 邮件收件箱发时（见 4.6），外联和询盘可以共用一个收件箱，外联会话由「外联」审核，询盘会话按托管规则处理。

## 6. 安全和合规

- **密钥**：Platform App 令牌、bot token、各平台应用密钥都只存在服务器上，不进 git，不进数据库明文字段。
- **关闭注册**：Chatwoot 设 `ENABLE_ACCOUNT_SIGNUP=false`，只能由平台建号。
- **回调**：令牌放在地址里，消息内容一律回查 Chatwoot 确认，不信推送的数据。
- **AI 边界**：WhatsApp 条款不允许通用 AI 助手。提示词里限定只回答本企业产品和业务，问到无关内容礼貌拒绝。
- **退订**：客户说不要再联系，就打标签停止自动回复。复用 `mailer.is_opt_out` 的判断。
- **数据出境**：海外客户的数据放在海外部署，不回传内地。要在客户合同里写明数据存放位置和保存期限。
- **开源协议**：Chatwoot 是 MIT 协议（`enterprise/` 目录另有协议，不要用里面的代码），二次开发和商用没有开源义务。

## 7. 分期计划

| 期 | 内容 | 工作量 | 外部等待 |
|---|---|---|---|
| 第 0 期 | 买海外机器；部署 Chatwoot 和平台；建 Platform App；**同时提交 Meta 企业认证和应用审核、TikTok 开发者申请** | 2 到 3 天 | Meta 和 TikTok 审核几天到几周 |
| 第 1 期 | `chatwoot.py`、回调接口、转人工、运营台「渠道」页；用 Telegram 和邮件联调，跑通「收到 → AI 回答 → 转人工 → 坐席回复 → 交还机器人」 | 5 到 7 天 | 无 |
| 第 2 期 | WhatsApp、Messenger、Instagram 上线（审核通过后）；24 小时窗口和模板消息处理；按渠道统计 | 3 到 5 天 | 号码和模板审核 |
| 第 3 期 | TikTok、LINE、短信；网站咨询页同步进收件箱；微信客服转发服务 | 5 到 8 天 | TikTok 权限 |

先拿一个外贸客户（比如讲师样例 HAFYOUNG）试点，第 1 期跑稳后再开放给其他客户。

## 8. 需要你准备或决定的

1. **海外机器**：倾向腾讯云轻量香港 8 核 32GB（约 820 元/月），待下单。
2. **域名**：给 Chatwoot 一个子域名（比如 `inbox.你的域名`），海外机器不用备案。
3. **Meta**：用哪个 Facebook 账号和公司主体做企业认证和开发者应用。平台统一一个应用、所有客户共用，还是每个客户用自己的应用。前者省事，后者号码和数据归属更清楚。
4. **WhatsApp 号码**：试点客户准备一个没注册过 WhatsApp 的号码。也可以用 Meta 的共存模式（Coexistence），继续用手机上的 WhatsApp Business App 号码，但要先确认 Chatwoot 支不支持。
5. **试点客户**：先拿哪个客户、哪几个渠道开始。

## 9. 风险和待确认

- **跨境延迟**：如果暂时不能把外贸客户整体搬到海外，平台和 Chatwoot 之间走跨境链路，回答会慢，偶尔会断。上线前要实测。
- **TikTok 商家私信权限**：不同地区开放情况不同，申请前确认试点客户的地区能用。
- **Meta 审核**：审核不过的常见原因是隐私政策页缺失、演示视频不清楚。要提前准备好隐私政策页（官网上就可以）和录屏。
- **Chatwoot 升级**：每次升级前备份 PostgreSQL；大版本升级（比如 v4 要求 pgvector）先在测试机上演练。
