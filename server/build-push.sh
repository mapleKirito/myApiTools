#!/usr/bin/env bash
# =====================================================================
# MyApiTools 同步服务 —— 构建镜像并推送到 Docker Hub
#
#   ./build-push.sh                 构建并推送 :<版本号>（正式版同时更新 :latest）
#   ./build-push.sh --dry-run       只做检查与提示，不 build 不 push
#   ./build-push.sh --yes           不提问；正式版遇到版本冲突直接判失败退出（CI 用）
#   ./build-push.sh --force         不检查版本是否已存在，直接覆盖
#   ./build-push.sh --no-latest     只推 :<版本号>，不动 latest
#   ./build-push.sh --latest        快照版也更新 latest（默认只有正式版才动 latest）
#   ./build-push.sh --help
#
# 环境变量：
#   IMAGE_REPO   镜像仓库名，默认 myzhouye/myapitools-server
#                （Docker 要求仓库名全小写，带大写会在 build 阶段直接报错）
#
# ------------------------------------------------------------ 版本号规则
# 版本号唯一来源是本目录的 package.json，只有两种形态：
#
#   x.y.z        正式版。发布出去内容就不再变化 —— 同一 tag 已存在时会停下来问你，
#                默认不会替你覆盖（--yes 下直接判失败）。
#   x.y.z-dev    开发快照版（带序号写作 x.y.z-dev.N，规则相同）。内容随时可能被
#                覆盖重推，所以：同一 tag 已存在时直接覆盖、不再询问；并且默认
#                不动 :latest，好让 latest 始终指向一个正式版。
#
# 服务端的 /api/health、管理页版本 chip、启动横幅都读这个字段，所以改一处就够了，
# 不需要再去同步别的地方。
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

  ./build-push.sh                 构建并推送 :<版本号>（正式版同时更新 :latest）
  ./build-push.sh --dry-run       只做检查与提示，不 build 不 push
  ./build-push.sh --yes, -y       不提问；正式版遇到版本冲突直接判失败退出（CI 用）
  ./build-push.sh --force, -f     不检查版本是否已存在，直接覆盖
  ./build-push.sh --no-latest     只推 :<版本号>，不动 latest
  ./build-push.sh --latest        快照版也更新 latest（默认只有正式版才动 latest）
  ./build-push.sh --help, -h

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
# 只认第一处 "version" —— package.json 的顶层字段出现在最前面。
#
# 这里刻意不用 sed 的 0,/re/ 地址（「只替换第一处」的常用写法）：那是 GNU 扩展，
# BSD sed（macOS 自带）会直接报 "invalid usage of line address 0"。awk 是 POSIX 的，
# 到处都一样，也不受 JSON 排版影响（单行 / 缩进都能处理）。

# 打印第一处 "version" 的值，没有则输出空
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

# 优先交给 JSON 解析器（node 必然存在，服务端自己就要用它）；
# 没有 node 时退化成上面的 awk。
read_version() {
  local v=''
  if command -v node >/dev/null 2>&1; then
    v="$(cd "$SCRIPT_DIR" && node -p "require('./package.json').version" 2>/dev/null || true)"
    # 字段不存在时 node -p 会打印字面量 undefined（值为 null 时打印 null），
    # 别把它们当成版本号往下传，否则错误信息会变成「不是 x.y.z 形式：undefined」，
    # 指错方向 —— 真正的问题是「读不出来」
    case "$v" in undefined|null) v='' ;; esac
  fi
  [ -n "$v" ] || v="$(first_version_in "$PKG_FILE")"
  printf '%s' "$v"
}

# 把新版本号写回 package.json。
# 用「定点替换」而不是重新序列化整个 JSON —— 后者会把文件里所有格式（键序、空行、
# 缩进细节）一起重排，一次改版本号产生一大片无关 diff。
# 只替换第一处，避免 dependencies 里恰好也有叫 "version" 的键时被连带改掉。
set_version() {
  local new="$1" tmp="$PKG_FILE.tmp"
  if ! awk -v nv="$new" '
        !done && match($0, /"version"[[:space:]]*:[[:space:]]*"[^"]*"/) {
          # 只换匹配到的那一段，前后的缩进、逗号、其余字段一律原样保留
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
  # 用 cat 回写而不是 mv：保住原文件的属主与权限
  cat "$tmp" > "$PKG_FILE"
  rm -f "$tmp"
}

