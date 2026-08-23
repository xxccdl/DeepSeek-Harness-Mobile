# =====================================================================
# DeepSeek Harness Mobile 发布脚本（GitHub + Gitee 双仓双 release）
#
# 功能流程：
#   1. bundle dsh（node scripts/bundle-dsh.mjs，把 dsh 引擎+插件打进 dsh-bundle.dat）
#   2. 构建 APK（android\gradlew.bat assembleRelease）
#   3. 获取 GitHub token（git credential fill github.com）
#   4. 推送 GitHub 代码 + 创建/更新 GitHub release + 上传 APK
#   5. 获取 Gitee token（git credential fill gitee.com）
#   6. 删除 Gitee 旧 APK/分卷附件（释放仓库配额）
#   7. 推送 Gitee 代码 + 创建/更新 Gitee release + 7-Zip 分卷后上传
#
# 用法（在 dsh-mobile/app 目录下）：
#   .\publish.ps1 -Version "1.0.2" [-ReleaseNotesFile .\release-notes.md] [-SkipBuild] [-SkipGithub] [-SkipGitee]
#
# 依赖：
#   - Node >= 22.11、JDK 17、Android SDK（构建用）
#   - curl.exe（Windows 10+ 自带）
#   - 7-Zip（分卷压缩；未安装时自动下载便携版 7za）
# =====================================================================

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,                    # 版本号，如 1.0.2（tag 自动加 v 前缀）

    [string]$ReleaseNotesFile,           # release 正文 markdown 文件（缺省用内置正文）

    [switch]$SkipBundle,                 # 跳过 bundle dsh
    [switch]$SkipBuild,                  # 跳过 APK 构建
    [switch]$SkipGithub,                 # 跳过 GitHub 推送+release
    [switch]$SkipGitee                   # 跳过 Gitee 推送+release
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------
# 配置
# ---------------------------------------------------------------
$RepoRoot    = $PSScriptRoot
$AndroidDir  = Join-Path $RepoRoot "android"
$ApkPath     = Join-Path $AndroidDir "app\build\outputs\apk\release\app-release.apk"
$BundleScript= Join-Path $RepoRoot "scripts\bundle-dsh.mjs"

# GitHub
$GhOwner = "xxccdl"
$GhRepo  = "DeepSeek-Harness-Mobile"
$GhRemote= "origin"
$GhBranch= "main"
$GhApi   = "https://api.github.com/repos/$GhOwner/$GhRepo"

# Gitee
$GtOwner = "xxccdl"
$GtRepo  = "deep-seek-harness-mobile"
$GtRemote= "gitee"
$GtBranch= "master"
$GtApi   = "https://gitee.com/api/v5/repos/$GtOwner/$GtRepo"

# 7-Zip 分卷大小（Gitee 附件上限 100MB，留余量用 90MiB）
$SplitVolume = "90m"

# JDK 17 自动探测：Gradle 工具链需要 Java 17，若 JAVA_HOME 不是 17（或未设置），
# 自动切换到本机已安装的 JDK 17（否则 Gradle 会尝试联网下载 toolchain 而失败）。
function Get-JavaVersion([string]$JavaHome) {
    $exe = Join-Path $JavaHome "bin\java.exe"
    if (-not (Test-Path $exe)) { return "" }
    # java -version 输出到 stderr；在 ErrorActionPreference=Stop 下会抛 NativeCommandError，
    # 这里临时降级为 Continue 并捕获 stderr
    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $v = & $exe -version 2>&1 | Select-Object -First 1
        return [string]$v
    } finally {
        $ErrorActionPreference = $oldEap
    }
}
function Resolve-Jdk17 {
    $candidates = @(
        "C:\Program Files\Microsoft\jdk-17.0.19.10-hotspot",
        "C:\Program Files\Microsoft\jdk-17*",
        "C:\Program Files\Eclipse Adoptium\jdk-17*",
        "C:\Program Files\Java\jdk-17*",
        "$env:ProgramFiles\Android\Android Studio\jbr"
    )
    # 当前 JAVA_HOME 已是 17 则直接复用
    if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
        $ver = Get-JavaVersion $env:JAVA_HOME
        if ($ver -match '"17\.') { return $env:JAVA_HOME }
    }
    foreach ($p in $candidates) {
        $resolved = Get-Item $p -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } | Select-Object -First 1
        if ($resolved) {
            $v = Get-JavaVersion $resolved.FullName
            if ($v -match '"17\.') { return $resolved.FullName }
        }
    }
    return $null
}
$Jdk = Resolve-Jdk17
if ($Jdk) {
    if ($env:JAVA_HOME -ne $Jdk) {
        Write-Host "   使用 JDK 17: $Jdk" -ForegroundColor Green
        $env:JAVA_HOME = $Jdk
        $env:Path = (Join-Path $Jdk "bin") + ";" + $env:Path
    }
} else {
    Write-Warning "未找到 JDK 17，Gradle 可能尝试联网下载 toolchain"
}

