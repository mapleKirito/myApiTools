<#
.SYNOPSIS
    MyApiTools 同步服务 —— 构建镜像并推送到 Docker Hub（Windows / PowerShell 版）

.DESCRIPTION
    与同目录的 build-push.sh 行为完全等价。版本号唯一来源是 server/package.json。

    .\build-push.ps1                 构建并推送 :<版本号>（正式版同时更新 :latest）
    .\build-push.ps1 -DryRun         只做检查与提示，不 build 不 push
    .\build-push.ps1 -Yes            不提问；正式版遇到版本冲突直接判失败退出（CI 用）
    .\build-push.ps1 -Force          不检查版本是否已存在，直接覆盖
    .\build-push.ps1 -NoLatest       只推 :<版本号>，不动 latest
    .\build-push.ps1 -Latest         快照版也更新 latest（默认只有正式版才动 latest）
    .\build-push.ps1 -Help

    版本号规则：
      x.y.z        正式版。发布出去内容就不再变化 —— 同一 tag 已存在时会停下来问你，
                   默认不会替你覆盖（-Yes 下直接判失败）。
      x.y.z-dev    开发快照版（带序号写作 x.y.z-dev.N，规则相同）。内容随时可能被
                   覆盖重推，所以：同一 tag 已存在时直接覆盖、不再询问；并且默认
                   不动 :latest，好让 latest 始终指向一个正式版。

.PARAMETER ImageRepo
    镜像仓库名，默认 myzhouye/myapitools-server。也可用环境变量 IMAGE_REPO。
    注意 Docker 要求仓库名全小写，带大写会在 build 阶段直接报错。

.EXAMPLE
    .\build-push.ps1 -DryRun
    先看看它会做什么，不真的构建推送。
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Force,
    [switch]$NoLatest,
    [switch]$Latest,
    [switch]$Help,
    [string]$ImageRepo = $(if ($env:IMAGE_REPO) { $env:IMAGE_REPO } else { 'myzhouye/myapitools-server' })
)

# 脚本靠显式检查 $LASTEXITCODE 判断成败，不依赖 PowerShell 的错误流语义。
# 但 docker 会往 stderr 写进度和 WARNING（实测本机每条 docker 命令都带
# "WARNING: DOCKER_INSECURE_NO_IPTABLES_RAW is set"），而调用方的
# $ErrorActionPreference 若是 Stop（有些 profile 会这么设），这些 stderr 会被当成
# 终止性错误 —— 脚本当场死在第一句 `docker info`，看着就像"什么都没发生"。
# 所以在这里固定成 Continue：什么算失败由我们自己的分支决定，不让 PowerShell 掀桌子。
$ErrorActionPreference = 'Continue'

# Invoke-WebRequest 默认会把「正在读取 Web 响应 / 正在读取响应流…」的进度打到宿主上，
# 查询版本号时会刷一屏噪声，这里关掉。
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgFile   = Join-Path $ScriptDir 'package.json'

# ---------------------------------------------------------------- 输出
$script:C_RESET  = "$([char]27)[0m"
$script:C_DIM    = "$([char]27)[2m"
$script:C_BOLD   = "$([char]27)[1m"
$script:C_RED    = "$([char]27)[31m"
$script:C_GREEN  = "$([char]27)[32m"
$script:C_YELLOW = "$([char]27)[33m"
$script:C_CYAN   = "$([char]27)[36m"

function Write-Info { param([string]$Text = '') Write-Host $Text }
function Write-Dim  { param([string]$Text = '') Write-Host "$script:C_DIM$Text$script:C_RESET" }
function Write-Ok   { param([string]$Text)     Write-Host "$script:C_GREEN✓$script:C_RESET $Text" }
function Write-Warn { param([string]$Text)     Write-Host "$script:C_YELLOW!$script:C_RESET $Text" }
function Write-Err  { param([string]$Text)     Write-Host "$script:C_RED✗$script:C_RESET $Text" -ForegroundColor Red }

function Exit-WithError {
    param([string]$Text)
    Write-Err $Text
    exit 1
}

