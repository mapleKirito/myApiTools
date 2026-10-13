#!/usr/bin/env bash
# =====================================================================
# MyApiTools 同步服务 —— 把本地的镜像打 tag 后推送到阿里云 ACR
#
#   ./build-push-acr.sh               给本地镜像打 ACR tag 并推送 :<版本号>
#   ./build-push-acr.sh --dry-run     只做检查与提示，不打 tag 不 push
#   ./build-push-acr.sh --no-latest   只推 :<版本号>，不动 latest
#   ./build-push-acr.sh --latest      快照版也更新 latest
#   ./build-push-acr.sh --help, -h
#
# 关键约定：本脚本【不构建镜像】。
#   它复用 build-push-dockerhub.sh 已在本地构建好的 Docker Hub 镜像
#   （myzhouye/myapitools-server:<版本号>），直接 docker tag 成 ACR 地址后推送。
#   若本地该镜像不存在，脚本会报错并提示你先跑 build-push-dockerhub.sh。
#   这样 Docker Hub 与 ACR 各推一次，docker build 只跑一次。
#
# 版本号唯一来源：本目录的 package.json
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_FILE="$SCRIPT_DIR/package.json"
IMAGE_REPO="${IMAGE_REPO:-myzhouye/myapitools-server}"
# 阿里云 ACR 仓库：ECS 默认拉不到 Docker Hub，把镜像同步推一份到 ACR。
ACR_REPO="${ACR_REPO:-registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server}"

DRY_RUN=0
NO_LATEST=0
FORCE_LATEST=0
PUSH_LATEST=1

# ---------------------------------------------------------------- 输出
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

info() { printf '%s\n' "$*"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
MyApiTools 同步服务 —— 把本地镜像推送到阿里云 ACR（不构建）

  ./build-push-acr.sh               给本地镜像打 ACR tag 并推送 :<版本号>
  ./build-push-acr.sh --dry-run     只做检查与提示，不打 tag 不 push
  ./build-push-acr.sh --no-latest   只推 :<版本号>，不动 latest
  ./build-push-acr.sh --latest      快照版也更新 latest（默认只有正式版才动）
  ./build-push-acr.sh --help, -h

环境变量：
  IMAGE_REPO   Docker Hub 仓库名（本地构建镜像的来源），默认 myzhouye/myapitools-server
  ACR_REPO     阿里云 ACR 仓库，默认 registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server
               （ECS 默认拉不到 Docker Hub，推一份到 ACR，部署端改从 ACR 拉；
                公开仓库匿名即可 pull，私有仓库需先 docker login 对应 ACR 域名）

版本号规则（唯一来源：本目录的 package.json）：

  x.y.z        正式版。发布后内容不再变化；latest 指向正式版。
  x.y.z-dev    开发快照版（x.y.z-dev.N 同理）。同一 tag 可随时覆盖重推，默认不动 latest。

注意：本脚本不执行 docker build，必须先在本地构建好 Docker Hub 镜像
      （用 build-push-dockerhub.sh，本地没有时它会自动构建）。
EOF
  exit 0
}

# ------------------------------------------------------------ 参数解析
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --no-latest) NO_LATEST=1 ;;
    --latest)    FORCE_LATEST=1 ;;
    --force|-f)  : ;;   # ACR 是镜像仓库，覆盖推送无需确认，接受但忽略
    --yes|-y)    : ;;   # 同上，接受但忽略
    --help|-h)   usage ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
  shift
done

# ------------------------------------------------------------ 版本号读写
read_version() {
  local v=''
  if command -v node >/dev/null 2>&1; then
    v="$(cd "$SCRIPT_DIR" && node -p "require('./package.json').version" 2>/dev/null || true)"
    case "$v" in undefined|null) v='' ;; esac
  fi
  [ -n "$v" ] || v="$(awk '!f&&match($0,/"version"[[:space:]]*:[[:space:]]*"[^"]+"/){s=substr($0,RSTART,RLENGTH);sub(/^"version"[[:space:]]*:[[:space:]]*"/,"",s);sub(/"$/,"",s);print s;f=1;exit}' "$PKG_FILE")"
  printf '%s' "$v"
}

is_valid_version() {
  printf '%s' "$1" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

is_snapshot_version() {
  case "$1" in
    *-dev|*-dev.*) return 0 ;;
    *)             return 1 ;;
  esac
}

local_image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

