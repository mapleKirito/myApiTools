<#
.SYNOPSIS
    MyApiTools 同步服务 —— 把本地镜像打 tag 后推送到阿里云 ACR（Windows / PowerShell 版）

.DESCRIPTION
    与同目录的 build-push-acr.sh 行为完全等价。版本号唯一来源是 server/package.json。

    .\build-push-acr.ps1               给本地镜像打 ACR tag 并推送 :<版本号>
    .\build-push-acr.ps1 -DryRun       只做检查与提示，不打 tag 不 push
    .\build-push-acr.ps1 -NoLatest     只推 :<版本号>，不动 latest
    .\build-push-acr.ps1 -Latest       快照版也更新 latest（默认只有正式版才动）
    .\build-push-acr.ps1 -Help

    关键约定：本脚本【不构建镜像】。
      它复用 build-push-dockerhub.ps1 已在本地构建好的 Docker Hub 镜像
      （myzhouye/myapitools-server:<版本号>），直接 docker tag 成 ACR 地址后推送。
      若本地该镜像不存在，脚本会报错并提示你先跑 build-push-dockerhub.ps1。
      这样 Docker Hub 与 ACR 各推一次，docker build 只跑一次。

.PARAMETER ImageRepo
    Docker Hub 仓库名（本地构建镜像的来源），默认 myzhouye/myapitools-server。也可用环境变量 IMAGE_REPO。

.PARAMETER AcrRepo
    阿里云 ACR 仓库，默认 registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server。也可用环境变量 ACR_REPO。
    公开仓库匿名即可 pull，私有仓库需先 docker login 对应 ACR 域名。

.EXAMPLE
    .\build-push-acr.ps1 -DryRun
    先看看它会做什么，不真的打 tag / 推送。
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$NoLatest,
    [switch]$Latest,
    [switch]$Help,
    [switch]$Force,   # ACR 覆盖推送无需确认，接受但忽略
    [switch]$Yes,     # 同上，接受但忽略
    [string]$ImageRepo = $(if ($env:IMAGE_REPO) { $env:IMAGE_REPO } else { 'myzhouye/myapitools-server' }),
    [string]$AcrRepo = $(if ($env:ACR_REPO) { $env:ACR_REPO } else { 'registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server' })
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PkgFile   = Join-Path $ScriptDir 'package.json'

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
MyApiTools 同步服务 —— 把本地镜像推送到阿里云 ACR（不构建，Windows）

  .\build-push-acr.ps1               给本地镜像打 ACR tag 并推送 :<版本号>
  .\build-push-acr.ps1 -DryRun       只做检查与提示，不打 tag 不 push
  .\build-push-acr.ps1 -NoLatest     只推 :<版本号>，不动 latest
  .\build-push-acr.ps1 -Latest       快照版也更新 latest（默认只有正式版才动）
  .\build-push-acr.ps1 -Help

环境变量：
  IMAGE_REPO   Docker Hub 仓库名（本地构建镜像的来源），默认 myzhouye/myapitools-server
  ACR_REPO     阿里云 ACR 仓库，默认 registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server
               （ECS 默认拉不到 Docker Hub，推一份到 ACR，部署端改从 ACR 拉；
                公开仓库匿名即可 pull，私有仓库需先 docker login 对应 ACR 域名）

版本号规则（唯一来源：本目录的 package.json）：

  x.y.z        正式版。发布后内容不再变化；latest 指向正式版。
  x.y.z-dev    开发快照版（x.y.z-dev.N 同理）。同一 tag 可随时覆盖重推，默认不动 latest。

注意：本脚本不执行 docker build，必须先在本地构建好 Docker Hub 镜像
      （用 build-push-dockerhub.ps1，本地没有时它会自动构建）。
'@
    Write-Host $text
    exit 0
}

# ------------------------------------------------------------ 版本号读写
function Get-Version {
    $raw = Get-Content -LiteralPath $PkgFile -Raw -Encoding UTF8
    try {
        $obj = $raw | ConvertFrom-Json
        if ($obj.PSObject.Properties.Name -contains 'version' -and $obj.version) {
            return [string]$obj.version
        }
    } catch { }
    $m = [regex]::Match($raw, '"version"\s*:\s*"([^"]+)"')
    if (-not $m.Success) { return '' }
    return $m.Groups[1].Value
}

