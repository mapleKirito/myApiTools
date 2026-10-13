<#
.SYNOPSIS
    MyApiTools 同步服务 —— 构建镜像并推送到 Docker Hub（Windows / PowerShell 版）

.DESCRIPTION
    与同目录的 build-push-dockerhub.sh 行为完全等价。版本号唯一来源是 server/package.json。

    .\build-push-dockerhub.ps1                 构建（若本地还没有）并推送 :<版本号>
    .\build-push-dockerhub.ps1 -DryRun         只做检查与提示，不 build 不 push
    .\build-push-dockerhub.ps1 -Yes            不提问；正式版冲突直接判失败（CI 用）
    .\build-push-dockerhub.ps1 -Force          跳过版本存在性检查，直接覆盖
    .\build-push-dockerhub.ps1 -NoLatest       只推 :<版本号>，不动 latest
    .\build-push-dockerhub.ps1 -Latest         快照版也更新 latest（默认只有正式版才动）
    .\build-push-dockerhub.ps1 -Help

    关键优化：先检查本地是否已经有构建好的镜像
      （docker image 里有 myzhouye/myapitools-server:<版本号>）。
        · 有  → 直接推送，不再重复 docker build
        · 没有 → 构建（打 :<版本号> 和 :latest 两个 tag）后再推送
      想单独把已构建的镜像推到 ACR，用同目录的 build-push-acr.ps1。

.PARAMETER ImageRepo
    镜像仓库名，默认 myzhouye/myapitools-server。也可用环境变量 IMAGE_REPO。
    注意 Docker 要求仓库名全小写，带大写会在 build 阶段直接报错。

.EXAMPLE
    .\build-push-dockerhub.ps1 -DryRun
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
MyApiTools 同步服务 —— 构建镜像并推送到 Docker Hub（Windows）

  .\build-push-dockerhub.ps1                 构建（若本地还没有）并推送 :<版本号>
  .\build-push-dockerhub.ps1 -DryRun         只做检查与提示，不 build 不 push
  .\build-push-dockerhub.ps1 -Yes            不提问；正式版冲突直接判失败（CI 用）
  .\build-push-dockerhub.ps1 -Force          跳过版本存在性检查，直接覆盖
  .\build-push-dockerhub.ps1 -NoLatest       只推 :<版本号>，不动 latest
  .\build-push-dockerhub.ps1 -Latest         快照版也更新 latest（默认只有正式版才动）
  .\build-push-dockerhub.ps1 -Help

环境变量：
  IMAGE_REPO   镜像仓库名，默认 myzhouye/myapitools-server
               （Docker 要求仓库名全小写，带大写会在 build 阶段直接报错）

版本号规则（唯一来源：本目录的 package.json）：

  x.y.z        正式版。发布后内容不再变化。同一 tag 已存在时会停下来问你，
               默认不替你覆盖；-Yes 下直接判失败。
  x.y.z-dev    开发快照版（x.y.z-dev.N 同理）。同一 tag 可随时覆盖重推，
               默认不动 latest（想强行更新用 -Latest）。

提示：镜像推到 Docker Hub 后，再用 build-push-acr.ps1 推一份到阿里云 ACR，
      供境内服务器（Docker Hub 拉取常超时）部署用。两个脚本都复用本地已构建的镜像，
      不会重复 docker build。
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

function Set-Version {
    param([string]$NewVersion)
    $raw = Get-Content -LiteralPath $PkgFile -Raw -Encoding UTF8
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
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($PkgFile, $new, $utf8NoBom)
}

