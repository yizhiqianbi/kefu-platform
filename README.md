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

有两种一键安装，Docker、RAGFlow、模型、平台和客户导入一次装好：

- 阿里云 ECS（中国内地）：见 [deploy/aliyun/README.md](deploy/aliyun/README.md)；
- Mac（比如拿 Mac mini 当服务器）：见 [deploy/mac/README.md](deploy/mac/README.md)。

其他服务器按下面三步手动装。

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

### 2. 安装客服平台

把安装包传到服务器（或者直接 `git clone` 本仓库），解压后运行安装脚本：

```bash
scp kefu-platform-*.tar.gz root@<服务器>:/root/
ssh root@<服务器>
tar xzf kefu-platform-*.tar.gz && cd kefu-platform
sudo bash deploy/install.sh
```

脚本会提示输入两个密钥：RAGFlow 的 API Key，以及评分和 AI 起草用的模型 Key。它们只写进 `/etc/kefu/`（权限 600），不进 `.env` 也不进仓库。脚本做的事：

- 把代码装到 `/opt/kefu-platform`，建 venv 装依赖；
- 生成 `.env`，数据放 `/var/lib/muxu`，模型渠道默认 OpenRouter，可以用环境变量 `LLM_BASE_URL`、`JUDGE_MODEL` 改，或者装好后改 `.env`（字段说明见 `.env.example`）；
- 装 systemd 服务 `muxu`（开机自启、挂了自动重启）和 nginx 站点 `kefu.conf`（80 端口）。

更新代码时重新解压新包再跑一次脚本即可，已有的 `.env`、密钥和数据不会被覆盖。

国内服务器装依赖慢的话，用镜像源：`sudo PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple bash deploy/install.sh`。国内服务器一般连不上 OpenRouter，模型渠道换成 DeepSeek、百炼等国内渠道（RAGFlow 里的模型也一样）。

注意 RAGFlow 的 Docker 默认把 9380 端口开在所有网卡上，安全组或防火墙里只放行 80/443，不要对外开 9380。

### 3. 首次登录

第一次启动会自动建平台管理员 `admin@muxu.local`，密码在 `$MUXU_DATA_DIR/.admin_password`，首次登录要求改密码。登录 `/muxu/console/` 后在平台后台开客户，系统会在 RAGFlow 里自动建好这个客户的知识库、问答库和助手。

## 迁移现有客户

平台数据库（`platform.db`）里记着每个客户在 RAGFlow 里的知识库和助手 ID，所以**平台数据和 RAGFlow 数据要一起搬**，只搬一边会对不上。`migrate.py` 按客户整体搬：

```bash
# 旧服务器：导出一个客户（文件、切好的知识段、问答库、助手设置、测试题和评分记录、对话、主动跟进、成员账号）
python3 migrate.py export hafyoung hafyoung-export.tar.gz

# 新服务器：先装好平台、RAGFlow 里配好对话和向量模型，再导入
cd /opt/kefu-platform && sudo .venv/bin/python migrate.py import /root/hafyoung-export.tar.gz
```

- 资料库按原样写回已经切好的知识段，新服务器不用重新 OCR，回答依据和旧服务器完全一样；问答库表格会重新解析。每段要重新算向量，几百段大约十几分钟，`MIGRATE_CONCURRENCY` 控制并发（默认 8）。
- 成员账号连同密码一起搬，登录密码和旧服务器相同。同一邮箱在新服务器已存在时只加成员身份。
- 导入失败会自动删掉建了一半的知识库；也可以 `migrate.py remove <客户代号> --yes` 删掉后重来。
- 导出文件里有客户资料、对话和密码哈希，权限是 600。不要进 git，传完、导入成功后删掉。

## 备份

要备份的有两部分：`$MUXU_DATA_DIR`（平台数据库和密码文件），以及 RAGFlow 的 Docker 数据卷（MySQL、MinIO、Elasticsearch）。建议每天定时备份到另一台机器或对象存储。

## deploy/ 里的文件

- `install.sh`、`muxu.service`、`nginx/kefu.conf`：新服务器用。
- `ragflow/`：两种一键安装共用。`docker/` 是 RAGFlow v0.27.3 的 Docker 编排文件，其中 `.env` 存为 `env.template`；`bootstrap.py` 在 RAGFlow 容器里建管理员、接模型（百炼或 OpenRouter）、生成 API Key。
- `aliyun/install_all.sh`：阿里云一键安装。
- `mac/install.sh`、`mac/docker-compose.mac.yml`：Mac 一键安装。平台也跑在容器里，镜像由仓库根目录的 `Dockerfile` 构建。
- `start_ragflow.sh`、`keepalive.sh`、`nginx/nginx.conf` 等：开发机上不用 Docker 跑整套服务的脚本，路径写死为 `/home/hubin/ragflow-local`，仅供参考。`ragflow_service_conf.patch` 是那套环境对 RAGFlow 配置的改动（只监听本机、去掉默认向量模型）。
