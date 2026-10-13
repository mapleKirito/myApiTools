#!/usr/bin/env bash
# =====================================================================
# MyApiTools 同步服务 —— 构建镜像并推送到 Docker Hub
#
#   ./build-push-dockerhub.sh               构建（若本地还没有）并推送 :<版本号>
#   ./build-push-dockerhub.sh --dry-run     只做检查与提示，不 build 不 push
#   ./build-push-dockerhub.sh --yes, -y     不提问；正式版冲突直接判失败（CI 用）
#   ./build-push-dockerhub.sh --force, -f   跳过版本存在性检查，直接覆盖
#   ./build-push-dockerhub.sh --no-latest   只推 :<版本号>，不动 latest
#   ./build-push-dockerhub.sh --latest      快照版也更新 latest（默认只有正式版才动）
#   ./build-push-dockerhub.sh --help, -h
#
# 关键优化：先检查本地是否已经有构建好的镜像
#   （docker image 里有 myzhouye/myapitools-server:<版本号>）。
#     · 有  → 直接推送，不再重复 docker build
#     · 没有 → 构建（打 :<版本号> 和 :latest 两个 tag）后再推送
#   这样「构建一次、Docker Hub / ACR 各推一次」不会重复构建。
#   想单独把已构建的镜像推到 ACR，用同目录的 build-push-acr.sh。
#
# 版本号唯一来源：本目录的 package.json
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_FILE="$SCRIPT_DIR/package.json"
IMAGE_REPO="${IMAGE_REPO:-myzhouye/myapitools-server}"

DRY_RUN=0
ASSUME_YES=0
FORCE=0
NO_LATEST=0     # --no-latest：任何情况都不动 latest
FORCE_LATEST=0  # --latest：快照版也更新 latest
PUSH_LATEST=1   # 实际决定（版本号读出来之后才算得出来）

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
MyApiTools 同步服务 —— 构建镜像并推送到 Docker Hub

  ./build-push-dockerhub.sh                 构建（若本地还没有）并推送 :<版本号>
  ./build-push-dockerhub.sh --dry-run       只做检查与提示，不 build 不 push
  ./build-push-dockerhub.sh --yes, -y       不提问；正式版冲突直接判失败（CI 用）
  ./build-push-dockerhub.sh --force, -f     跳过版本存在性检查，直接覆盖
  ./build-push-dockerhub.sh --no-latest     只推 :<版本号>，不动 latest
  ./build-push-dockerhub.sh --latest        快照版也更新 latest（默认只有正式版才动）
  ./build-push-dockerhub.sh --help, -h

环境变量：
  IMAGE_REPO   镜像仓库名，默认 myzhouye/myapitools-server
               （Docker 要求仓库名全小写，带大写会在 build 阶段直接报错）

版本号规则（唯一来源：本目录的 package.json）：

  x.y.z        正式版 —— 发布后内容不再变化。同一 tag 已存在时会停下来问你，
               默认不替你覆盖；--yes 下直接判失败。
  x.y.z-dev    开发快照版（x.y.z-dev.N 同理）—— 内容随时可能被覆盖重推：
                  · 同一 tag 已存在时直接覆盖，不再询问，--yes 也能跑通
                  · 默认不动 :latest（想强行更新用 --latest）

服务端的 /api/health、管理页版本 chip、启动横幅都读这个字段，改一处就够了。

提示：镜像推到 Docker Hub 后，再用 build-push-acr.sh 推一份到阿里云 ACR，
      供境内服务器（Docker Hub 拉取常超时）部署用。两个脚本都复用本地已构建的镜像，
      不会重复 docker build。
EOF
  exit 0
}

# ------------------------------------------------------------ 参数解析
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)   DRY_RUN=1 ;;
    --yes|-y)    ASSUME_YES=1 ;;
    --force|-f)  FORCE=1 ;;
    --no-latest) NO_LATEST=1 ;;
    --latest)    FORCE_LATEST=1 ;;
    --help|-h)   usage ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
  shift
done

# ------------------------------------------------------------ 版本号读写
first_version_in() {
  awk '
    !found && match($0, /"version"[[:space:]]*:[[:space:]]*"[^"]+"/) {
      s = substr($0, RSTART, RLENGTH)
      sub(/^"version"[[:space:]]*:[[:space:]]*"/, "", s)
      sub(/"$/, "", s)
      print s
      found = 1
      exit
    }
  ' "$1"
}

read_version() {
  local v=''
  if command -v node >/dev/null 2>&1; then
    v="$(cd "$SCRIPT_DIR" && node -p "require('./package.json').version" 2>/dev/null || true)"
    case "$v" in undefined|null) v='' ;; esac
  fi
  [ -n "$v" ] || v="$(first_version_in "$PKG_FILE")"
  printf '%s' "$v"
}

