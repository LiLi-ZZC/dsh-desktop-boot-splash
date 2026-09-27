<#
  把本目录安装成 DSH 插件（dsh-desktop-boot-splash）。

  用法：
    双击 安装插件.cmd                （内部就是调用本脚本）
    pwsh -File install-plugin.ps1
    pwsh -File install-plugin.ps1 -Remove        # 卸掉插件
    pwsh -File install-plugin.ps1 -Profile web   # 装到 web profile

  为什么需要脚本而不是一条 dsh 命令：
    dsh 命令随 DSH Desktop 分发，路径里带一个会变的 generation 目录，而且通常不在系统 PATH 里，
    所以才要先把 dsh.cmd 找出来。
#>
[CmdletBinding()]
param(
	[ValidateSet("desktop", "web")]
	[string]$Profile = "desktop",
	[switch]$Remove
)

$ErrorActionPreference = "Stop"

$PluginDir = $PSScriptRoot
$PackageName = "dsh-desktop-boot-splash"
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$ProfileDir = Join-Path (Join-Path $DshHome "profiles") $Profile

function Write-Head([string]$Message) {
	Write-Host ""
	Write-Host $Message -ForegroundColor Cyan
}

function Write-Ok([string]$Message) {
	Write-Host "  $Message" -ForegroundColor Green
}

function Write-Step([string]$Message) {
	Write-Host "  $Message"
}

function Write-Warn2([string]$Message) {
	Write-Host "  $Message" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 找 dsh 命令
function Find-Dsh {
	$onPath = Get-Command dsh -ErrorAction SilentlyContinue
	if ($null -ne $onPath) { return $onPath.Source }
	$hostCommands = Join-Path $env:APPDATA "DSH Desktop\host-commands"
	$generations = Join-Path $hostCommands "$Profile\generations"
	if (-not (Test-Path -LiteralPath $generations)) { return $null }
	$candidates = Get-ChildItem -LiteralPath $generations -Recurse -Filter "dsh.cmd" -File -ErrorAction SilentlyContinue |
		Sort-Object LastWriteTime -Descending
	if ($candidates.Count -eq 0) { return $null }
	return $candidates[0].FullName
}

Write-Head "DSH Desktop 开机动画 —— 插件安装"
Write-Step "插件目录: $PluginDir"
Write-Step "目标 profile: $Profile"

$dsh = Find-Dsh
if ($null -eq $dsh) {
	Write-Warn2 "没找到 dsh 命令。请先安装并启动一次 DSH Desktop，再运行本安装。"
	Write-Host ""
	Write-Host "如果 DSH Desktop 已经装好了，也可以手动执行：" -ForegroundColor Yellow
	Write-Host "  `$dsh = (Get-ChildItem `"`$env:APPDATA\DSH Desktop\host-commands\desktop\generations`" -Recurse -Filter dsh.cmd |"
	Write-Host "          Sort-Object LastWriteTime -Descending)[0].FullName"
	Write-Host "  & `$dsh plugin --profile $Profile add `"file:$PluginDir`""
	exit 1
}
Write-Step "dsh 命令: $dsh"

# profile 必须已经存在 —— 它由 DSH Desktop 首次启动时创建
if (-not (Test-Path -LiteralPath (Join-Path $ProfileDir "package.json"))) {
	Write-Warn2 "profile 还不存在: $ProfileDir"
	Write-Warn2 "请先完整启动一次 DSH Desktop（它会创建 profile），然后再运行本安装。"
	exit 1
}
Write-Step "profile: $ProfileDir"

# ---------------------------------------------------------------- 执行
if ($Remove) {
	Write-Step "正在卸载 $PackageName ..."
	& $dsh plugin --profile $Profile remove $PackageName
	if ($LASTEXITCODE -ne 0) {
		Write-Warn2 "卸载命令返回 $LASTEXITCODE（可能本来就没装）"
		exit $LASTEXITCODE
	}
	Write-Ok "已从 profile 移除"

	# 卸载 = 连开机动画一起拿掉。
	# 面板卸载走的是负载的自清理（下次启动时发现插件没了就撤补丁）；
	# 这里是命令行路径，显式撤一遍，省得还要等下一次启动。
	Write-Step "正在移除开机动画补丁 ..."
	& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PluginDir "install.ps1") -Revert
	if ($LASTEXITCODE -ne 0) {
		Write-Warn2 "补丁还原返回 $LASTEXITCODE —— 也可以手动跑: pwsh -File `"$PluginDir\install.ps1`" -Revert"
	} else {
		Write-Ok "补丁已移除，开机动画不会再出现"
	}
	Write-Host ""
	Write-Host "你放在 ~\.dsh\boot-animation\ 里的片源（intro.mp4、videos\）没有被删。" -ForegroundColor DarkGray
	Write-Host "想连它们一起清掉，手动删掉那个目录即可。" -ForegroundColor DarkGray
	exit 0
}

Write-Step "正在安装 $PackageName ..."
# 已经装过就先移除再装：pnpm 对同一个 file: 路径会认为「已是最新」，不跟进源码改动 ——
# 换过默认片头/改过代码后直接 add，装进去的可能还是旧副本（这个坑踩过两次）。
$alreadyInstalled = $false
try {
	$existing = Get-Content -LiteralPath (Join-Path $ProfileDir "package.json") -Raw | ConvertFrom-Json
	$alreadyInstalled = $null -ne $existing.dependencies.$PackageName
} catch {
	$alreadyInstalled = $false
}
if ($alreadyInstalled) {
	Write-Step "已装过，先移除旧副本以确保取到最新内容 ..."
	& $dsh plugin --profile $Profile remove $PackageName | Out-Null
}
& $dsh plugin --profile $Profile add "file:$PluginDir"
if ($LASTEXITCODE -ne 0) {
	Write-Warn2 "安装命令返回 $LASTEXITCODE"
	exit $LASTEXITCODE
}

# 复核：profile 的 package.json 里应该出现这个依赖
$installed = $false
try {
	$pkg = Get-Content -LiteralPath (Join-Path $ProfileDir "package.json") -Raw | ConvertFrom-Json
	$installed = $null -ne $pkg.dependencies.$PackageName
} catch {
	# 读不出来就靠命令返回码。
	$installed = $LASTEXITCODE -eq 0
}
if ($installed) { Write-Ok "已登记到 profile 的依赖与 bundles" } else { Write-Warn2 "命令成功，但没在 profile 里读到该依赖，请留意启动日志" }

Write-Head "下一步"
Write-Step "1. 完全退出 DSH Desktop（托盘图标也要退）"
Write-Step "2. 重新打开 —— 这次插件会打补丁，动画可能还看不到"
Write-Step "3. 再退出、再打开一次 —— 动画就出现了，之后一直有"
Write-Host ""
Write-Step "默认播放：插件自带的片头（assets\dsh-boot-splash-default.mp4）"
Write-Step "查看状态：node `"$PluginDir\lib\cli.js`" status"
Write-Host ""