is_valid_version() {
  printf '%s' "$1" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

# 是否「开发快照版」—— 判定就看有没有 -dev 后缀（x.y.z-dev / x.y.z-dev.3）。
#
# 这条规则决定了后面两件事：
#   1) 同一个 tag 已存在时是「直接覆盖」还是「停下来问」；
#   2) 要不要更新 :latest。
# 快照版对应「内容随时会被覆盖」，正式版对应「发布后不再变化」。
#
# 只认 -dev：规则里没定义别的后缀，所以 -beta.1 这类仍然按正式版对待 ——
# 宁可多问一次，也不擅自放行覆盖。
is_snapshot_version() {
  case "$1" in
    *-dev|*-dev.*) return 0 ;;
    *)             return 1 ;;
  esac
}

# 抬升版本号：bump <version> major|minor|patch
bump_version() {
  local major minor patch
  IFS=. read -r major minor patch <<<"$1"
  patch="${patch%%-*}"          # 去掉 -beta.1 之类的预发布后缀
  case "$2" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) die "内部错误：未知的抬升类型 $2" ;;
  esac
  printf '%s.%s.%s' "$major" "$minor" "$patch"
}

# --------------------------------------------------- Docker Hub 存在性检查
# 回显 yes / no / unknown，不用返回码是为了避免和 set -e 纠缠
#   yes     → 该 tag 已存在
#   no      → 确认不存在（可以安心发布）
#   unknown → 查不出来（网络、权限、私有仓库等），交给用户决定
tag_exists() {
  local tag="$1" repo_lc code

  # Docker Hub 的仓库名大小写不敏感，API 路径要全小写
  repo_lc="$(printf '%s' "$IMAGE_REPO" | tr '[:upper:]' '[:lower:]')"

  if command -v curl >/dev/null 2>&1; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
      "https://registry.hub.docker.com/v2/repositories/${repo_lc}/tags/${tag}/" 2>/dev/null || true)"
    case "$code" in
      200) printf 'yes'; return ;;
      404) printf 'no';  return ;;
      *)   : ;;   # 401 / 403 / 5xx / 000：说不准，往下走兜底
    esac
  fi

  # 兜底：直接问 registry。公开仓库不需要登录。
  # DOCKER_CLI_EXPERIMENTAL 是为了兼容还在把 manifest 当实验特性的老版本 CLI。
  if DOCKER_CLI_EXPERIMENTAL=enabled docker manifest inspect "${IMAGE_REPO}:${tag}" >/dev/null 2>&1; then
    printf 'yes'
  else
    printf 'unknown'
  fi
}

# --------------------------------------------------------------- 交互
# 非交互环境（CI、重定向）下没有任何人可以回答问题，硬读 stdin 会挂死
need_tty() {
  if [ "$ASSUME_YES" -eq 0 ] && [ ! -t 0 ]; then
    die "当前不是交互式终端，无法询问。请改用 --yes（有冲突则失败）或 --force（直接覆盖）"
  fi
}

ask() {   # ask <提示语> → 回显用户输入
  local reply=''
  printf '%s ' "$*" >&2
  read -r reply || reply=''
  printf '%s' "$reply"
}