set_version() {
  local new="$1" tmp="$PKG_FILE.tmp"
  if ! awk -v nv="$new" '
        !done && match($0, /"version"[[:space:]]*:[[:space:]]*"[^"]*"/) {
          head = substr($0, 1, RSTART - 1)
          tail = substr($0, RSTART + RLENGTH)
          printf "%s\"version\": \"%s\"%s\n", head, nv, tail
          done = 1
          next
        }
        { print }
        END { if (!done) exit 3 }
      ' "$PKG_FILE" > "$tmp"; then
    rm -f "$tmp"
    die "在 $PKG_FILE 里找不到 version 字段"
  fi
  cat "$tmp" > "$PKG_FILE"
  rm -f "$tmp"
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

bump_version() {
  local major minor patch
  IFS=. read -r major minor patch <<<"$1"
  patch="${patch%%-*}"
  case "$2" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) die "内部错误：未知的抬升类型 $2" ;;
  esac
  printf '%s.%s.%s' "$major" "$minor" "$patch"
}

# --------------------------------------------------- Docker Hub 存在性检查
tag_exists() {
  local tag="$1" repo_lc code
  repo_lc="$(printf '%s' "$IMAGE_REPO" | tr '[:upper:]' '[:lower:]')"
  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
      "https://registry.hub.docker.com/v2/repositories/${repo_lc}/tags/${tag}/" 2>/dev/null || true)"
    case "$code" in
      200) printf 'yes'; return ;;
      404) printf 'no';  return ;;
      *)   : ;;
    esac
  fi
  if DOCKER_CLI_EXPERIMENTAL=enabled docker manifest inspect "${IMAGE_REPO}:${tag}" >/dev/null 2>&1; then
    printf 'yes'
  else
    printf 'unknown'
  fi
}

# 本地是否已经有构建好的镜像（不依赖 dry-run，永远查真实的 docker daemon）
local_image_exists() {
  docker image inspect "$1" >/dev/null 2>&1
}

# --------------------------------------------------------------- 交互
need_tty() {
  if [ "$ASSUME_YES" -eq 0 ] && [ ! -t 0 ]; then
    die "当前不是交互式终端，无法询问。请改用 --yes（有冲突则失败）或 --force（直接覆盖）"
  fi
}

ask() {
  local reply=''
  printf '%s ' "$*" >&2
  read -r reply || reply=''
  printf '%s' "$reply"
}

CONFLICT_ACTION=''
resolve_conflict() {
  local short patch_next minor_next major_next choice manual
  need_tty
  short="$1"
  patch_next="$(bump_version "$short" patch)"
  minor_next="$(bump_version "$short" minor)"
  major_next="$(bump_version "$short" major)"

  if [ "$ASSUME_YES" -eq 1 ]; then
    err "${IMAGE_REPO}:${short} 已存在于 Docker Hub"
    dim "  --yes 不会替你决定覆盖。要重新发布请显式加 --force，或先升版本号。" >&2
    CONFLICT_ACTION='abort'
    return 1
  fi

  printf '\n' >&2
  warn "${IMAGE_REPO}:${short} 在 Docker Hub 上已经存在了"
  dim  '  正式版发布出去内容就不再变化，所以同一个 tag 带着新内容再推一次会直接覆盖它，' >&2
  dim  '  正在用这个版本的人下次 pull 就会拿到不一样的镜像。如果这次改动值得单独发一版，' >&2
  dim  '  选升版本号；如果只是日常构建、本来就要反复覆盖，把版本号改成快照版即可：' >&2
  dim  "    ${short}-dev   （-dev 结尾＝开发快照，同 tag 直接覆盖、且不动 latest）" >&2
  printf '\n' >&2
  printf '    [1] 升 patch  → %s\n' "$patch_next" >&2
  printf '    [2] 升 minor  → %s\n' "$minor_next" >&2
  printf '    [3] 升 major  → %s\n' "$major_next" >&2
  printf '    [4] 手动输入版本号\n' >&2
  printf '    [5] 保持 %s，强制覆盖远端\n' "$short" >&2
  printf '    [0] 中止\n' >&2
  printf '\n' >&2

  while true; do
    choice="$(ask '  请选择 [1-5, 0]:')"
    case "$choice" in
      1) set_version "$patch_next"; CONFLICT_ACTION='bumped'; return 0 ;;
      2) set_version "$minor_next"; CONFLICT_ACTION='bumped'; return 0 ;;
      3) set_version "$major_next"; CONFLICT_ACTION='bumped'; return 0 ;;
      5) CONFLICT_ACTION='force';    return 0 ;;
      0|'') CONFLICT_ACTION='abort'; return 1 ;;
      4)
        manual="$(ask '  输入新版本号（形如 1.2.3，可带 -beta.1）:')"
        if ! is_valid_version "$manual"; then
          err "版本号格式不对：$manual"
          continue
        fi
        set_version "$manual"
        CONFLICT_ACTION='bumped'
        return 0
        ;;
      *) err '请输入 1 / 2 / 3 / 4 / 5 / 0' ;;
    esac
  done
}