$Tag    = "v$Version"
$ApkName= "app-release.apk"

# ---------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------
function Resolve-Curl {
    $c = Get-Command curl.exe -ErrorAction SilentlyContinue
    if (-not $c) { throw "未找到 curl.exe" }
    return $c.Source
}
# Windows 自带 curl 走 schannel，国内网络访问 GitHub/Gitee 时证书吊销检查
# （CRYPT_E_NO_REVOCATION_CHECK）会失败；统一附带 --ssl-no-revoke 跳过吊销列表检查。
# 注意：不能放进数组再 `& $array`（PS5.1 会把数组整体当命令名），必须以参数数组展开。
$curlArgs = @("--ssl-no-revoke")

function Resolve-7z {
    $candidates = @(
        "C:\Program Files\7-Zip\7z.exe",
        "C:\Program Files (x86)\7-Zip\7z.exe",
        "$env:LOCALAPPDATA\Programs\7-Zip\7z.exe"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }

    $dir = Join-Path $env:TEMP "7zip"
    $exe = Join-Path $dir "extra\x64\7za.exe"
    if (-not (Test-Path $exe)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $r = Join-Path $dir "7zr.exe"
        $e = Join-Path $dir "7z2602-extra.7z"
        if (-not (Test-Path $r)) { Invoke-WebRequest -Uri "https://www.7-zip.org/a/7zr.exe" -OutFile $r -UseBasicParsing }
        if (-not (Test-Path $e)) { Invoke-WebRequest -Uri "https://www.7-zip.org/a/7z2602-extra.7z" -OutFile $e -UseBasicParsing }
        & $r x $e "-o$($dir)\extra" -y | Out-Null
    }
    if (-not (Test-Path $exe)) { throw "7-Zip 初始化失败：$exe" }
    return $exe
}

function Get-GitToken([string]$HostName) {
    $input = "protocol=https`nhost=$HostName`n`n"
    $out = $input | git credential fill 2>$null
    $line = $out | Where-Object { $_ -like "password=*" } | Select-Object -First 1
    if (-not $line) { throw "未从 git 凭据获取到 $HostName 的 token，请先 git push 一次以缓存凭据" }
    return $line.Substring("password=".Length).Trim()
}

function Write-Utf8File([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, (New-Object System.Text.UTF8Encoding($false)))
}

function Invoke-Json([scriptblock]$Cmd) {
    $raw = & $Cmd 2>$null
    if (-not $raw) { return $null }
    return ($raw -join "`n") | ConvertFrom-Json
}

function Get-ReleaseBody {
    if ($ReleaseNotesFile -and (Test-Path $ReleaseNotesFile)) {
        return [System.IO.File]::ReadAllText((Resolve-Path $ReleaseNotesFile))
    }
    return "DeepSeek Harness Mobile $Version`n"
}

function Write-Line([string]$Text) { Write-Host $Text -ForegroundColor Cyan }

# ---------------------------------------------------------------
# 1. bundle dsh
# ---------------------------------------------------------------
function Step-Bundle {
    Write-Line "==> [1/7] bundle dsh（dsh-bundle.dat）"
    Push-Location $RepoRoot
    try {
        node $BundleScript
        if ($LASTEXITCODE -ne 0) { throw "bundle dsh 失败" }
    }
    finally { Pop-Location }
}

# ---------------------------------------------------------------
# 2. 构建 APK
# ---------------------------------------------------------------
function Step-Build {
    Write-Line "==> [2/7] 构建 APK"
    Push-Location $AndroidDir
    try {
        & (Join-Path $AndroidDir "gradlew.bat") assembleRelease
        if ($LASTEXITCODE -ne 0) { throw "构建 APK 失败" }
    }
    finally { Pop-Location }
    if (-not (Test-Path $ApkPath)) { throw "未找到 APK：$ApkPath" }
    $sz = [math]::Round((Get-Item $ApkPath).Length / 1MB, 2)
    Write-Host "   APK: $ApkPath ($sz MB)" -ForegroundColor Green
}

