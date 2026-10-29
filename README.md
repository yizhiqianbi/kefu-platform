# 智能客服平台

多客户的知识库客服：每个客户有自己的咨询页、可嵌入网站的聊天按钮、运营台（知识库、测试题、自动评分、上线把关、成员）。平台管理员在后台开客户、管账号、看用量。问答能力由 [RAGFlow](https://github.com/infiniflow/ragflow) v0.27.3 提供，本服务只负责多客户、账号、页面和评分。

| 地址 | 用途 |
|---|---|
| `/muxu/` | 默认客户的咨询页 |
| `/muxu/c/<客户代号>/` | 某个客户的咨询页，加 `?embed=1` 是嵌入模式 |
| `/muxu/embed.js` | 网站嵌入脚本：`<script src=".../muxu/embed.js" data-tenant="代号" data-color="#hex" async></script>` |
| `/muxu/console/` | 运营台和平台后台（同一个登录入口，按角色显示） |

## 目录

```
server.py      接口和页面路由
auth.py        登录、会话、按客户隔离（tenant_ctx 是唯一的权限入口）
db.py          表结构（SQLAlchemy Core，默认 SQLite，可换 PostgreSQL）
engine.py      RAGFlow 封装：开客户时建知识库、问答库和助手
grading.py     测试题评分；llm.py 调评分模型
settings.py    所有配置从环境变量或 .env 读
calibrate.py   评分器校准：python3 calibrate.py <客户代号>
seed_muxu.py   一次性迁移脚本，从旧版单客户 muxu.db 导入
shots.py       截图走查（需要 playwright）
static/        咨询页、运营台、嵌入脚本
deploy/        部署文件，见下文
```

## 部署到新服务器

建议配置：4 核 16G、100G SSD，Ubuntu 22.04，装好 Docker。RAGFlow 自带 MySQL、Elasticsearch、Redis、MinIO，内存主要花在它身上。

### 1. 启动 RAGFlow

```bash
sudo sysctl -w vm.max_map_count=262144
echo "vm.max_map_count=262144" | sudo tee -a /etc/sysctl.conf
git clone -b v0.27.3 https://github.com/infiniflow/ragflow.git
cd ragflow/docker
# docker/.env 里把网页端口改成 8080，把 80 留给下面的 nginx；顺便改掉默认口令 infini_rag_flow
docker compose -f docker-compose.yml up -d
```

在 RAGFlow 网页里注册账号，然后：

1. 模型供应商里加对话模型和向量模型。本机用的是 OpenRouter：对话 `deepseek/deepseek-v4.1-flash`，向量 `qwen/qwen3-embedding-8b`。换成 DeepSeek、百炼等国内渠道也可以。
2. 在 API 页面生成一个 API Key，下一步要用。

### 2. 启动客服平台

```bash
sudo git clone <本仓库地址> /opt/kefu-platform
cd /opt/kefu-platform
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env
```

改 `.env`（字段说明见 `.env.example`）：

```
MUXU_DATA_DIR=/var/lib/muxu
RAGFLOW_URL=http://127.0.0.1:9380/api/v1
RAGFLOW_API_KEY_FILE=/etc/kefu/ragflow_api_key
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY_FILE=/etc/kefu/llm_api_key
JUDGE_MODEL=deepseek/deepseek-v4-pro
```

密钥只放在文件里，不要写进 `.env` 或提交到仓库：

```bash
sudo mkdir -p /etc/kefu && sudo chmod 700 /etc/kefu
echo -n '<RAGFlow API Key>' | sudo tee /etc/kefu/ragflow_api_key >/dev/null
echo -n '<评分模型 Key>'    | sudo tee /etc/kefu/llm_api_key >/dev/null
sudo chmod 600 /etc/kefu/*
```

开机自启和对外访问：

```bash
sudo cp deploy/muxu.service /etc/systemd/system/ && sudo systemctl enable --now muxu
sudo cp deploy/nginx/kefu.conf /etc/nginx/conf.d/ && sudo nginx -t && sudo systemctl reload nginx
```

### 3. 首次登录

第一次启动会自动建平台管理员 `admin@muxu.local`，密码在 `$MUXU_DATA_DIR/.admin_password`，首次登录要求改密码。登录 `/muxu/console/` 后在平台后台开客户，系统会在 RAGFlow 里自动建好这个客户的知识库、问答库和助手。

## 迁移现有客户

平台数据库（`platform.db`）里记着每个客户在 RAGFlow 里的知识库和助手 ID，所以**平台数据和 RAGFlow 数据要一起搬**，只搬一边会对不上。数据里有客户对话和账号，不进 git，单独打包传输。

## 备份

要备份的有两部分：`$MUXU_DATA_DIR`（平台数据库和密码文件），以及 RAGFlow 的 Docker 数据卷（MySQL、MinIO、Elasticsearch）。建议每天定时备份到另一台机器或对象存储。

## deploy/ 里的文件

- `muxu.service`、`nginx/kefu.conf`：新服务器用。
- `start_ragflow.sh`、`keepalive.sh`、`nginx/nginx.conf` 等：开发机上不用 Docker 跑整套服务的脚本，路径写死为 `/home/hubin/ragflow-local`，仅供参考。`ragflow_service_conf.patch` 是那套环境对 RAGFlow 配置的改动（只监听本机、去掉默认向量模型）。
