# SEO / GEO 模块（官网流量、站点体检、AI 可见度）

代码：`seo.py`（统计同步、汇总、体检、GEO 监测、后台循环）、`search.py`（Google Search Console、Bing Webmaster）、`server.py` 的 `/muxu/api/console/seo/*`、`static/console.js` 的四个页面、`site-kit/`（装到客户官网上的统计套件）。

## 1. 目标和边界

- 外贸 B 端官网流量小，要看的不是 PV，而是：每天来了多少真人、从哪来（搜索、AI、社交、外链、广告链接）、看了哪些页、有多少人点了询盘 / 邮件 / WhatsApp，以及 AI 爬虫有没有来抓。
- 不用 Google Analytics：不放 Cookie、不存 IP、不需要隐私弹窗，数据在客户自己的 Cloudflare 账号里。
- GEO：每周拿一组买家会问的问题去问带联网搜索的 AI，看答案里有没有提到我们、有没有引用我们的网站、排第几、提到了哪些同行。
- 过去的搜索数据（展示、点击、搜索词、排名）只有搜索引擎自己有，接 Google Search Console 和 Bing Webmaster 拿。

## 2. 统计套件（`site-kit/`，Cloudflare Pages Functions + D1）

| 文件 | 作用 |
|---|---|
| `public/k.js` | 页面脚本（1 KB 左右）：页面浏览带来源页和 `utm_source`；点击 `mailto:`、`tel:`、WhatsApp 链接、`data-quote`、`data-k` 记事件；表单提交记 `data-k` 或表单 id；视频第一次播放记 `play:…`；离开页面时记停留秒数。用 `sendBeacon` 发到 `/k/h`。`navigator.webdriver` 为真时不发 |
| `functions/k/h.js` | 收数据：拒绝爬虫 UA、非同源（`sec-fetch-site`）、超过 4 KB 的请求；来源页只存外站域名；访客号 = sha256(UTC 日期 \| 密钥 \| IP \| UA) 取 16 位，当天去重、第二天就对不上，不存 IP |
| `functions/_middleware.js` | 所有经过 Functions 的请求：UA 是爬虫就记一条（爬虫名、路径、状态码、国家、UA），不影响响应 |
| `functions/k/r.js` | 拉数据：`Authorization: Bearer STATS_KEY`（常数时间比较），按自增 id 增量返回，每次最多 5000 条；顺手删 90 天前的数据 |
| `lib/k.js` | 公共函数：爬虫识别（约 60 个名字，具体的排前面）、设备、建表 |
| `_routes.example.json` | 只让页面、`robots.txt`、`llms.txt`、`sitemap.xml`、`/k/*` 和大文件走 Functions，静态资源不计费 |

安装步骤在 `site-kit/安装说明.txt`，控制台「接入和设置」页可以下载整包。密钥在控制台生成（只显示一次），存 `data/seo/{tid}/stats.key`（600，目录 700），客户放进 Pages 的 `STATS_KEY` 机密变量。

## 3. 同步和汇总

- 后台循环每 5 分钟看一圈，每个站 30 分钟同步一次：从上次的最大 id 往后拉，存 `site_hits`（先删掉同站 id ≥ 本批最小 id 的行再插入，重拉不会重复）。403 = 密钥不对，404 = 没装套件，错误写进状态显示在设置页。
- 「官网流量」页（`traffic`）：访客（按天 + 访客号去重）、浏览、联系动作和转化率、平均停留、AI 爬虫和搜索爬虫次数，都和上一个同长周期对比；每日折线；来源分类（AI：chatgpt / perplexity / claude / gemini / copilot / deepseek 等；搜索；社交；外链；utm 链接；直接访问）；热门页面、国家、设备、语言、事件；最近的联系动作和它从哪来；爬虫表（分 AI 搜索、AI 用户代抓、AI 训练、搜索引擎、SEO 工具、其他，带说明和最常抓的页面）；最近 30 分钟在线。

## 4. 站点体检（`audit`）

- 抓首页和站内链接最多 25 页，检查 40 个内链是否 404；`robots.txt`（用 `RobotFileParser` 判断各 AI 爬虫是否被挡）、`sitemap.xml`、`llms.txt`；用各 AI 爬虫的 UA 实际请求首页看能否拿到 200；随机路径应返回 404；PageSpeed（PSI 接口，可配 `PAGESPEED_API_KEY`，匿名额度常 429）。
- 两张加权评分卡，和 `hafyoung-cooling/SEO-GEO-audit.md` 的口径一致：
  - SEO：标题和描述、H1、canonical / hreflang、结构化数据、图片 alt、内链、sitemap、robots、速度、移动端等；
  - GEO：AI 爬虫能否访问、`llms.txt`、带单位的事实数字、FAQ、规格表、`sameAs`、组织信息、认证、博客 / 案例等。
- 问题按严重程度排序给出改法。经代理请求 http 会被代理返回 502，http→https 跳转这项测不了时记为「没测」，不扣分。
- 每周自动体检一次，也可手动重跑（同一时间只跑一个）。

## 5. GEO 监测