function Show-Usage {
    $text = @'
MyApiTools 同步服务 —— 构建镜像并推送到 Docker Hub（Windows）

  .\build-push.ps1                 构建并推送 :<版本号>（正式版同时更新 :latest）
  .\build-push.ps1 -DryRun         只做检查与提示，不 build 不 push
  .\build-push.ps1 -Yes            不提问；正式版遇到版本冲突直接判失败退出（CI 用）
  .\build-push.ps1 -Force          不检查版本是否已存在，直接覆盖
  .\build-push.ps1 -NoLatest       只推 :<版本号>，不动 latest
  .\build-push.ps1 -Latest         快照版也更新 latest（默认只有正式版才动 latest）
  .\build-push.ps1 -Help

环境变量：
  IMAGE_REPO   镜像仓库名，默认 myzhouye/myapitools-server
               （Docker 要求仓库名全小写，带大写会在 build 阶段直接报错）

版本号规则（唯一来源：本目录的 package.json）：

  x.y.z        正式版 —— 发布后内容不再变化。同一 tag 已存在时会停下来问你，
               默认不替你覆盖；-Yes 下直接判失败。
  x.y.z-dev    开发快照版（x.y.z-dev.N 同理）—— 内容随时可能被覆盖重推：
                  · 同一 tag 已存在时直接覆盖，不再询问，-Yes 也能跑通
                  · 默认不动 :latest（想强行更新用 -Latest）

服务端的 /api/health、管理页版本 chip、启动横幅都读这个字段，改一处就够了。
'@
    # 注意：闭合的 '@ 必须是该行最后一个字符，不能写成 '@ | Write-Host，
    # Windows PowerShell 5.1 会直接报「字符串缺少终止符」。
    Write-Host $text
    exit 0
}

# ------------------------------------------------------------ 版本号读写
function Get-Version {
    # 读的时候用 ConvertFrom-Json，不假设 JSON 是怎么排版的。
    # 早先这里用的是「行首锚定」的正则 '(?m)^[ \t]*"version"'，只对格式化过的
    # package.json 有效 —— 遇到压成一行的 JSON 会静默读成空串，报「读不出 version」，
    # 而文件里明明有。读用 JSON 解析器、写才用正则（为了保住原有排版）。
    $raw = Get-Content -LiteralPath $PkgFile -Raw -Encoding UTF8
    try {
        $obj = $raw | ConvertFrom-Json
        if ($obj.PSObject.Properties.Name -contains 'version' -and $obj.version) {
            return [string]$obj.version
        }
    } catch {
        # JSON 不合法（比如带了注释）时落到下面的正则兜底
    }
    $m = [regex]::Match($raw, '"version"\s*:\s*"([^"]+)"')
    if (-not $m.Success) { return '' }
    return $m.Groups[1].Value
}

function Set-Version {
    param([string]$NewVersion)
    $raw = Get-Content -LiteralPath $PkgFile -Raw -Encoding UTF8

    # 写的时候用「定点替换」而不是 ConvertTo-Json 重新序列化 —— 后者会把整个文件
    # 重排（键序、缩进、空行全变），一次改版本号产生一大片无关 diff。
    # 两种排版都要能处理：格式化过的（version 独占一行）和压成一行的。
    #
    # 注意必须用**实例**重载 $re.Replace(input, evaluator, 1) 来限制只换第一处。
    # 静态的 [regex]::Replace($raw, $pattern, $evaluator, 1) 里没有「次数」参数 ——
    # 那个 1 会被 PowerShell 绑成 RegexOptions.IgnoreCase（枚举值就是 1），
    # 于是照旧全量替换，连 dependencies 里的同名键一起改掉，且不报任何错。
    $new = $null
    if ($raw -match '(?m)^[ \t]*"version"[ \t]*:') {
        $re = [regex]'(?m)^([ \t]*"version"[ \t]*:[ \t]*")[^"]*(")'
        $new = $re.Replace($raw, { param($match) $match.Groups[1].Value + $NewVersion + $match.Groups[2].Value }, 1)
    } elseif ($raw -match '"version"\s*:\s*"[^"]*"') {
        $re = [regex]'("version"\s*:\s*")[^"]*(")'
        $new = $re.Replace($raw, { param($match) $match.Groups[1].Value + $NewVersion + $match.Groups[2].Value }, 1)
    } else {
        Exit-WithError "在 $PkgFile 里找不到 version 字段"
    }

    # 不写 UTF8 BOM：Node 的 require() 能读 BOM，但保持文件原样更安全
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($PkgFile, $new, $utf8NoBom)
}