# 版本已存在时让用户选怎么办。
# 成功处理时退出码 0，用户选择中止时退出码 1。
# 通过全局 CONFLICT_ACTION 回传决定：force | bumped | abort
CONFLICT_ACTION=''
resolve_conflict() {
  local short patch_next minor_next major_next choice manual

  # 非交互环境（CI、重定向）下没人能回答这个选择题，先给出可执行的指引，
  # 而不是打印一个读不到答案的 [1-5, 0] 提示、再把空输入当成「中止」。
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
run() {   # 打印命令；--dry-run 时只打印不执行
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

  # 构建上下文就是 server/ 目录；.dockerignore 会把 data/ 和文档挡在外面
  args+=("$SCRIPT_DIR")
  run "${args[@]}"
}

# 推送失败时，只打一行红字是不够的：上面紧跟着的就是 docker 自己那一大段输出，
# 关键信息很容易被淹掉。而带 tag 的镜像「本地有、远端没有」这个状态特别隐蔽 ——
# 部署端 docker compose pull 要么报 not found，要么拉到上一次的旧内容却照样能起能跑，
# 看起来就像"发布成功了"。所以这里单独把后果说清楚。
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

push_image() {
  local ref="$1" role="${2:-version}" out
  if [ "$DRY_RUN" -eq 1 ]; then
    run docker push "$ref"
    return 0
  fi
  # 自己判断错误类型，好给出「先 docker login」这种可执行的提示
  if ! out="$(docker push "$ref" 2>&1)"; then
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -qiE 'denied|unauthorized|authentication required|access token'; then
      push_failed_report "$ref" "$role" \
        '推送被拒绝（没登录，或当前账号对该仓库没有写权限）' \
        "先登录再重跑：docker login -u ${IMAGE_REPO%%/*}"
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

  # Docker 只接受全小写的仓库名（tag 不受限）。不提前拦的话，报出来的是
  # "invalid reference format: repository name must be lowercase" —— 出现在
  # docker build 的输出里，很难联想到是镜像名大小写的问题，所以这里先说清楚。
  local repo_part="${IMAGE_REPO%%:*}"
  if printf '%s' "$repo_part" | grep -q '[A-Z]'; then
    die "镜像仓库名不能含大写字母：${repo_part}
    Docker 只接受全小写仓库名（Docker Hub 上大小写指向同一个仓库，改小写即可）：
      IMAGE_REPO=myzhouye/myapitools-server ./build-push.sh"
  fi

  local version before is_snapshot=0
  before="$(read_version)"
  [ -n "$before" ] || die "读不出 $PKG_FILE 里的 version"
  is_valid_version "$before" || die "package.json 里的版本号不是 x.y.z 形式：$before"

  info ''
  info "  ${C_BOLD}MyApiTools 服务端镜像构建 & 推送${C_RESET}"
  dim  '  ---------------------------------------------'
  info "  镜像仓库  : ${IMAGE_REPO}"
  info "  版本来源  : server/package.json"
  info "  构建上下文: ${SCRIPT_DIR}"
  [ "$DRY_RUN" -eq 1 ] && dim '  模式      : --dry-run（不会真的构建/推送）'
  dim  '  ---------------------------------------------'

  # 版本冲突检查。改完版本号要回到循环开头重新查一次 ——
  # 新版本号同样可能已经存在于 Docker Hub（比如从别人那接手的分支）
  while true; do
    version="$(read_version)"
    if [ "$version" != "$before" ]; then
      ok "版本号已更新：$before → $version"
      before="$version"
    fi

    # 每轮都重算：升完版本号之后，性质可能整个变了（快照 → 正式）
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
        # 快照版不做冲突询问：-dev 的定义就是「内容随时可能被覆盖」，
        # 每次构建推同一个 tag 是它的正常用法。CI 里 --yes 也能直接跑通，
        # 否则想反复推快照就得给流水线塞 --force（那个开关太宽，会连正式版一起放行）。
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
        # CONFLICT_ACTION=bumped → 回去重新检查新版本号
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

  # latest 只在正式版时更新。latest 是给「docker pull 一把梭」的人用的，
  # 让它指向一个随时会被覆盖的开发快照，等于把不稳定版本悄悄推给所有人。
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
  build_image "$version"

  info ''
  push_image "${IMAGE_REPO}:${version}" version || exit 1
  if [ "$PUSH_LATEST" -eq 1 ] && [ "$version" != 'latest' ]; then
    push_image "${IMAGE_REPO}:latest" latest || exit 1
  fi

  info ''
  dim '  ---------------------------------------------'
  if [ "$DRY_RUN" -eq 1 ]; then
    # 预演模式下 push_image 只是打印命令，什么都不会发生。这里若照旧打「发布完成」，
    # 用户很容易以为远端已经有了 —— 和「推送失败」一样属于"看着成功其实没有"。
    ok "预演结束（--dry-run：没构建、没推送，本地与远端都没变化）"
    dim '  去掉 --dry-run 再跑一次才会真正构建并推送。'
    info ''
    return 0
  fi
  ok "发布完成：${IMAGE_REPO}:${version}"
  if [ "$PUSH_LATEST" -eq 1 ]; then
    dim "  同时更新了 ${IMAGE_REPO}:latest"
  elif [ "$NO_LATEST" -eq 0 ] && [ "$is_snapshot" -eq 1 ]; then
    dim "  快照版未更新 latest（latest 只指向正式版；确实需要就加 --latest）"
  fi
  dim "  部署目录示例见 server/deploy/（只 pull 不 build）"
  info ''
}

main "$@"
