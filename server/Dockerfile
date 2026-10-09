# MyApiTools 同步服务镜像
# 只依赖 Node 内置模块（http + node:sqlite），无需 npm install
FROM node:22-alpine

WORKDIR /app

# 保持与本地一致的时区，日志里好对时间
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

# package.json 必须有：server.js 用 require('./package.json').version 取服务端版本号，
# 少这个文件容器会在启动时直接崩。它同时承担 engines 声明的职责。
COPY package.json server.js admin.html ./

# 数据落盘目录，由 volume 挂载出来
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8787

ENV PORT=8787 \
    HOST=0.0.0.0 \
    DB_FILE=/app/data/sync.db \
    NODE_ENV=production
# 管理端来源限制：容器内看到的来源 IP 永远是 docker 网桥地址（默认 172.17.0.1），
# 不可能是回环，所以必须同时做两件事，少一件管理端就恒返回 404：
#   1. ADMIN_LOCAL_ONLY=0  解除「仅回环」限制；
#   2. ADMIN_ALLOW=*       把来源放行 —— 只关 LOCAL_ONLY 是不够的，白名单为空
#                          时它是空集，除回环外一律拒绝（表现和"没启用"一样）。
# 真正的访问边界是「宿主端口只绑 127.0.0.1」（见 docker-compose.yml）+ 令牌。
# 若想收窄来源，把 * 换成具体网段，例如 ADMIN_ALLOW=172.17.0.1。
# 如果连本机管理端都不需要，把 ADMIN_DISABLED 设为 1，接口会直接 404。
ENV ADMIN_TOKEN_FILE=/app/data/admin-token.txt \
    ADMIN_LOCAL_ONLY=0 \
    ADMIN_ALLOW=* \
    ADMIN_DISABLED=0

# 客户端安装包仓库：跟着数据卷一起持久化，升级镜像不丢已发布的版本
ENV RELEASES_DIR=/app/data/releases \
    RELEASE_MAX_MB=500 \
    RELEASE_CHANNEL=stable

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