function Test-VersionFormat {
    param([string]$Version)
    return $Version -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

function Test-SnapshotVersion {
    param([string]$Version)
    return $Version -match '-dev(\.|$)'
}

function Get-BumpedVersion {
    param([string]$Version, [ValidateSet('major', 'minor', 'patch')][string]$Part)
    $core = ($Version -split '-')[0]
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
function Get-TagExists {
    param([string]$Tag)
    $repoLc = $ImageRepo.ToLowerInvariant()
    $url = "https://registry.hub.docker.com/v2/repositories/$repoLc/tags/$Tag/"
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
    }
    $env:DOCKER_CLI_EXPERIMENTAL = 'enabled'
    docker manifest inspect "${ImageRepo}:$Tag" *> $null
    if ($LASTEXITCODE -eq 0) { return 'yes' }
    return 'unknown'
}

# 本地是否已经有构建好的镜像（永远查真实的 docker daemon）
function Test-LocalImage {
    param([string]$Ref)
    docker image inspect $Ref *> $null
    return ($LASTEXITCODE -eq 0)
}

# --------------------------------------------------------------- 交互
function Test-InteractiveConsole {
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

function Resolve-VersionConflict {
    param([string]$Short)
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
    $args += $ScriptDir
    $code = Invoke-Shown (@('docker') + $args)
    if ($code -ne 0) { Exit-WithError "镜像构建失败（docker build 退出码 $code）" }
}

# 若需要推 latest 但本地没有 :latest tag，从 :<version> 补打一个
function Assert-LatestTag {
    param([string]$Version)
    if ($PushLatest -and $Version -ne 'latest') {
        if (-not (Test-LocalImage "${ImageRepo}:latest")) {
            Write-Dim "  本地没有 ${ImageRepo}:latest，从 :$Version 补打该 tag"
            Invoke-Shown @('docker', 'tag', "${ImageRepo}:${Version}", "${ImageRepo}:latest") | Out-Null
        }
    }
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
    Write-Err "本地最新镜像没有推送到远端：$Ref"
    Write-Info ''
    Write-Warn '本地镜像已经构建出来了，远端拿不到它'
    Write-Dim "  远端 $Ref 仍是上一次推送的内容（这个 tag 从没推过时则根本不存在）。"
    Write-Dim '  部署端执行 docker compose pull 会报 not found 或拉到旧内容 —— 原因就是这次没推上去。'
    Write-Info ''
    Write-Dim "  失败原因：$Reason"
    Write-Dim "  怎么办：$Hint"
    Write-Dim '  只想本机先用：docker compose up -d（本地已有该镜像，不会去远端拉）'
    Write-Info ''
}

function Push-Image {
    param([string]$Ref, [string]$Role = 'version')
    if ($DryRun) {
        Invoke-Shown @('docker', 'push', $Ref) | Out-Null
        return $true
    }
    $out = & docker push $Ref 2>&1
    if ($LASTEXITCODE -ne 0) {
        $out | ForEach-Object { Write-Host $_ }
        $joined = ($out | Out-String)
        if ($joined -match '(?i)denied|unauthorized|authentication required|access token') {
            $reason = '推送被拒绝（没登录，或当前账号对该仓库没有写权限）'
            $hint = "先登录再重跑：$(Get-LoginHint $Ref)"
        } else {
            $reason = '推送失败（网络中断 / registry 不可达 / Docker 异常）'
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
镜像仓库名不能含大写字母：$repoPart
    Docker 只接受全小写仓库名（Docker Hub 上大小写指向同一个仓库，改小写即可）：
      .\build-push-dockerhub.ps1 -ImageRepo myzhouye/myapitools-server
"@
}

$before = Get-Version
if ([string]::IsNullOrWhiteSpace($before)) { Exit-WithError "读不出 $PkgFile 里的 version" }
if (-not (Test-VersionFormat $before)) {
    Exit-WithError "package.json 里的版本号不是 x.y.z 形式：$before"
}

Write-Info ''
Write-Info "  $script:C_BOLD" + "MyApiTools 服务端镜像构建 & 推送（Docker Hub）" + "$script:C_RESET"
Write-Dim  '  ---------------------------------------------'
Write-Info "  镜像仓库  : $ImageRepo"
Write-Info '  版本来源  : server/package.json'
Write-Info "  构建上下文: $ScriptDir"
if ($DryRun) { Write-Dim '  模式      : -DryRun（不会真的构建/推送）' }
Write-Dim  '  ---------------------------------------------'

$version = $before
$isSnapshot = $false
while ($true) {
    $version = Get-Version
    if ($version -ne $before) {
        Write-Ok "版本号已更新：$before → $version"
        $before = $version
    }
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
if (Test-LocalImage "${ImageRepo}:${version}") {
    Write-Ok "本地已有构建好的镜像 ${ImageRepo}:${version}，跳过 docker build"
} else {
    Write-Warn "本地没有 ${ImageRepo}:${version}，开始构建"
    Build-Image $version
}
Assert-LatestTag $version

Write-Info ''
$dhOk = $true
if (-not (Push-Image "${ImageRepo}:${version}" -Role 'version')) { $dhOk = $false }
if ($PushLatest -and $version -ne 'latest') {
    if (-not (Push-Image "${ImageRepo}:latest" -Role 'latest')) { $dhOk = $false }
}

Write-Info ''
Write-Dim '  ---------------------------------------------'
if ($DryRun) {
    Write-Ok '预演结束（-DryRun：没构建、没推送，本地与远端都没变化）'
    Write-Dim '  去掉 -DryRun 再跑一次才会真正构建并推送。'
    Write-Info ''
} else {
    if (-not $dhOk) {
        Write-Err 'Docker Hub 推送失败，本地镜像没推上去'
        exit 1
    }
    Write-Ok "发布完成：${ImageRepo}:${version}"
    if ($PushLatest) {
        Write-Dim "  同时更新了 ${ImageRepo}:latest"
    } elseif ((-not $NoLatest) -and $isSnapshot) {
        Write-Dim '  快照版未更新 latest（latest 只指向正式版；确实需要就加 -Latest）'
    }
    Write-Dim '  要再推一份到阿里云 ACR（境内服务器拉取用）：同目录 build-push-acr.ps1'
    Write-Dim '  部署目录示例见 server/deploy/（只 pull 不 build）'
    Write-Info ''
}