function Test-VersionFormat {
    param([string]$Version)
    return $Version -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
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
function Test-SnapshotVersion {
    param([string]$Version)
    return $Version -match '-dev(\.|$)'
}

function Get-BumpedVersion {
    param([string]$Version, [ValidateSet('major', 'minor', 'patch')][string]$Part)
    $core = ($Version -split '-')[0]          # 去掉 -beta.1 之类的预发布后缀
    $parts = $core -split '\.'
    $major = [int]$parts[0]; $minor = [int]$parts[1]; $patch = [int]$parts[2]
    switch ($Part) {
        'major' { $major++; $minor = 0; $patch = 0 }
        'minor' { $minor++; $patch = 0 }
        'patch' { $patch++ }
    }
    return "$major.$minor.$patch"
}

# --------------------------------------------------- Docker Hub 存在性检查
# 回显 yes / no / unknown
function Get-TagExists {
    param([string]$Tag)

    $repoLc = $ImageRepo.ToLowerInvariant()   # Docker Hub 仓库名大小写不敏感，API 路径要全小写
    $url = "https://registry.hub.docker.com/v2/repositories/$repoLc/tags/$Tag/"

    # Invoke-WebRequest 遇到 404 会抛异常，所以要先关掉 -ErrorAction 并自己看状态码。
    # PS 5.1 下 -SkipHttpErrorCheck 不存在，只能用 try/catch + .Exception.Response。
    try {
        $resp = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { return 'yes' }
    }
    catch {
        $status = $null
        if ($_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
        }
        if ($status -eq 404) { return 'no' }
        # 401 / 403 / 5xx：说不准，往下走兜底
    }

    # 兜底：直接问 registry。公开仓库不需要登录。
    $env:DOCKER_CLI_EXPERIMENTAL = 'enabled'
    docker manifest inspect "${ImageRepo}:$Tag" *> $null
    if ($LASTEXITCODE -eq 0) { return 'yes' }
    return 'unknown'
}

# --------------------------------------------------------------- 交互
# 非交互环境（CI、管道重定向）下没人能回答问题，硬读会挂死
function Test-InteractiveConsole {
    # [Console]::IsInputRedirected 在没有控制台的宿主里（计划任务、某些 CI 代理）
    # 有可能直接抛 IOException 而不是返回 true。那种环境下本来也没人能答题，
    # 所以把「问不出来」当成非交互处理 —— 好过抛一个看不懂的堆栈。
    try {
        if ([Console]::IsInputRedirected) { return $false }
    } catch {
        return $false
    }
    return [Environment]::UserInteractive
}

function Assert-Interactive {
    if ($Yes) { return }
    if (-not (Test-InteractiveConsole)) {
        Exit-WithError '当前不是交互式终端，无法询问。请改用 -Yes（有冲突则失败）或 -Force（直接覆盖）'
    }
}

function Read-Answer {
    param([string]$Prompt)
    Write-Host $Prompt -NoNewline
    $reply = Read-Host
    if ($null -eq $reply) { return '' }
    return $reply.Trim()
}

# 版本已存在时让用户选怎么办。返回 'force' / 'bumped' / 'abort'
function Resolve-VersionConflict {
    param([string]$Short)

    # 非交互环境（CI、管道重定向）下没人能回答这个选择题，先给出可执行的指引，
    # 而不是打印一个读不到答案的 [1-5, 0] 提示、再把空输入当成「中止」。
    Assert-Interactive

    $patchNext = Get-BumpedVersion -Version $Short -Part patch
    $minorNext = Get-BumpedVersion -Version $Short -Part minor
    $majorNext = Get-BumpedVersion -Version $Short -Part major

    if ($Yes) {
        Write-Err "${ImageRepo}:$Short 已存在于 Docker Hub"
        Write-Dim '  -Yes 不会替你决定覆盖。要重新发布请显式加 -Force，或先升版本号。'
        return 'abort'
    }

    Write-Host ''
    Write-Warn "${ImageRepo}:$Short 在 Docker Hub 上已经存在了"
    Write-Dim '  正式版发布出去内容就不再变化，所以同一个 tag 带着新内容再推一次会直接覆盖它，'
    Write-Dim '  正在用这个版本的人下次 pull 就会拿到不一样的镜像。如果这次改动值得单独发一版，'
    Write-Dim '  选升版本号；如果只是日常构建、本来就要反复覆盖，把版本号改成快照版即可：'
    Write-Dim "    $Short-dev   （-dev 结尾＝开发快照，同 tag 直接覆盖、且不动 latest）"
    Write-Host ''
    Write-Host "    [1] 升 patch  → $patchNext"
    Write-Host "    [2] 升 minor  → $minorNext"
    Write-Host "    [3] 升 major  → $majorNext"
    Write-Host '    [4] 手动输入版本号'
    Write-Host "    [5] 保持 $Short，强制覆盖远端"
    Write-Host '    [0] 中止'
    Write-Host ''

    while ($true) {
        $choice = Read-Answer '  请选择 [1-5, 0]:'
        switch ($choice) {
            '1' { Set-Version $patchNext; return 'bumped' }
            '2' { Set-Version $minorNext; return 'bumped' }
            '3' { Set-Version $majorNext; return 'bumped' }
            '5' { return 'force' }
            { $_ -in '0', '' } { return 'abort' }
            '4' {
                $manual = Read-Answer '  输入新版本号（形如 1.2.3，可带 -beta.1）:'
                if (-not (Test-VersionFormat $manual)) {
                    Write-Err "版本号格式不对：$manual"
                    continue
                }
                Set-Version $manual
                return 'bumped'
            }
            default { Write-Err '请输入 1 / 2 / 3 / 4 / 5 / 0' }
        }
    }
}

# ------------------------------------------------------- 构建与推送
# 执行并回显一条命令，返回它的退出码。
#
# 这里有个必须绕开的陷阱：`& docker ...` 的输出会直接混进**函数的返回值**。
#   · stdout 一旦有内容（例如 DOCKER_BUILDKIT=0 的传统构建器把构建日志写在 stdout），
#     调用方拿到的就不是退出码，而是「日志行… + 退出码」的数组；而 PowerShell 里
#     ($code -ne 0) 对数组是**过滤**语义，结果恒为真 —— 于是哪怕构建完全成功，
#     也会被判成「镜像构建失败」并退出，后面的 push 永远执行不到。
#     （实测：`& cmd /c 'echo a & echo b'` 返回 Object[]，元素 3 个，判定为真）
#   · stderr 还会被包成 NativeCommandError。这个在本机默认设置下只显示不中断，
#     但把 ErrorActionPreference 调成 Stop 的环境里会直接掀掉脚本。
# 所以：两路输出都收下来、用 Write-Host 落到控制台（host 流不进返回值），
# 并且在这段里固定按 Continue 走，函数只吐出一个干净的整数退出码。
function Invoke-Shown {
    param([string[]]$CommandLine)
    Write-Host "$script:C_CYAN`$$script:C_RESET $($CommandLine -join ' ')"
    if ($DryRun) { return 0 }

    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $CommandLine[0] $CommandLine[1..($CommandLine.Count - 1)] 2>&1 |
            ForEach-Object {
                if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() }
                else { Write-Host $_ }
            }
    } finally {
        $ErrorActionPreference = $prevEap
    }
    return $LASTEXITCODE
}

