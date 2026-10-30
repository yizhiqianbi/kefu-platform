# 部署到阿里云（中国内地）

一台 ECS 上用一个脚本装好全部：Docker、RAGFlow、客服平台，模型全走阿里百炼（问答 `deepseek-v4-flash`、向量 `text-embedding-v4`、识图 `qwen3-vl-flash`、评分和起草 `deepseek-v4-pro`）。

## 1. 买服务器

| 项目 | 选什么 |
|---|---|
| 产品 | 云服务器 ECS，**包年包月，至少 3 个月**（ICP 备案要求） |
| 地域 | 离客户近的内地地域，比如华南 1（深圳）、华东 1（杭州）、华东 2（上海） |
| 规格 | 4 vCPU 16 GiB，比如经济型 e 或通用型 g8i。客户多了、同时解析大量文件再升 8 核 32G |
| 镜像 | Ubuntu 22.04 64 位（24.04 也行） |
| 系统盘 | ESSD 100G |
| 公网 | 分配公网 IP，固定带宽 5M 起 |
| 安全组 | 入方向只放 22（最好只对自己的 IP）、80、443。**不要放行 8080、9380 等端口** |
| 登录 | 设 root 密码或绑定密钥对 |

4 核 16G 经济型的活动价大约每月 70 到 90 元，正价会贵不少，下单前对比一下页面上的价格。

## 2. 准备两样东西

**阿里百炼 API Key**（必须）：打开[百炼控制台](https://bailian.console.aliyun.com/)，开通服务，然后在「API-KEY」页面创建一个 Key（`sk-` 开头）。按量付费，账户里要有余额；新开通的模型一般有免费额度。

**镜像加速器地址**（强烈建议）：内地拉 Docker Hub 的镜像经常失败。打开容器镜像服务 ACR 控制台，在「镜像工具 → 镜像加速器」里复制你的专属地址（`https://xxxx.mirror.aliyuncs.com`）。免费，不用开实例。

## 3. 上传并运行

在自己电脑上（安装包和导出包都在 `dist/` 里）：

```bash
scp kefu-platform-*.tar.gz root@<公网IP>:/root/
scp hafyoung-export-*.tar.gz root@<公网IP>:/root/   # 有客户资料，只用 scp 传，别放网盘或 git
ssh root@<公网IP>
```

在服务器上：

```bash
tar xzf kefu-platform-*.tar.gz && cd kefu-platform
bash deploy/aliyun/install_all.sh /root/hafyoung-export-*.tar.gz
```

不带参数运行就是装一个空平台。脚本会问百炼 Key 和加速器地址，然后自动完成下面这些事，全程大约 20 到 60 分钟，大部分时间在下载镜像和重新算向量：

1. 检查内存和磁盘，调好 Elasticsearch 需要的 `vm.max_map_count`；
2. 先用一次很短的请求试一下百炼 Key，不对就立刻停下；
3. 从阿里云镜像源装 Docker，配好加速器；
4. 用 `deploy/ragflow/docker/` 里的编排文件启动 RAGFlow v0.27.3（镜像来自阿里云杭州仓库）。数据库、MinIO、Redis、ES 的密码全部随机生成，所有端口只绑本机；
5. 在 RAGFlow 里建管理员，接入百炼的模型并设为默认，再生成 API Key 交给平台；
6. 安装客服平台：systemd 服务 `muxu`，以及 nginx 的 80 端口站点；
7. 导入客户：知识段原样写回，向量在百炼上重新计算；
8. 打印访问地址和各个密码文件的位置。

中途失败的话，按提示修好后再运行一次即可。已经生成的密码、Key 和数据都会保留。

## 4. 装好以后

- 打开 `http://<公网IP>/muxu/console/`，用 `admin@muxu.local` 登录。初始密码用 `cat /var/lib/muxu/.admin_password` 查看，首次登录会要求修改。导入的客户账号和旧服务器上的密码相同。
- **把测试题重跑一遍。**问答和向量模型都换成了百炼上的版本（原来走 OpenRouter），答案可能有小变化，先看评分再交给客户。
- 导入成功后删掉服务器上的导出包：`shred -u /root/hafyoung-export-*.tar.gz`。
- RAGFlow 后台不对外开放。要查看的话，在自己电脑上运行 `ssh -L 8080:127.0.0.1:8080 root@<公网IP>`，然后打开 `http://localhost:8080`。账号密码在 `/etc/kefu/ragflow_admin`。
- 在 ECS 控制台给系统盘设一个**自动快照策略**（比如每天一次、保留 7 天），这样平台数据和 RAGFlow 数据会一起备份。

## 5. 域名和备案

内地服务器用**域名**对外服务必须先做 ICP 备案。没备案的域名解析过来会被拦截，但**直接用 IP 访问不受影响**，备案期间可以先用 IP 测试和演示。

1. 买域名，完成实名认证；
2. 在阿里云「ICP 备案」里提交，用这台 ECS 当备案服务器。初审加管局审核通常 1 到 3 周；
3. 备案通过后，加一条 A 记录指向公网 IP。把 `/etc/nginx/conf.d/kefu.conf` 里的 `server_name _;` 改成你的域名，然后申请 HTTPS 证书：

   ```bash
   apt install -y certbot python3-certbot-nginx
   certbot --nginx -d kf.你的域名.com
   ```

4. 网站上线后 30 天内，在全国互联网安全管理服务平台做公安备案。

## 常见问题

| 现象 | 处理 |
|---|---|
| 镜像拉取失败 | 检查 `/etc/docker/daemon.json` 里的加速器地址，改完后 `systemctl restart docker`，再运行一次脚本 |
| 百炼报 401 / InvalidApiKey | Key 填错了：`rm /etc/kefu/llm_api_key`，再运行一次脚本 |
| 百炼报模型未开通或欠费 | 去百炼控制台开通对应模型，或者充值 |
| RAGFlow 起不来 | `cd /opt/ragflow/docker && docker compose ps`，再看 `docker compose logs --tail 100 ragflow-cpu`。多数是内存不够 |
| 平台报错 | `journalctl -u muxu -n 100` |
| 想换模型 | 改 `/opt/kefu-platform/.env` 里的 `RAGFLOW_CHAT_MODEL`、`JUDGE_MODEL`，然后 `systemctl restart muxu`。新模型要先在 RAGFlow 里加上 |
| 升级平台代码 | 上传新的安装包，解压后运行 `bash deploy/install.sh`，数据和配置不会被覆盖 |
