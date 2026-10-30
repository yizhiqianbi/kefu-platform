# 部署到 Mac（Mac mini 当服务器）

整套都跑在 Docker 里，Mac 本身除了 Docker 什么都不用装。RAGFlow 的依赖服务（Elasticsearch、MySQL、MinIO、Redis）和客服平台用 ARM 原生镜像，RAGFlow 本体官方只有 x86 镜像，靠 Rosetta 运行。模型默认走阿里百炼，国内直连；能访问境外的话也可以用 OpenRouter，那样模型和开发机完全一样。

## 1. 要求

| 项目 | 要求 |
|---|---|
| 机器 | Apple 芯片（M1 到 M4）或 Intel 的 Mac mini 都行 |
| 系统 | macOS 15 以上。Apple 芯片必须满足这一条：RAGFlow 用到 AVX 指令，旧版 Rosetta 不支持 |
| 内存 | 16G 能跑，但要给 Docker 分 10 到 12G，平时别再开大软件；24G 以上更从容 |
| 磁盘 | 剩余 40G 以上 |

## 2. 安装 Docker

二选一：

- **Docker Desktop**：员工少于 250 人且年收入低于 1000 万美元的公司免费。装好后打开设置：
  - Resources → Memory 调到 10G 以上；
  - General → 勾选「Use Rosetta for x86_64/amd64 emulation on Apple Silicon」；
  - General → 勾选「Start Docker Desktop when you sign in」。
- **OrbStack**：更省内存，Rosetta 默认开启，内存按需分配；商业使用要买授权。

## 3. 准备模型 Key

- 百炼（默认）：打开[百炼控制台](https://bailian.console.aliyun.com/)开通服务，在「API-KEY」页面创建一个 Key，账户里要有余额。
- OpenRouter：在 [openrouter.ai](https://openrouter.ai/keys) 创建 Key。前提是 Mac 能访问境外。

## 4. 运行

把开发机上 `dist/` 里的两个文件下载到 Mac 的「下载」文件夹：安装包 `kefu-platform-*.tar.gz`，以及客户导出包 `hafyoung-export-*.tar.gz`。在 Cursor 左侧文件树里右键点文件，选 Download 就行。导出包里有客户资料，别经过网盘或聊天软件转发。

打开「终端」：

```bash
cd ~/Downloads
tar xzf kefu-platform-*.tar.gz && cd kefu-platform
bash deploy/mac/install.sh ~/Downloads/hafyoung-export-*.tar.gz
```

要用 OpenRouter 的话，在命令前面加 `MODEL_PROVIDER=openrouter`。不带导出包运行就是装一个空平台。

脚本会提示输入模型 Key，然后自动完成下面这些事。第一次运行大约 30 到 90 分钟，主要花在下载约 10G 镜像和重新计算向量上：

1. 检查系统版本、Docker 是否在运行、Docker 分到的内存和磁盘空间；
2. 用一次很短的请求试一下 Key，不对就立刻停下；
3. 把程序放到 `~/kefu`：`platform/` 是平台代码，`ragflow/` 是编排文件和 `.env`，`secrets/` 是各种 Key；
4. 拉镜像，默认经过 DaoCloud 镜像站，失败了再直连；
5. 先单独试跑一次 x86 环境。Rosetta 没开的话会在这里提示；
6. 构建平台镜像，启动全部服务。数据库等密码随机生成，RAGFlow 这一套只绑本机，只有平台对局域网开放（80 端口）；
7. 在 RAGFlow 里建管理员，接入模型并设为默认，再生成 API Key；
8. 导入客户，把它设成默认咨询页；
9. 打印访问地址和管理命令。

中途失败的话，按提示修好后再运行一次即可。已经生成的密码、Key 和数据都会保留。

## 5. 装好以后

- 运营台：`http://localhost/muxu/console/`。平台管理员是 `admin@muxu.local`，初始密码用 `cd ~/kefu/ragflow && docker compose exec kefu cat /data/.admin_password` 查看。导入的客户账号和旧服务器上的密码相同。
- 同一局域网里的手机或电脑访问 `http://<Mac 的局域网 IP>/muxu/`，脚本最后会打印这个地址。建议在路由器里给 Mac 绑定一个固定 IP。
- RAGFlow 后台：`http://localhost:8080`。只能在这台 Mac 上打开，账号密码在 `~/kefu/secrets/ragflow_admin`。
- **把测试题重跑一遍**再交给客户。用百炼时问答和向量模型都换了，答案可能有小变化。
- 导入成功后，删掉「下载」里的导出包，并清空废纸篓。

## 6. 把 Mac mini 当服务器用

- 不睡眠，断电后来电自动开机：`sudo pmset -a sleep 0 disksleep 0 autorestart 1`。
- 系统设置 → 用户与群组 → 开启自动登录，这样重启后 Docker 会自己起来，容器也会跟着启动。如果开了 FileVault，断电重启后需要有人输一次密码。
- 关掉自动更新后的自动重启，或者把更新安排在晚上。

## 7. 让外网访问

Mac 在内网里，默认只有局域网能访问。要让外面的客户也能访问，有几种办法：

- **Cloudflare Tunnel**：免费，不需要公网 IP，也不需要备案（域名托管在 Cloudflare），但国内访问速度不太稳定；
- **内网穿透**（花生壳，或者 frp 加一台云服务器）：国内访问速度好，但用国内服务器加域名就要备案；
- 正式对外用阿里云版（`deploy/aliyun/`），Mac 只用来演示和内部测试。

## 日常管理

所有命令都在 `~/kefu/ragflow` 目录里执行：

| 要做的事 | 命令 |
|---|---|
| 查看状态 | `docker compose ps` |
| 看平台日志 | `docker compose logs -f kefu` |
| 看 RAGFlow 日志 | `docker compose logs --tail 100 ragflow-cpu` |
| 重启 / 停止 / 启动 | `docker compose restart`，`docker compose stop`，`docker compose start` |
| 升级平台 | 解压新的安装包，再运行一次 `bash deploy/mac/install.sh`，数据和配置都保留 |
| 备份一个客户 | `docker compose exec kefu python migrate.py export hafyoung /data/backup.tar.gz && docker compose cp kefu:/data/backup.tar.gz ~/kefu-backup.tar.gz` |

数据都在 Docker 数据卷里（`kefu_kefu_data`、`kefu_mysql_data`、`kefu_minio_data`、`kefu_esdata01`）。Time Machine 备份不到这些数据卷，所以要定期用上面的命令把每个客户导出来，存到别的地方。

## 常见问题

| 现象 | 处理 |
|---|---|
| 提示「x86 镜像跑不起来」 | 按第 2 步打开 Rosetta，确认 macOS 是 15 以上，重启 Docker 后再运行 |
| 镜像拉不下来 | 在 Docker 设置 → Docker Engine 里加 `"registry-mirrors"`，或者给 Docker 配代理，再运行一次脚本 |
| 80 端口被占用 | `KEFU_PORT=8000 bash deploy/mac/install.sh`，之后访问地址都带 `:8000` |
| RAGFlow 起不来或者很慢 | 多半是 Docker 内存不够，调大后执行 `docker compose restart` |
| Key 填错了 | 删掉 `~/kefu/secrets/llm_api_key`，再运行一次脚本 |