# ------------------------------------------------------- 构建与推送
run() {
  printf '%s$%s %s\n' "$C_CYAN" "$C_RESET" "$*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

push_failed_report() {
  local ref="$1" reason="$2" hint="$3"
  printf '\n' >&2
  err "本地镜像没有推送到 ACR：${ref}"
  info ''
  warn "本地镜像已经打好了 ACR tag，远端拿不到它"
  dim  '  部署端（ECS）执行 docker compose pull 会报 not found 或拉到旧内容 —— 原因就是这次没推上去。' >&2
  info ''
  dim  "  失败原因：${reason}" >&2
  dim  "  怎么办：${hint}" >&2
  info ''
}

# 根据 ref 推断 docker login 提示语
login_hint_for() {
  local registry="${1%%/*}"
  if printf '%s' "$registry" | grep -q '\.'; then
    printf 'docker login %s' "$registry"
  else
    printf 'docker login -u %s' "$registry"
  fi
}

push_image() {
  local ref="$1" out
  if [ "$DRY_RUN" -eq 1 ]; then
    run docker push "$ref"
    return 0
  fi
  if ! out="$(docker push "$ref" 2>&1)"; then
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -qiE 'denied|unauthorized|authentication required|access token'; then
      push_failed_report "$ref" \
        '推送被拒绝（没登录 ACR，或当前账号对该仓库没有写权限）' \
        "先登录再重跑：$(login_hint_for "$ref")"
    else
      push_failed_report "$ref" \
        '推送失败（网络中断 / ACR 不可达 / Docker 异常）' \
        '确认网络与 Docker 状态后重跑本脚本'
    fi
    return 1
  fi
  printf '%s\n' "$out" | tail -n 2
  ok "已推送 $ref"
}

# ------------------------------------------------------------- 主流程
main() {
  command -v docker >/dev/null 2>&1 || die '找不到 docker 命令，请先安装 Docker'
  docker info >/dev/null 2>&1 || die 'Docker 没在运行（docker info 失败）'

  local repo_part="${IMAGE_REPO%%:*}"
  if printf '%s' "$repo_part" | grep -q '[A-Z]'; then
    die "Docker Hub 镜像仓库名不能含大写字母：${repo_part}
    Docker 只接受全小写仓库名：
      IMAGE_REPO=myzhouye/myapitools-server ./build-push-acr.sh"
  fi
  local acr_part="${ACR_REPO%%:*}"
  if printf '%s' "$acr_part" | grep -q '[A-Z]'; then
    die "ACR 镜像仓库名不能含大写字母：${acr_part}
    Docker 只接受全小写仓库名：
      ACR_REPO=registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server ./build-push-acr.sh"
  fi

  local version before is_snapshot=0
  before="$(read_version)"
  [ -n "$before" ] || die "读不出 $PKG_FILE 里的 version"
  is_valid_version "$before" || die "package.json 里的版本号不是 x.y.z 形式：$before"

  info ''
  info "  ${C_BOLD}MyApiTools 服务端镜像 → 阿里云 ACR（只打 tag / 推送，不构建）${C_RESET}"
  dim  '  ---------------------------------------------'
  info "  本地来源  : ${IMAGE_REPO}:<版本号>（由 build-push-dockerhub.sh 构建）"
  info "  ACR 目标  : ${ACR_REPO}"
  info "  版本来源  : server/package.json"
  [ "$DRY_RUN" -eq 1 ] && dim '  模式      : --dry-run（不会打 tag / 推送）'
  dim  '  ---------------------------------------------'

  # ACR 脚本不接受版本冲突询问：它只是把本地已构建镜像同步到 ACR，
  # 覆盖推送是预期行为，不需要升版本号。
  version="$(read_version)"
  if is_snapshot_version "$version"; then is_snapshot=1; else is_snapshot=0; fi

  info ''
  info "  待发布版本: ${C_BOLD}${version}${C_RESET}"
  if [ "$is_snapshot" -eq 1 ]; then
    dim  '  版本性质  : 开发快照版（-dev）· ACR 同 tag 直接覆盖'
  else
    dim  '  版本性质  : 正式版 · 发布后内容不再变化'
  fi

  if [ "$NO_LATEST" -eq 1 ]; then
    PUSH_LATEST=0
  elif [ "$FORCE_LATEST" -eq 1 ]; then
    PUSH_LATEST=1
  elif [ "$is_snapshot" -eq 1 ]; then
    PUSH_LATEST=0
  else
    PUSH_LATEST=1
  fi

  # ── 核心：复用本地已构建的 Docker Hub 镜像，不重复 build ──
  info ''
  dim '  ---------------------------------------------'
  if ! local_image_exists "${IMAGE_REPO}:${version}"; then
    err "本地找不到 Docker Hub 构建镜像 ${IMAGE_REPO}:${version}"
    dim "  ACR 脚本不重复构建镜像。请先运行 build-push-dockerhub.sh（本地没有时它会自动构建），"
    dim "  再来推 ACR；或者手动 docker build -t ${IMAGE_REPO}:${version} . 后再跑本脚本。"
    exit 1
  fi
  ok "本地已有构建镜像 ${IMAGE_REPO}:${version}，直接打 ACR tag 并推送（不构建）"

  run docker tag "${IMAGE_REPO}:${version}" "${ACR_REPO}:${version}"
  if [ "$PUSH_LATEST" -eq 1 ] && [ "$version" != 'latest' ]; then
    run docker tag "${IMAGE_REPO}:${version}" "${ACR_REPO}:latest"
  fi

  info ''
  local acr_ok=1
  push_image "${ACR_REPO}:${version}" || acr_ok=0
  if [ "$PUSH_LATEST" -eq 1 ] && [ "$version" != 'latest' ]; then
    push_image "${ACR_REPO}:latest" || acr_ok=0
  fi

  info ''
  dim '  ---------------------------------------------'
  if [ "$DRY_RUN" -eq 1 ]; then
    ok "预演结束（--dry-run：没打 tag、没推送）"
    dim '  去掉 --dry-run 再跑一次才会真正打 tag 并推送。'
    info ''
    return 0
  fi
  if [ "$acr_ok" -eq 0 ]; then
    err "ACR 推送失败，部署端（ECS）拉不到镜像"
    exit 1
  fi
  ok "发布完成（ACR）：${ACR_REPO}:${version}"
  if [ "$PUSH_LATEST" -eq 1 ]; then
    dim "  同时更新了 ${ACR_REPO}:latest"
  elif [ "$NO_LATEST" -eq 0 ] && [ "$is_snapshot" -eq 1 ]; then
    dim "  快照版未更新 latest（latest 只指向正式版；确实需要就加 --latest）"
  fi
  dim "  部署端（ECS）把 compose 的 image 改成 ACR 地址后即可 docker compose pull 拉取。"
  info ''
}

main "$@"