function Build-Image {
    param([string]$Version)

    $args = @('build', '-t', "${ImageRepo}:${Version}",
              '--label', 'org.opencontainers.image.title=myApiTools-server',
              '--label', "org.opencontainers.image.version=$Version")
    if ($PushLatest) {
        $args += @('-t', "${ImageRepo}:latest")
    }
    # 构建上下文就是 server/ 目录；.dockerignore 会把 data/ 和文档挡在外面
    $args += $ScriptDir

    $code = Invoke-Shown (@('docker') + $args)
    if ($code -ne 0) { Exit-WithError "镜像构建失败（docker build 退出码 $code）" }
}

# 推送失败时，只打一行红字是不够的：上面紧跟着的就是 docker 自己那一大段输出，
# 关键信息很容易被淹掉。而带 tag 的镜像「本地有、远端没有」这个状态特别隐蔽 ——
# 部署端 docker compose pull 要么报 not found，要么拉到上一次的旧内容却照样能起能跑，
# 看起来就像"发布成功了"。所以这里单独把后果说清楚，然后以非零码退出。
function Write-PushFailedReport {
    param([string]$Ref, [string]$Role, [string]$Reason, [string]$Hint)

    Write-Host ''
    Write-Err "本地最新镜像没有推送到远端：$Ref"
    Write-Info ''
    Write-Warn '本地镜像已经构建出来了，远端拿不到它'
    if ($Role -eq 'version') {
        Write-Dim "  远端 $Ref 仍是上一次推送的内容（这个 tag 从没推过时则根本不存在）。"
        Write-Dim '  部署端执行 docker compose pull 会报 not found 或拉到旧内容 —— 原因就是这次没推上去。'
    } else {
        Write-Dim "  版本 tag 已经推成功了，只有 $Ref 没更新；"
        Write-Dim '  固定用 latest 的人下次 pull 拿到的还是上一版。'
    }
    Write-Info ''
    Write-Dim "  失败原因：$Reason"
    Write-Dim "  怎么办：$Hint"
    Write-Dim '  只想本机先用：docker compose up -d（本地已有该镜像，不会去远端拉）'
    Write-Info ''
    exit 1
}

