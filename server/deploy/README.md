# MyApiTools 配置同步服务 —— 部署说明

这个目录是**给运维用**的：只需要 Docker，不需要 Node、不需要源码、不需要 npm。
镜像是别人（或你自己）在开发机上构建好推上去的，这里只负责拉下来跑起来。

```
deploy/
├── docker-compose.yml   启动示例（只有 image:，没有 build:）
└── README.md            你正在看的这份
```

---

## 一、30 秒跑起来

```bash
# 1. 建一个干净的目录放数据（建议独立，别放在代码仓库里）
mkdir -p myapitools && cd myapitools

# 2. 把本目录的 docker-compose.yml 拷过来
cp /path/to/server/deploy/docker-compose.yml .

# 3. 起服务
docker compose up -d

# 4. 看日志，把管理端令牌记下来
docker compose logs
```

日志长这样：

```
  MyApiTools 配置同步服务已启动
  ---------------------------------------------
  版本        : 1.2.0
  监听地址      : http://0.0.0.0（本机可用 127.0.0.1）:8787
  数据文件      : /app/data/sync.db
  客户端发布     : 0 个安装包 · 默认渠道 stable · 单包上限 500MB
  ---------------------------------------------
  管理端       : http://127.0.0.1:8787/admin
  管理令牌      : 见文件 /app/data/admin-token.txt（权限 0600，请勿提交到版本库）
```

管理端令牌也可以在宿主上直接读：

```bash
cat ./data/admin-token.txt
```

验证服务活着：

```bash
curl -s http://127.0.0.1:8787/api/health
# {"ok":true,"name":"MyApiTools 配置同步服务","version":"1.2.0",...}
```

然后在客户端「设置 → 同步」里填服务地址 `http://<这台机器的地址>:8787`，注册账号即可。

---

## 二、重要的默认行为

| 项 | 默认 | 说明 |
| --- | --- | --- |
| 端口 | `127.0.0.1:8787` | **只绑回环**，只有本机能访问。要别的机器连，见下一节 |
| 数据目录 | 同目录下 `./data` | 数据库、管理令牌、已发布的客户端安装包都在这。备份它就够了 |
| 管理端 | 开启 | `/admin`，令牌保护 + 每分钟 120 次限流 |
| 升级镜像 | 不动数据卷 | `docker compose pull && docker compose up -d` 即可，数据在 `./data` |

---

## 三、让别的机器连上来

默认只绑回环是**故意的**。这个服务存的是你的请求配置（可能含密钥、Cookie），
又带一个「拿到令牌就管所有账号」的管理端，暴露到公网风险很高。

### 场景 1：只在局域网内用（最常见）

改 compose 里的端口绑定：

```yaml
ports:
  - "0.0.0.0:8787:8787"   # 原来是 127.0.0.1:8787:8787
```

然后 `docker compose up -d`。客户端填 `http://192.168.x.x:8787`。

前提是这台机器在可信内网。同时建议把管理端关掉（用不到就别留着）：

```yaml
environment:
  ADMIN_DISABLED: "1"
```

### 场景 2：需要从公网访问

**不要**直接把 8787 开到公网。正确做法是在前面加一层提供 HTTPS 的网关
（nginx / Caddy / Traefik / 云负载均衡），并且：

1. 8787 保持只绑 `127.0.0.1`，网关反代到它；
2. 网关必须有有效证书 —— 客户端会校验 TLS；
3. 把 `ADMIN_DISABLED` 设为 `1`（管理端不对外）；
4. 考虑在网关层加 IP 白名单或基础认证。

nginx 片段参考：

```nginx
server {
    listen 443 ssl;
    server_name api-sync.example.com;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    client_max_body_size 600m;      # 要发安装包的话得放开，默认 1m 会挡下来

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;     # 大安装包上传/下载慢，别被 60s 掐断
    }
}
```

客户端里服务地址填 `https://api-sync.example.com`（不要带端口）。

### 场景 3：只是想在本机临时用管理端

`ADMIN_LOCAL_ONLY=1` 的默认值对**裸机运行**（`node server.js`）是够的。
但容器里来源 IP 永远是 docker 网桥地址，不是回环，所以容器部署必须放开：

```yaml
ADMIN_LOCAL_ONLY: "0"
ADMIN_ALLOW: "*"
```