function Test-VersionFormat {
    param([string]$Version)
    return $Version -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

function Test-SnapshotVersion {
    param([string]$Version)
    return $Version -match '-dev(\.|$)'
}

function Test-LocalImage {
    param([string]$Ref)
    docker image inspect $Ref *> $null
    return ($LASTEXITCODE -eq 0)
}

# ------------------------------------------------------- 构建与推送
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

function Get-LoginHint {
    param([string]$Ref)
    $registry = ($Ref -split '/')[0]
    if ($registry -match '\.') { return "docker login $registry" }
    return "docker login -u $registry"
}

function Write-PushFailedReport {
    param([string]$Ref, [string]$Reason, [string]$Hint)
    Write-Host ''
    Write-Err "本地镜像没有推送到 ACR：$Ref"
    Write-Info ''
    Write-Warn '本地镜像已经打好了 ACR tag，远端拿不到它'
    Write-Dim '  部署端（ECS）执行 docker compose pull 会报 not found 或拉到旧内容 —— 原因就是这次没推上去。'
    Write-Info ''
    Write-Dim "  失败原因：$Reason"
    Write-Dim "  怎么办：$Hint"
    Write-Info ''
}

function Push-Image {
    param([string]$Ref)
    if ($DryRun) {
        Invoke-Shown @('docker', 'push', $Ref) | Out-Null
        return $true
    }
    $out = & docker push $Ref 2>&1
    if ($LASTEXITCODE -ne 0) {
        $out | ForEach-Object { Write-Host $_ }
        $joined = ($out | Out-String)
        if ($joined -match '(?i)denied|unauthorized|authentication required|access token') {
            $reason = '推送被拒绝（没登录 ACR，或当前账号对该仓库没有写权限）'
            $hint = "先登录再重跑：$(Get-LoginHint $Ref)"
        } else {
            $reason = '推送失败（网络中断 / ACR 不可达 / Docker 异常）'
            $hint = '确认网络与 Docker 状态后重跑本脚本'
        }
        Write-PushFailedReport -Ref $Ref -Reason $reason -Hint $hint
        return $false
    }
    $out | Select-Object -Last 2 | ForEach-Object { Write-Host $_ }
    Write-Ok "已推送 $Ref"
    return $true
}

# ------------------------------------------------------------- 主流程
if ($Help) { Show-Usage }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Exit-WithError '找不到 docker 命令，请先安装 Docker Desktop'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Exit-WithError 'Docker 没在运行（docker info 失败）' }

$repoPart = ($ImageRepo -split ':')[0]
if ($repoPart -cmatch '[A-Z]') {
    Exit-WithError @"
Docker Hub 镜像仓库名不能含大写字母：$repoPart
    Docker 只接受全小写仓库名：
      .\build-push-acr.ps1 -ImageRepo myzhouye/myapitools-server
"@
}
$acrPart = ($AcrRepo -split ':')[0]
if ($acrPart -cmatch '[A-Z]') {
    Exit-WithError @"
ACR 镜像仓库名不能含大写字母：$acrPart
    Docker 只接受全小写仓库名：
      .\build-push-acr.ps1 -AcrRepo registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server
"@
}

$before = Get-Version
if ([string]::IsNullOrWhiteSpace($before)) { Exit-WithError "读不出 $PkgFile 里的 version" }
if (-not (Test-VersionFormat $before)) {
    Exit-WithError "package.json 里的版本号不是 x.y.z 形式：$before"
}

Write-Info ''
Write-Info "  $script:C_BOLD" + "MyApiTools 服务端镜像 → 阿里云 ACR（只打 tag / 推送，不构建）" + "$script:C_RESET"
Write-Dim  '  ---------------------------------------------'
Write-Info "  本地来源  : $ImageRepo（由 build-push-dockerhub.ps1 构建）"
Write-Info "  ACR 目标  : $AcrRepo"
Write-Info '  版本来源  : server/package.json'
if ($DryRun) { Write-Dim '  模式      : -DryRun（不会打 tag / 推送）' }
Write-Dim  '  ---------------------------------------------'

$version = $before
$isSnapshot = Test-SnapshotVersion $version
Write-Info ''
Write-Info "  待发布版本: $script:C_BOLD$version$script:C_RESET"
if ($isSnapshot) {
    Write-Dim '  版本性质  : 开发快照版（-dev）· ACR 同 tag 直接覆盖'
} else {
    Write-Dim '  版本性质  : 正式版 · 发布后内容不再变化'
}

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

# ── 核心：复用本地已构建的 Docker Hub 镜像，不重复 build ──
Write-Info ''
Write-Dim '  ---------------------------------------------'
if (-not (Test-LocalImage "${ImageRepo}:${version}")) {
    Write-Err "本地找不到 Docker Hub 构建镜像 ${ImageRepo}:${version}"
    Write-Dim '  ACR 脚本不重复构建镜像。请先运行 build-push-dockerhub.ps1（本地没有时它会自动构建），'
    Write-Dim '  再来推 ACR；或者手动 docker build -t 后重跑本脚本。'
    exit 1
}
Write-Ok "本地已有构建镜像 ${ImageRepo}:${version}，直接打 ACR tag 并推送（不构建）"

Invoke-Shown @('docker', 'tag', "${ImageRepo}:${version}", "${AcrRepo}:${version}") | Out-Null
if ($PushLatest -and $version -ne 'latest') {
    Invoke-Shown @('docker', 'tag', "${ImageRepo}:${version}", "${AcrRepo}:latest") | Out-Null
}

Write-Info ''
$acrOk = $true
if (-not (Push-Image "${AcrRepo}:${version}")) { $acrOk = $false }
if ($PushLatest -and $version -ne 'latest') {
    if (-not (Push-Image "${AcrRepo}:latest")) { $acrOk = $false }
}

Write-Info ''
Write-Dim '  ---------------------------------------------'
if ($DryRun) {
    Write-Ok '预演结束（-DryRun：没打 tag、没推送）'
    Write-Dim '  去掉 -DryRun 再跑一次才会真正打 tag 并推送。'
    Write-Info ''
} else {
    if (-not $acrOk) {
        Write-Err 'ACR 推送失败，部署端（ECS）拉不到镜像'
        exit 1
    }
    Write-Ok "发布完成（ACR）：${AcrRepo}:${version}"
    if ($PushLatest) {
        Write-Dim "  同时更新了 ${AcrRepo}:latest"
    } elseif ((-not $NoLatest) -and $isSnapshot) {
        Write-Dim '  快照版未更新 latest（latest 只指向正式版；确实需要就加 -Latest）'
    }
    Write-Dim '  部署端（ECS）把 compose 的 image 改成 ACR 地址后即可 docker compose pull 拉取。'
    Write-Info ''
}