function Push-Image {
    param([string]$Ref, [string]$Role = 'version')

    if ($DryRun) {
        Invoke-Shown @('docker', 'push', $Ref) | Out-Null
        return
    }
    # 自己判断错误类型，好给出「先 docker login」这种可执行的提示
    $out = & docker push $Ref 2>&1
    if ($LASTEXITCODE -ne 0) {
        $out | ForEach-Object { Write-Host $_ }
        $joined = ($out | Out-String)
        if ($joined -match '(?i)denied|unauthorized|authentication required|access token') {
            $reason = '推送被拒绝（没登录，或当前账号对该仓库没有写权限）'
            $hint = "先登录再重跑：docker login -u $(($ImageRepo -split '/')[0])"
        } else {
            $reason = '推送失败（网络中断 / registry 不可达 / Docker 异常）'
            $hint = '确认网络与 Docker 状态后重跑本脚本'
        }
        Write-PushFailedReport -Ref $Ref -Role $Role -Reason $reason -Hint $hint
    }
    $out | Select-Object -Last 2 | ForEach-Object { Write-Host $_ }
    Write-Ok "已推送 $Ref"
}

# ------------------------------------------------------------- 主流程
if ($Help) { Show-Usage }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Exit-WithError '找不到 docker 命令，请先安装 Docker Desktop'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Exit-WithError 'Docker 没在运行（docker info 失败）' }

# Docker 只接受全小写的仓库名（tag 不受限）。不提前拦的话，报出来的是
# "invalid reference format: repository name must be lowercase" —— 出现在
# docker build 的输出里，很难联想到是镜像名大小写的问题，所以这里先说清楚。
$repoPart = ($ImageRepo -split ':')[0]
if ($repoPart -cmatch '[A-Z]') {
    Exit-WithError @"
镜像仓库名不能含大写字母：$repoPart
    Docker 只接受全小写仓库名（Docker Hub 上大小写指向同一个仓库，改小写即可）：
      .\build-push.ps1 -ImageRepo myzhouye/myapitools-server
"@
}

$before = Get-Version
if ([string]::IsNullOrWhiteSpace($before)) { Exit-WithError "读不出 $PkgFile 里的 version" }
if (-not (Test-VersionFormat $before)) {
    Exit-WithError "package.json 里的版本号不是 x.y.z 形式：$before"
}

Write-Info ''
Write-Info "  $script:C_BOLD" + "MyApiTools 服务端镜像构建 & 推送" + "$script:C_RESET"
Write-Dim  '  ---------------------------------------------'
Write-Info "  镜像仓库  : $ImageRepo"
Write-Info '  版本来源  : server/package.json'
Write-Info "  构建上下文: $ScriptDir"
if ($DryRun) { Write-Dim '  模式      : -DryRun（不会真的构建/推送）' }
Write-Dim  '  ---------------------------------------------'