这两行**必须成对出现**。只写 `ADMIN_LOCAL_ONLY: "0"` 而没写 `ADMIN_ALLOW`，
白名单就是空集，除回环外一律 404 —— 从浏览器看就是「打不开」，和没启用一模一样。
服务端启动时如果检测到这个组合会主动打印一行告警，看到它按提示补上即可。

---

## 四、容器里怎么用管理端

管理端**故意**只绑在宿主的 127.0.0.1 上，容器内部地址不对外。两种打开方式：

```bash
# 方式一：在宿主机上开一个 SSH 隧道，然后把浏览器指到本机
ssh -L 8787:127.0.0.1:8787 user@your-server
# 然后本地浏览器访问 http://127.0.0.1:8787/admin

# 方式二：直接在宿主机上用文本浏览器/curl
docker exec myapitools-sync cat /app/data/admin-token.txt
```

打开 `/admin` 后把令牌粘进去，就能看到服务概览、同步账号管理、**客户端发布**、审计日志。

> 容器里 `/admin` 打不开（404）时，九成是 `ADMIN_ALLOW` 没配，见上一节。

---

## 五、客户端发布（在管理端里发新版本）

管理端的「客户端发布」区块可以直接上传安装包，客户端连上来后会自动检查更新。

1. **先构建安装包**（在开发机上，源码仓库里执行）：

   ```bash
   npm run dist          # 产物在 dist/
   ```

   文件名里带版本号和架构，例如 `MyApiTools-Setup-1.2.0-x64.exe`。

2. 打开管理端 → 「客户端发布」→ 选文件。版本号 / 平台 / 架构会自动从**文件名**
   推断出来，检查一遍再发。推断不准就手改。

3. 客户端下次检查更新时（启动后约 4 秒、以及每次登录后）就会看到提示。

限制与注意：

- **单包上限**默认 500MB（`RELEASE_MAX_MB`），Electron 安装包一般 70~120MB。
- 同一个「渠道 + 版本 + 平台 + 架构」重复发布是**覆盖**，不生成两份。
- 安装包存在 `./data/releases/` 下，跟着数据卷走；删容器不丢，但如果只是
  `docker compose down -v` 或者手工 rm 掉 `./data`，已发布的包就没了。
- 前端反代要放开 `client_max_body_size`（nginx 默认 1MB，100MB 的包直接被挡）。

---

## 六、升级与回滚

### 升级到最新

```bash
docker compose pull
docker compose up -d
```

数据在 `./data`，不受影响。

### 固定版本（推荐生产用）

不要用 `latest`，容易在你没注意的时候被换掉。在同级目录建 `.env`：

```
MYAPITOOLS_TAG=1.2.0
```

然后 `docker compose up -d`。想升级就改这个数字。

> 版本号带 `-dev` 的是**开发快照版**（例如 `1.2.0-dev`）：发布方可能随时把同一个
> tag 覆盖重推，内容会变。**正式环境一律用不带后缀的版本号。** 发布脚本也不会把
> 快照版推到 `latest` 上，所以按 `MYAPITOOLS_TAG` 固定版本、或干脆用 `latest`，
> 都不会意外拿到快照版。

### 回滚

把 `MYAPITOOLS_TAG` 改回旧版本号，`docker compose up -d` 即可。

> 数据库结构升级由服务端自己在启动时完成，**没有降级脚本**。
> 如果新版建表/加列过，回退到旧镜像可能起不来。生产环境升级前先备份 `./data`。

---

## 七、备份

要备份的只有 `./data` 这一个目录：

```bash
# 冷备份（最稳，会短暂停服）
docker compose stop
tar czf myapitools-$(date +%F).tar.gz data/
docker compose start
```

`data/` 里有三样东西：

| 文件 / 目录 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| `sync.db` | 全部账号与请求配置 | 数据全没了 |
| `admin-token.txt` | 管理端令牌 | 重启会自动生成一个新的，旧令牌失效 |
| `releases/` | 已发布的客户端安装包 | 客户端检查更新会返回「无新版本」 |

> 备份里含 **admin-token.txt 和所有人的配置**，等同于全部凭证，别往网盘/群聊里丢。

---

## 八、常见问题

**Q：容器起来了，但 `docker compose logs` 里没有令牌那一行？**
A：看 `ADMIN_DISABLED` 是不是被设成了 `1`，或者令牌初始化失败（日志里会有
`[admin] 管理令牌初始化失败`）。数据目录不可写也会导致这个结果。