- 问题：最多 40 个，分品类 / 采购 / 对比 / 品牌四类、带语言。可以让 AI 按品牌词、`llms.txt` 和知识库补充资料建议一批，人挑了再存。
- 引擎（OpenRouter）：Perplexity Sonar（约 0.006 美元 / 题，带引用链接）；DeepSeek V4.1 Flash + 网页搜索插件（约 0.009 美元 / 题）。默认只开 Perplexity，每周 20 题约 0.5 美元 / 月。
- 每个答案：品牌词是否出现（mentioned）、引用里有没有我们的域名（cited）、在列出的品牌里排第几（position），再用 `AGENT_MODEL` 抽出答案里提到的其他品牌。报告汇总提及率、引用率、历次趋势、常被提到的同行、常被引用的域名。
- 预算：设置里每月上限（默认 3 美元），开跑前按题数和引擎估算，超了不跑。

## 6. 搜索引擎后台（`search.py`，「搜索表现」页）

- Google：客户验证网站（推荐「网域」资源，DNS 加 TXT），在 Google Cloud 建服务账号、启用 Search Console API、下载 JSON 密钥，把服务账号邮箱加成 Search Console 的受限用户，然后在设置页上传 JSON。密钥存 `data/seo/{tid}/google.json`（600），只回给页面服务账号邮箱。用 `cryptography` 自己签 RS256 JWT 换只读令牌（`webmasters.readonly`），没有引入 Google SDK。
- 第一次拉最近 16 个月（Search Console 的上限），之后每 6 小时重拉最近 5 天（新数据会被修正）。按 日期、日期×搜索词、日期×页面、日期×国家、日期×设备 五种维度拉；总数用只按日期的结果，因为按搜索词拆时 Google 会藏掉搜索量很少的词。国家代码由 Google 的三位码转成两位码。还会读站点地图的提交和处理状态。
- 网站自动选：优先和官网域名对上的「网域」资源，其次同域名的网址前缀资源；账号里有多个时在设置页选。
- Bing：在 Bing Webmaster「从 Google Search Console 导入」，再生成 API 密钥填进设置页，存 `data/seo/{tid}/bing.key`（600）。每次整份重拉：每日展示和点击，搜索词和页面按周汇总（Bing 接口只给这么细）。
- 页面：点击、展示、点击率、平均排名（和上一个同长周期比）；每日展示和点击；「差一点上首页的词」（排名 4–20、展示 ≥ 10）；搜索词、页面、国家、设备、站点地图。
- 本机测过：JWT 发给 Google 能被解析（用假账号返回 account not found），Bing 错误密钥能识别；页面用临时假数据截图检查后删掉了。真实数据要等客户完成验证和授权。

## 7. 数据

| 表 | 存什么 |
|---|---|
| `seo_cfg` | 客户设置（站点、品牌词、域名、问题、引擎、每周开关、预算）和同步状态 |
| `site_hits` | 统计明细：远端 id、时间、日期、类型（pv / ev / end / bot）、路径、来源域名、国家、设备、语言、访客号、事件名或爬虫名、utm、停留秒数、状态码、爬虫 UA |
| `seo_audits` | 体检：状态、两项得分、完整结果 JSON |
| `search_rows` | 搜索数据：引擎、日期、维度（total / query / page / country / device）、值、点击、展示、排名 × 展示 |
| `geo_runs` / `geo_answers` | GEO 每次运行的汇总和每题每个引擎的答案、引用、提及、排名、同行、费用 |

## 8. 接口

都在 `/muxu/api/console/seo/` 下：`config`（GET / PUT，改要管理员）、`key`（POST，管理员，只返回一次）、`kit.zip`、`sync`、`traffic?days=`、`audits`（GET / POST）、`geo?run=`、`geo/runs`（POST）、`geo/questions`（PUT）、`geo/suggest`（POST）、`search?days=&engine=`、`search/{engine}`（PUT 接入 / DELETE 断开，管理员）、`search/{engine}/sites`、`search/{engine}/site`（PUT，管理员）、`search/sync`（POST）。

## 9. 实测（2026-11，瀚泱官网）

- 本机 `wrangler pages dev`：curl 和真实浏览器的浏览、事件、停留、爬虫都记上了；跨站和爬虫发的统计被拒；错密钥 403；视频 Range 请求仍是 206。
- 11 月 1 日部署到正式站（D1 `hafyoung-stats`，亚太区域）：线上浏览、邮件点击、爬虫都记上并同步回来，测试记录已删。
- 线上体检：SEO 95、GEO 60、9 页、所有 AI 爬虫都能拿到 200。主要问题：没有带单位的参数事实、没有 `sameAs`、没有规格表、没有博客、没有认证信息。
- GEO：不带品牌的品类问题里没有提到瀚泱（提到的是宁波和顺德的工厂）；带品牌的问题提到并引用了官网。

## 10. 还没做

- 瀚泱的 Google / Bing 验证和授权（等客户操作）。
- 用 IndexNow 在页面更新时通知 Bing / Yandex。
- 体检问题一键生成修复（如 `llms.txt`、规格表、FAQ 结构化数据）。