# 版本冲突检查。改完版本号要回到循环开头重新查一次 ——
# 新版本号同样可能已经存在于 Docker Hub（比如从别人那接手的分支）
$version = $before
$isSnapshot = $false
while ($true) {
    $version = Get-Version
    if ($version -ne $before) {
        Write-Ok "版本号已更新：$before → $version"
        $before = $version
    }

    # 每轮都重算：升完版本号之后，性质可能整个变了（快照 → 正式）
    $isSnapshot = Test-SnapshotVersion $version

    Write-Info ''
    Write-Info "  待发布版本: $script:C_BOLD$version$script:C_RESET"
    if ($isSnapshot) {
        Write-Dim '  版本性质  : 开发快照版（-dev）· 同一 tag 可随时覆盖重推'
    } else {
        Write-Dim '  版本性质  : 正式版 · 发布后内容不再变化'
    }

    if ($Force) {
        Write-Warn '已指定 -Force，跳过版本存在性检查'
        break
    }

    $exists = Get-TagExists $version
    if ($exists -eq 'no') {
        Write-Ok "Docker Hub 上还没有 $version，可以发布"
        break
    }
    elseif ($exists -eq 'yes') {
        # 快照版不做冲突询问：-dev 的定义就是「内容随时可能被覆盖」，
        # 每次构建推同一个 tag 是它的正常用法。CI 里 -Yes 也能直接跑通，
        # 否则想反复推快照就得给流水线塞 -Force（那个开关太宽，会连正式版一起放行）。
        if ($isSnapshot) {
            Write-Warn "${ImageRepo}:$version 已存在，快照版按规则直接覆盖"
            Write-Dim '  -dev 快照本来就会被反复重推，这是预期行为。'
            break
        }
        $action = Resolve-VersionConflict $version
        if ($action -eq 'abort') {
            Write-Info ''
            Write-Info '  已中止，什么都没改。'
            exit 1
        }
        if ($action -eq 'force') {
            Write-Warn "将强制覆盖 ${ImageRepo}:${version}"
            break
        }
        # 'bumped' → 回去重新检查新版本号
        continue
    }
    else {
        Write-Warn '无法确认该版本是否已存在（网络不通 / 仓库私有 / API 不可达）'
        Assert-Interactive
        if (-not $Yes) {
            $reply = Read-Answer '  仍要继续构建并推送吗? [y/N]'
            if ($reply -notmatch '^(y|yes)$') {
                Write-Info ''
                Write-Info '  已中止。'
                exit 1
            }
        }
        break
    }
}

# latest 只在正式版时更新。latest 是给「docker pull 一把梭」的人用的，
# 让它指向一个随时会被覆盖的开发快照，等于把不稳定版本悄悄推给所有人。
$PushLatest = $false
if ($NoLatest) {
    $PushLatest = $false
} elseif ($Latest) {
    $PushLatest = $true
} elseif ($isSnapshot) {
    $PushLatest = $false
} else {
    $PushLatest = $true
}

Write-Info ''
Write-Dim '  ---------------------------------------------'
Build-Image $version

Write-Info ''
Push-Image "${ImageRepo}:${version}" -Role 'version'
if ($PushLatest -and $version -ne 'latest') {
    Push-Image "${ImageRepo}:latest" -Role 'latest'
}

Write-Info ''
Write-Dim '  ---------------------------------------------'
if ($DryRun) {
    # 预演模式下 Push-Image 只是打印命令，什么都不会发生。这里若照旧打「发布完成」，
    # 用户很容易以为远端已经有了 —— 和「推送失败」一样属于"看着成功其实没有"。
    Write-Ok '预演结束（-DryRun：没构建、没推送，本地与远端都没变化）'
    Write-Dim '  去掉 -DryRun 再跑一次才会真正构建并推送。'
    Write-Info ''
} else {
    Write-Ok "发布完成：${ImageRepo}:${version}"
    if ($PushLatest) {
        Write-Dim "  同时更新了 ${ImageRepo}:latest"
    } elseif ((-not $NoLatest) -and $isSnapshot) {
        Write-Dim '  快照版未更新 latest（latest 只指向正式版；确实需要就加 -Latest）'
    }
    Write-Dim '  部署目录示例见 server/deploy/（只 pull 不 build）'
    Write-Info ''
}