# ---------------------------------------------------------------
# 3-4. GitHub
# ---------------------------------------------------------------
function Step-Github {
    Write-Line "==> [3/7] 获取 GitHub token"
    $token = Get-GitToken "github.com"
    $curl = Resolve-Curl
    $authHeaders = @("-H", "Authorization: token $token", "-H", "Accept: application/vnd.github+json")

    Write-Line "==> [4/7] 推送 GitHub 代码 + release"

    # 发布语义：先把工作区改动纳入版本控制（.gitignore 已排除签名/日志等敏感文件）
    $dirty = git -C $RepoRoot status --porcelain
    if ($dirty) {
        git -C $RepoRoot add -A
        git -C $RepoRoot commit -m "chore: release $Tag 代码同步" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "提交本地改动失败" }
        Write-Host "   已提交本地改动（release $Tag）" -ForegroundColor Green
    }
    # 同步远端：本地落后（non-fast-forward）时先 rebase 合并远端提交，再推送。
    # rebase 冲突时自动采用「本地版本」（发布语义 = 把本地当前代码推上去）。
    git -C $RepoRoot fetch $GhRemote 2>$null
    $counts = (git -C $RepoRoot rev-list --left-right --count "HEAD...$GhRemote/$GhBranch" 2>$null).Trim()
    if ($counts) {
        $parts = $counts -split "\s+"
        $behind = [int]$parts[1]
        if ($behind -gt 0) {
            Write-Host "   远端领先 $behind 个提交，rebase 合并..." -ForegroundColor Yellow
            git -C $RepoRoot rebase $GhRemote/$GhBranch | Out-Null
            if ($LASTEXITCODE -ne 0) {
                Write-Host "   rebase 冲突，自动采用本地版本解决..." -ForegroundColor Yellow
                $conflicts = (git -C $RepoRoot diff --name-only --diff-filter=U 2>$null)
                if ($conflicts) {
                    $conflicts | ForEach-Object { git -C $RepoRoot checkout --theirs -- $_ 2>$null; git -C $RepoRoot add -- $_ 2>$null }
                }
                $env:GIT_EDITOR = "true"
                git -C $RepoRoot rebase --continue | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "git rebase 冲突自动解决失败，请手动处理" }
            }
        }
    }
    git -C $RepoRoot push $GhRemote "$GhBranch" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "git push github 失败" }
    git -C $RepoRoot tag -f $Tag
    git -C $RepoRoot push -f $GhRemote $Tag | Out-Null

    # 查找/创建 release
    $existing = Invoke-Json { & $curl $curlArgs -sS "$GhApi/releases/tags/$Tag" @authHeaders }
    $releaseId = $null
    if ($existing -and $existing.id) {
        $releaseId = $existing.id
        Write-Host "   复用 GitHub release id=$releaseId" -ForegroundColor Yellow
    } else {
        $bodyJson = @{
            tag_name = $Tag; name = $Tag; body = (Get-ReleaseBody)
            target_commitish = $GhBranch; draft = $false; prerelease = $false
        } | ConvertTo-Json
        $bodyFile = Join-Path $env:TEMP "gh-release-$Tag.json"
        Write-Utf8File $bodyFile $bodyJson
        $created = Invoke-Json { & $curl $curlArgs -sS -X POST "$GhApi/releases" @authHeaders -H "Content-Type: application/json" --data-binary "@$bodyFile" }
        if (-not ($created -and $created.id)) { throw "创建 GitHub release 失败" }
        $releaseId = $created.id
        Write-Host "   创建 GitHub release id=$releaseId" -ForegroundColor Green
    }

    # 删除同名旧资产（避免重复）
    $assets = Invoke-Json { & $curl $curlArgs -sS "$GhApi/releases/$releaseId/assets" @authHeaders }
    if ($assets) {
        foreach ($a in @($assets)) {
            if ($a.name -eq $ApkName) {
                Write-Host "   删除旧资产 $($a.name) (id=$($a.id))" -ForegroundColor Yellow
                & $curl $curlArgs -sS -X DELETE "$GhApi/releases/assets/$($a.id)" @authHeaders | Out-Null
            }
        }
    }

    # 上传 APK
    Write-Host "   上传 APK 到 GitHub release ..."
    $up = Invoke-Json { & $curl $curlArgs -sS -X POST "https://uploads.github.com/repos/$GhOwner/$GhRepo/releases/$releaseId/assets?name=$ApkName" @authHeaders -H "Content-Type: application/vnd.android.package-archive" --data-binary "@$ApkPath" }
    if ($up -and $up.browser_download_url) { Write-Host "   GitHub 资产上传成功" -ForegroundColor Green }
    else { Write-Warning "GitHub 资产上传可能失败" }
}