# ------------------------------------------------------- 构建与推送
run() {
  printf '%s$%s %s\n' "$C_CYAN" "$C_RESET" "$*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

build_image() {
  local version="$1"
  local args=(docker build
    -t "${IMAGE_REPO}:${version}"
    --label "org.opencontainers.image.title=myApiTools-server"
    --label "org.opencontainers.image.version=${version}")

  if [ "$PUSH_LATEST" -eq 1 ]; then
    args+=(-t "${IMAGE_REPO}:latest")
  fi

  args+=("$SCRIPT_DIR")
  run "${args[@]}"
}

# 若需要推 latest 但本地没有 :latest tag（例如之前用 --no-latest 构建过），
# 从已构建的 :<version> 补打一个，避免 docker push 报「找不到 tag」。
ensure_latest_tag() {
  local version="$1"
  if [ "$PUSH_LATEST" -eq 1 ] && [ "$version" != 'latest' ]; then
    if ! local_image_exists "${IMAGE_REPO}:latest"; then
      dim "  本地没有 ${IMAGE_REPO}:latest，从 :${version} 补打该 tag"
      run docker tag "${IMAGE_REPO}:${version}" "${IMAGE_REPO}:latest"
    fi
  fi
}

push_failed_report() {
  local ref="$1" role="$2" reason="$3" hint="$4"
  printf '\n' >&2
  err "本地最新镜像没有推送到远端：${ref}"
  info ''
  warn "本地镜像已经构建出来了，远端拿不到它"
  if [ "$role" = 'version' ]; then
    dim  "  远端 ${ref} 仍是上一次推送的内容（这个 tag 从没推过时则根本不存在）。" >&2
    dim  '  部署端执行 docker compose pull 会报 not found 或拉到旧内容 —— 原因就是这次没推上去。' >&2
  else
    dim  "  版本 tag 已经推成功了，只有 ${ref} 没更新；" >&2
    dim  '  固定用 latest 的人下次 pull 拿到的还是上一版。' >&2
  fi
  info ''
  dim  "  失败原因：${reason}" >&2
  dim  "  怎么办：${hint}" >&2
  dim  '  只想本机先用：docker compose up -d（本地已有该镜像，不会去远端拉）' >&2
  info ''
}

# 根据 ref 推断 docker login 提示语：带点的第一段是 registry 域名，否则是 Docker Hub 命名空间
login_hint_for() {
  local registry="${1%%/*}"
  if printf '%s' "$registry" | grep -q '\.'; then
    printf 'docker login %s' "$registry"
  else
    printf 'docker login -u %s' "$registry"
  fi
}

push_image() {
  local ref="$1" role="${2:-version}" out
  if [ "$DRY_RUN" -eq 1 ]; then
    run docker push "$ref"
    return 0
  fi
  if ! out="$(docker push "$ref" 2>&1)"; then
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -qiE 'denied|unauthorized|authentication required|access token'; then
      push_failed_report "$ref" "$role" \
        '推送被拒绝（没登录，或当前账号对该仓库没有写权限）' \
        "先登录再重跑：$(login_hint_for "$ref")"
    else
      push_failed_report "$ref" "$role" \
        '推送失败（网络中断 / registry 不可达 / Docker 异常）' \
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
    die "镜像仓库名不能含大写字母：${repo_part}
    Docker 只接受全小写仓库名（Docker Hub 上大小写指向同一个仓库，改小写即可）：
      IMAGE_REPO=myzhouye/myapitools-server ./build-push-dockerhub.sh"
  fi

  local version before is_snapshot=0
  before="$(read_version)"
  [ -n "$before" ] || die "读不出 $PKG_FILE 里的 version"
  is_valid_version "$before" || die "package.json 里的版本号不是 x.y.z 形式：$before"

  info ''
  info "  ${C_BOLD}MyApiTools 服务端镜像构建 & 推送（Docker Hub）${C_RESET}"
  dim  '  ---------------------------------------------'
  info "  镜像仓库  : ${IMAGE_REPO}"
  info "  版本来源  : server/package.json"
  info "  构建上下文: ${SCRIPT_DIR}"
  [ "$DRY_RUN" -eq 1 ] && dim '  模式      : --dry-run（不会真的构建/推送）'
  dim  '  ---------------------------------------------'

  while true; do
    version="$(read_version)"
    if [ "$version" != "$before" ]; then
      ok "版本号已更新：$before → $version"
      before="$version"
    fi

    if is_snapshot_version "$version"; then is_snapshot=1; else is_snapshot=0; fi

    info ''
    info "  待发布版本: ${C_BOLD}${version}${C_RESET}"
    if [ "$is_snapshot" -eq 1 ]; then
      dim  '  版本性质  : 开发快照版（-dev）· 同一 tag 可随时覆盖重推'
    else
      dim  '  版本性质  : 正式版 · 发布后内容不再变化'
    fi

    if [ "$FORCE" -eq 1 ]; then
      warn '已指定 --force，跳过版本存在性检查'
      break
    fi

    local exists
    exists="$(tag_exists "$version")"
    case "$exists" in
      no)
        ok "Docker Hub 上还没有 ${version}，可以发布"
        break
        ;;
      yes)
        if [ "$is_snapshot" -eq 1 ]; then
          warn "${IMAGE_REPO}:${version} 已存在，快照版按规则直接覆盖"
          dim  '  -dev 快照本来就会被反复重推，这是预期行为。' >&2
          break
        fi
        if ! resolve_conflict "$version"; then
          if [ "$CONFLICT_ACTION" = 'abort' ]; then
            info ''
            info '  已中止，什么都没改。'
            exit 1
          fi
        fi
        if [ "$CONFLICT_ACTION" = 'force' ]; then
          warn "将强制覆盖 ${IMAGE_REPO}:${version}"
          break
        fi
        continue
        ;;
      *)
        warn '无法确认该版本是否已存在（网络不通 / 仓库私有 / API 不可达）'
        need_tty
        if [ "$ASSUME_YES" -eq 0 ]; then
          local reply
          reply="$(ask '  仍要继续构建并推送吗? [y/N]')"
          case "$reply" in
            y|Y|yes|YES) ;;
            *) info ''; info '  已中止。'; exit 1 ;;
          esac
        fi
        break
        ;;
    esac
  done

  if [ "$NO_LATEST" -eq 1 ]; then
    PUSH_LATEST=0
  elif [ "$FORCE_LATEST" -eq 1 ]; then
    PUSH_LATEST=1
  elif [ "$is_snapshot" -eq 1 ]; then
    PUSH_LATEST=0
  else
    PUSH_LATEST=1
  fi

  info ''
  dim '  ---------------------------------------------'
  if local_image_exists "${IMAGE_REPO}:${version}"; then
    ok "本地已有构建好的镜像 ${IMAGE_REPO}:${version}，跳过 docker build"
  else
    warn "本地没有 ${IMAGE_REPO}:${version}，开始构建"
    build_image "$version"
  fi
  ensure_latest_tag "$version"

  info ''
  local dh_ok=1
  push_image "${IMAGE_REPO}:${version}" version || dh_ok=0
  if [ "$PUSH_LATEST" -eq 1 ] && [ "$version" != 'latest' ]; then
    push_image "${IMAGE_REPO}:latest" latest || dh_ok=0
  fi

  info ''
  dim '  ---------------------------------------------'
  if [ "$DRY_RUN" -eq 1 ]; then
    ok "预演结束（--dry-run：没构建、没推送，本地与远端都没变化）"
    dim '  去掉 --dry-run 再跑一次才会真正构建并推送。'
    info ''
    return 0
  fi
  if [ "$dh_ok" -eq 0 ]; then
    err "Docker Hub 推送失败，本地镜像没推上去"
    exit 1
  fi
  ok "发布完成：${IMAGE_REPO}:${version}"
  if [ "$PUSH_LATEST" -eq 1 ]; then
    dim "  同时更新了 ${IMAGE_REPO}:latest"
  elif [ "$NO_LATEST" -eq 0 ] && [ "$is_snapshot" -eq 1 ]; then
    dim "  快照版未更新 latest（latest 只指向正式版；确实需要就加 --latest）"
  fi
  dim "  要再推一份到阿里云 ACR（境内服务器拉取用）：同目录 build-push-acr.sh"
  dim "  部署目录示例见 server/deploy/（只 pull 不 build）"
  info ''
}

main "$@"