**Q：`/admin` 返回 404，但服务明明活着？**
A：三种可能，按顺序排查：
1. `ADMIN_DISABLED=1` → 管理端是关的（这是设计，不是故障）；
2. `ADMIN_ALLOW` 没配 → 补上 `"*"`，见第三节场景 3；
3. 你连的不是这台机器 —— 端口只绑了 `127.0.0.1`，别的机器连不上。

**Q：客户端提示「无法连接服务端」？**
A：先在能出问题的那台机器上 `curl http://<地址>:8787/api/health`。
curl 通而客户端不通，通常是地址带了路径（应填 `http://host:8787`，不要带 `/api`）
或用了自签证书（客户端会拒绝）。

**Q：客户端检查更新说是「已是最新」，但管理端明明发了新版本？**
A：版本号比较是**逐段数字比**的，`1.10.0` 确实大于 `1.9.0`，这块不会错。
常见原因是平台/架构不匹配 —— 客户端只认自己这一格
（Windows x64 的客户端看不到 macOS 的包）。核对管理端列表里的「平台/架构」列。

**Q：上传安装包报 413 / 连接被重置？**
A：两种情况：超过了 `RELEASE_MAX_MB`；或者前面挂了 nginx 而没放开
`client_max_body_size`。

**Q：数据卷权限报错？**
A：容器里以 root 跑，宿主上 `./data` 会变成 root 属主。想改属主：
`sudo chown -R 1000:1000 data`（把 1000 换成你的 uid）。

**Q：端口 8787 被占用了？**
A：改 compose 左边那个数字，例如 `"127.0.0.1:18787:8787"`，客户端跟着改端口。

---

## 九、环境变量速查

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 容器内监听端口，一般不用改 |
| `HOST` | `0.0.0.0` | 容器内必须 `0.0.0.0`，否则端口映射进不来 |
| `DB_FILE` | `/app/data/sync.db` | SQLite 文件位置 |
| `TOKEN_TTL_DAYS` | `30` | 登录令牌有效期（天） |
| `ADMIN_DISABLED` | `0` | 设 `1` 彻底关闭管理端（路由 404） |
| `ADMIN_LOCAL_ONLY` | `0`(容器) | 设 `1` 时仅回环可访问管理端 |
| `ADMIN_ALLOW` | `*`(容器) | 管理端来源白名单，逗号分隔；`*` 表示不限 |
| `ADMIN_TOKEN` | 空 | 直接指定管理令牌，优先级高于令牌文件 |
| `ADMIN_TOKEN_FILE` | `/app/data/admin-token.txt` | 令牌落盘位置 |
| `RELEASES_DIR` | `/app/data/releases` | 客户端安装包目录 |
| `RELEASE_MAX_MB` | `500` | 单包上限 |
| `RELEASE_CHANNEL` | `stable` | 默认发布渠道 |
| `TZ` | `Asia/Shanghai` | 时区，影响日志时间 |

> 注意 `ADMIN_TOKEN_FILE` 和 `RELEASES_DIR` 都是**跟随**数据目录的。
> 只改 `DB_FILE` 而不改这两个，它们仍指向 `/app/data/` 下的老位置。
> 正常情况下三个都不用动。

---

## 十、镜像从哪来

镜像名 `myzhouye/myapitools-server`，tag 与服务端版本号一致（另有一个 `latest`）。
仓库名全小写是 Docker 的硬性要求，Docker Hub 上大小写指向同一个仓库。

```bash
docker pull myzhouye/myapitools-server:1.2.0
```

发布流程（在源码仓库的 `server/` 目录下执行，需要 Docker Hub 写权限）：

```bash
# Linux / macOS
./build-push.sh

# Windows PowerShell
.\build-push.ps1
```

脚本读 `server/package.json` 的版本号作为 tag，行为取决于版本号形态：

- **正式版**（`1.2.0`）：tag 已存在时会提示你升版本号或强制覆盖，并同时更新 `latest`；
- **开发快照版**（`1.2.0-dev`）：tag 已存在时直接覆盖、不再询问，且不动 `latest`。

脚本会读 `server/package.json` 的版本号作为 tag；如果这个 tag 在 Docker Hub 上
已经存在，会提示你升版本号或强制覆盖。