# ---------------------------------------------------------------
# 5-7. Gitee
# ---------------------------------------------------------------
function Step-Gitee {
    Write-Line "==> [5/7] 获取 Gitee token"
    $token = Get-GitToken "gitee.com"
    $curl = Resolve-Curl

    # 确保 gitee 远程存在
    $remotes = git -C $RepoRoot remote
    if ($remotes -notcontains $GtRemote) {
        git -C $RepoRoot remote add $GtRemote "https://gitee.com/$GtOwner/$GtRepo.git"
    }

    # 查找/创建 release
    $existing = Invoke-Json { & $curl $curlArgs -sS "$GtApi/releases/tags/$Tag`?access_token=$token" }
    $releaseId = $null
    if ($existing -and $existing.id) {
        $releaseId = $existing.id
        Write-Host "   复用 Gitee release id=$releaseId" -ForegroundColor Yellow
    } else {
        $bodyFile = Join-Path $env:TEMP "gt-release-$Tag.md"
        Write-Utf8File $bodyFile (Get-ReleaseBody)
        $created = Invoke-Json { & $curl $curlArgs -sS -X POST "$GtApi/releases" --data-urlencode "access_token=$token" --data-urlencode "tag_name=$Tag" --data-urlencode "name=$Tag" --data-urlencode "body@$bodyFile" }
        if (-not ($created -and $created.id)) { throw "创建 Gitee release 失败" }
        $releaseId = $created.id
        Write-Host "   创建 Gitee release id=$releaseId" -ForegroundColor Green
    }

    # 释放仓库配额：删除旧 .apk / .zip.00* 附件
    Write-Line "==> [6/7] 清理 Gitee 旧 APK 附件（释放配额）"
    $attach = Invoke-Json { & $curl $curlArgs -sS "$GtApi/releases/$releaseId/attach_files?access_token=$token" }
    if ($attach) {
        foreach ($a in @($attach)) {
            if ($a.name -match '\.apk$' -or $a.name -match '\.zip\.00[0-9]$') {
                Write-Host "   删除旧附件 $($a.name) (id=$($a.id))" -ForegroundColor Yellow
                & $curl $curlArgs -sS -X DELETE "$GtApi/releases/$releaseId/attach_files/$($a.id)?access_token=$token" | Out-Null
            }
        }
    }

    # 清理 git 里被追踪的大文件（防止仓库配额被占）
    $tracked = git -C $RepoRoot ls-files "*.apk" "*.zip" "*.dat" "*.tgz" "*.tar.gz"
    if ($tracked) {
        foreach ($f in $tracked) { git -C $RepoRoot rm --cached $f | Out-Null }
        git -C $RepoRoot commit -m "chore: 移除仓库内大体积产物，改用 release 附件分发" | Out-Null
        Write-Host "   已从 git 索引移除大文件" -ForegroundColor Yellow
    }

    # 推送代码 + tag
    Write-Line "==> [7/7] 推送 Gitee 代码 + 分卷上传"
    git -C $RepoRoot push -f $GtRemote "$GhBranch`:$GtBranch" | Out-Null
    git -C $RepoRoot push -f $GtRemote $Tag | Out-Null

    # 7-Zip 分卷
    $outDir = Join-Path $RepoRoot "dist-gitee"
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    Remove-Item "$outDir\app-release.zip.*" -ErrorAction SilentlyContinue
    $seven = Resolve-7z
    Write-Host "   7-Zip 分卷（体积上限 $SplitVolume）..."
    & $seven a -tzip -mx0 "-v$SplitVolume" "$outDir\app-release.zip" $ApkPath | Out-Null
    $parts = Get-ChildItem $outDir -Filter "app-release.zip.*" | Sort-Object Name
    if (-not $parts) { throw "分卷失败，未生成 .zip.00* 文件" }

    # 上传分卷
    foreach ($p in $parts) {
        Write-Host "   上传 $($p.Name) ($([math]::Round($p.Length/1MB,2)) MB) ..."
        $resp = Invoke-Json { & $curl $curlArgs -sS -X POST "$GtApi/releases/$releaseId/attach_files" -F "access_token=$token" -F "file=@$($p.FullName -replace '\\','/')" }
        if ($resp -and $resp.browser_download_url) { Write-Host "     -> 成功" -ForegroundColor Green }
        else { Write-Warning "     -> 失败" }
    }
}

# ---------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------
try {
    if (-not $SkipBundle) { Step-Bundle }
    if (-not $SkipBuild)  { Step-Build }
    if (-not $SkipGithub) { Step-Github }
    if (-not $SkipGitee)  { Step-Gitee }
    Write-Host ""
    Write-Host "全部完成：tag=$Tag" -ForegroundColor Green
}
catch {
    Write-Host "发布失败：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}