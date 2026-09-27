<#
  dsh-desktop-boot-splash — 给 DSH Desktop（Electron 壳）装一个真正的开机动画。

  做的事：
    1. 把 assets\ 下三个文件复制进 <AppDir>\resources\app\lib\
    2. 在 main.js 里 app.whenReady() 之后插入 startBootSplash();
    3. 在 electron-runtime-*.js 的 revealApplication() 开头插入一次拦截，
       让主窗口的首次显示等到动画播完（或跳过 / 超时）
    4. 改动前把原文件备份成 *.dsh-boot-splash.bak，-Revert 可完整还原

  幂等：重复运行不会重复插入，也不会污染备份。

  关于"应用更新后失效"：DSH Desktop 更新会整体替换 resources\app，补丁随之消失。
  两种自动化手段（推荐第一种）：
    · 装成本插件（dsh-desktop-boot-splash）—— profile 在用户目录，更新不碰它，
      插件每次启动自检，发现补丁没了就自动补回，更新后最多损失一次启动的动画
    · 本脚本 -AutoRepair —— 注册一个登录时触发的计划任务，每次登录自动补一次
  两种都装也不冲突（补丁是幂等的）。

  用法：
    pwsh -File install.ps1                 # 安装 / 重新安装
    pwsh -File install.ps1 -Revert         # 还原成官方原样（并移除计划任务）
    pwsh -File install.ps1 -AutoRepair     # 顺手注册登录时自动修复的计划任务
    pwsh -File install.ps1 -BakeClip       # 把当前片源另存一份，摆脱对 dsh-boot-animation 的依赖
    pwsh -File install.ps1 -AppDir "D:\DSH Desktop"
#>
[CmdletBinding()]
param(
	[string]$AppDir = "",
	[switch]$Revert,
	[switch]$BakeClip,
	[switch]$Force,
	[switch]$AutoRepair,
	[switch]$Quiet
)

$ErrorActionPreference = "Stop"

$PayloadDir = Join-Path $PSScriptRoot "assets"
$Suffix = ".dsh-boot-splash.bak"
$Marker = "__dshBootSplash"
$PayloadFiles = @("dsh-boot-splash-clip.js", "dsh-boot-splash.js", "dsh-boot-splash-orphan.js", "dsh-boot-splash.html", "dsh-boot-splash-default.mp4")
$StateFile = "dsh-boot-splash-state.json"
$ElectronImport = 'import { app, crashReporter, dialog, safeStorage, screen, session, shell, utilityProcess } from "electron";'
$TaskName = "dsh-desktop-boot-splash-repair"

function Write-Fail([string]$Message) {
	Write-Host "错误: $Message" -ForegroundColor Red
	exit 1
}

function Write-Info([string]$Message) {
	if ($Quiet) { return }
	Write-Host $Message
}

function Write-Step([string]$Message) {
	if ($Quiet) { return }
	Write-Host "  $Message"
}

function Read-Text([string]$Path) {
	return [System.IO.File]::ReadAllText($Path)
}

function Write-Text([string]$Path, [string]$Text) {
	$utf8 = New-Object System.Text.UTF8Encoding($false)
	[System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Get-Newline([string]$Text) {
	if ($Text.Contains("`r`n")) { return "`r`n" }
	return "`n"
}

function Test-Node() {
	$command = Get-Command node -ErrorAction SilentlyContinue
	return $null -ne $command
}

# 把打完补丁的文件当 ESM 解析一遍，语法坏掉就别让它上机。
# 走 cmd /c 而不是 PowerShell 管道：后者会把 node 写到 stderr 的报错变成终止性错误，
# 于是回滚分支根本来不及执行（这个坑真的踩过一次）。
function Test-Syntax([string]$Path) {
	if (-not (Test-Node)) { return $true }
	$temp = Join-Path $env:TEMP ("dsh-boot-splash-check-" + [System.IO.Path]::GetFileNameWithoutExtension($Path) + ".mjs")
	Copy-Item -LiteralPath $Path -Destination $temp -Force
	$output = & cmd /c "node --check `"$temp`" 2>&1"
	$ok = $LASTEXITCODE -eq 0
	if (-not $ok) {
		Write-Host "  语法错误: $(($output | Select-Object -First 3) -join ' | ')" -ForegroundColor Red
	}
	Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
	return $ok
}

function Restore-Backup([string]$Path) {
	$backup = "$Path$Suffix"
	if (Test-Path -LiteralPath $backup) {
		Copy-Item -LiteralPath $backup -Destination $Path -Force
		Write-Step ("已回滚 " + [System.IO.Path]::GetFileName($Path))
	}
}

# 是否已经带着我们的补丁。
# 两个文件的标记不一样：runtime 里是 __dshBootSplash，main.js 里只有 startBootSplash /
# 那句 import —— 早先版本只看 __dshBootSplash，结果把已打补丁的 main.js 当成干净原文件
# 备份了下来，-Revert 就会还原出一个带补丁的文件。别再退回那种写法。
function Test-Patched([string]$Path) {
	$text = Read-Text $Path
	if ($text.Contains($Marker)) { return $true }
	return $text.Contains("startBootSplash") -or $text.Contains("dsh-boot-splash.js")
}

# 自动探测 DSH Desktop 安装目录。
# 这份脚本会被拷到别的电脑上跑，那里的安装路径几乎肯定不是开发机上的那个，
# 所以不能写死默认值 —— 依次看：显式环境变量 → 上次记录 → 常见安装位置。
function Find-AppDir {
	$candidates = @()
	if ($env:DSH_DESKTOP_APP) { $candidates += $env:DSH_DESKTOP_APP }
	$status = Join-Path (Join-Path $env:USERPROFILE ".dsh") "boot-animation\patch-status.json"
	if (Test-Path -LiteralPath $status) {
		try {
			$recorded = (Read-Text $status | ConvertFrom-Json).appDir
			if ($recorded) { $candidates += $recorded }
		} catch {
			# 记录坏了就跳过。
		}
	}
	if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Programs\DSH Desktop") }
	if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "DSH Desktop") }
	if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "DSH Desktop") }
	$candidates += (Join-Path $env:USERPROFILE "DSH Desktop")
	foreach ($candidate in $candidates) {
		if (-not $candidate) { continue }
		# 候选可能是安装根目录（…\DSH Desktop），也可能本身就是 app 目录
		# （…\resources\app —— patch-status.json 记的就是后者），两种都要认，
		# 否则会在记录后面再拼一次 resources\app，拼出一个不存在的路径。
		foreach ($lib in @((Join-Path (Join-Path $candidate "resources") "app\lib"), (Join-Path $candidate "lib"))) {
			if (Test-Path -LiteralPath (Join-Path $lib "main.js")) {
				# 本脚本里 $AppDir 是**安装根目录**的语义（后面还会再拼 resources\app\lib），
				# 所以从 app 目录逐级退回根目录，别把 app 目录当根目录交出去。
				$appDir = Split-Path $lib -Parent
				return (Split-Path (Split-Path $appDir -Parent) -Parent)
			}
		}
	}
	return $null
}

# ---------------------------------------------------------------- 定位安装目录
if (-not $AppDir) {
	$AppDir = Find-AppDir
	if (-not $AppDir) {
		Write-Fail @"
没找到 DSH Desktop 的安装目录。已尝试：
  %DSH_DESKTOP_APP% / 上次记录 / %LOCALAPPDATA%\Programs\DSH Desktop / %ProgramFiles%\DSH Desktop / 用户目录\DSH Desktop
请用 -AppDir 明确指定，例如：
  pwsh -File install.ps1 -AppDir "C:\Users\你的用户名\AppData\Local\Programs\DSH Desktop"
"@
	}
	Write-Info "自动探测到 DSH Desktop: $AppDir"
}
$AppLib = Join-Path (Join-Path $AppDir "resources") "app\lib"
if (-not (Test-Path -LiteralPath $AppLib)) {
	Write-Fail "找不到 $AppLib —— 用 -AppDir 指定安装目录"
}
$MainJs = Join-Path $AppLib "main.js"
if (-not (Test-Path -LiteralPath $MainJs)) { Write-Fail "找不到 $MainJs" }
$RuntimeFile = Get-ChildItem -LiteralPath $AppLib -Filter "electron-runtime-*.js" -File | Select-Object -First 1
if ($null -eq $RuntimeFile) { Write-Fail "找不到 electron-runtime-*.js" }
$RuntimeJs = $RuntimeFile.FullName
$AppVersion = (Read-Text (Join-Path (Join-Path $AppDir "resources") "app\package.json") | ConvertFrom-Json).version

# ---------------------------------------------------------------------- 还原
if ($Revert) {
	Write-Info "还原 DSH Desktop 补丁（$AppDir）"
	$restored = 0
	Get-ChildItem -LiteralPath $AppLib -Filter "*$Suffix" -File | ForEach-Object {
		$original = $_.FullName.Substring(0, $_.FullName.Length - $Suffix.Length)
		if (Test-Path -LiteralPath $original) {
			Copy-Item -LiteralPath $_.FullName -Destination $original -Force
			Remove-Item -LiteralPath $_.FullName -Force
			if (Test-Patched $original) {
				Write-Host "  警告: $(Split-Path $original -Leaf) 还原后仍带补丁痕迹 —— 备份当初被污染了，建议重装 DSH Desktop 取回原文件" -ForegroundColor Yellow
			} else {
				Write-Step ("恢复 " + (Split-Path $original -Leaf))
			}
			$restored += 1
		} else {
			Remove-Item -LiteralPath $_.FullName -Force
			Write-Step ("丢弃过期备份 " + $_.Name)
		}
	}
	foreach ($name in ($PayloadFiles + $StateFile)) {
		$path = Join-Path $AppLib $name
		if (Test-Path -LiteralPath $path) {
			Remove-Item -LiteralPath $path -Force
			Write-Step "删除 $name"
			$restored += 1
		}
	}
	# 计划任务也一并撤掉，别留着每次登录偷偷改文件
	$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
	if ($null -ne $existing) {
		Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
		Write-Step "移除计划任务 $TaskName"
		$restored += 1
	}
	if ($restored -eq 0) { Write-Step "没有发现补丁痕迹，本来就是干净的" }
	Write-Info "完成。重启 DSH Desktop 生效。"
	exit 0
}

# ---------------------------------------------------------------------- 安装
Write-Info "安装开机动画 -> $AppDir (app $AppVersion)"
if (-not (Test-Path -LiteralPath $PayloadDir)) { Write-Fail "找不到 assets 目录：$PayloadDir" }

# 备份：只在当前文件是干净原文件时刷新，且绝不把带补丁的内容写进备份。
function Backup-Original([string]$Path) {
	$name = [System.IO.Path]::GetFileName($Path)
	$backup = "$Path$Suffix"
	$backupExists = Test-Path -LiteralPath $backup
	if (Test-Patched $Path) {
		if (-not $backupExists) {
			Write-Host "  警告: $name 已是打过补丁的状态，但没有备份，-Revert 将无法还原该文件" -ForegroundColor Yellow
		} elseif (-not (Test-Patched $backup)) {
			Write-Step "保留已有干净备份 $name$Suffix"
		} else {
			Write-Host "  警告: $name 的备份里也是打过补丁的内容，-Revert 无法还原它（可重装 DSH Desktop 取回原文件）" -ForegroundColor Yellow
		}
		return
	}
	if (-not $backupExists) {
		Copy-Item -LiteralPath $Path -Destination $backup -Force
		Write-Step "备份 $name -> $name$Suffix"
		return
	}
	if (Test-Patched $backup) {
		Copy-Item -LiteralPath $Path -Destination $backup -Force
		Write-Step "备份曾被污染，已用当前干净文件重建 $name$Suffix"
		return
	}
	# 两边都干净：内容不同说明应用刚更新过，把备份刷新成新版本的原始文件。
	$same = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash
	if (-not $same) {
		Copy-Item -LiteralPath $Path -Destination $backup -Force
		Write-Step "检测到应用已更新，刷新备份 $name$Suffix"
	}
}

try {
	Backup-Original $MainJs
	Backup-Original $RuntimeJs
} catch {
	Write-Fail "备份失败（DSH Desktop 可能正在运行并占用了文件）: $($_.Exception.Message)"
}

# 1) 复制负载
foreach ($name in $PayloadFiles) {
	$source = Join-Path $PayloadDir $name
	if (-not (Test-Path -LiteralPath $source)) { Write-Fail "缺少负载文件 $source" }
	Copy-Item -LiteralPath $source -Destination (Join-Path $AppLib $name) -Force
	Write-Step "写入 $name"
}

# 2) main.js：import + 在 whenReady 之后启动
$main = Read-Text $MainJs
$mainNewline = Get-Newline $main
$mainChanged = $false

if (-not $main.Contains('dsh-boot-splash.js')) {
	$at = $main.IndexOf($ElectronImport)
	if ($at -lt 0) { Write-Fail "main.js 里找不到 electron 的 import 行，版本可能变了" }
	$insert = $ElectronImport + $mainNewline + 'import { startBootSplash } from "./dsh-boot-splash.js";'
	$main = $main.Remove($at, $ElectronImport.Length).Insert($at, $insert)
	$mainChanged = $true
	Write-Step "main.js: 注入 import"
}

if (-not $main.Contains("startBootSplash();")) {
	$needle = "await app.whenReady();"
	$target = 'startupStage = "shell-environment";'
	$cursor = 0
	$at = -1
	while ($true) {
		$found = $main.IndexOf($needle, $cursor)
		if ($found -lt 0) { break }
		$tail = $main.Substring($found + $needle.Length)
		$ws = [regex]::Match($tail, '^\s*').Value
		if ($tail.Substring($ws.Length).StartsWith($target)) { $at = $found + $needle.Length; break }
		$cursor = $found + $needle.Length
	}
	if ($at -lt 0) { Write-Fail "main.js 里找不到主启动路径的 app.whenReady()（版本可能变了）" }
	$main = $main.Insert($at, $mainNewline + "`t`tstartBootSplash();")
	$mainChanged = $true
	Write-Step "main.js: 在 app.whenReady() 之后启动启动窗"
}

if ($mainChanged) {
	Write-Text $MainJs $main
	if (-not (Test-Syntax $MainJs)) {
		Restore-Backup $MainJs
		Write-Fail "main.js 打完补丁语法不通过，已回滚"
	}
	Write-Step "main.js 语法检查通过"
} else {
	Write-Step "main.js: 已是打过补丁的状态，跳过"
}

# 3) electron-runtime：拦住第一次 revealApplication
$runtime = Read-Text $RuntimeJs
if ($runtime.Contains($Marker)) {
	Write-Step ((Split-Path $RuntimeJs -Leaf) + ": 已拦截过，跳过")
} else {
	$runtimeNewline = Get-Newline $runtime
	$fn = "function revealApplication(window, platform = process.platform) {"
	if (-not $runtime.Contains($fn)) { Write-Fail "electron-runtime 里找不到 revealApplication（版本可能变了）" }
	$hold = "`tif (globalThis.${Marker}?.hold?.(window) === true) return;"
	$runtime = $runtime.Replace($fn, $fn + $runtimeNewline + $hold)
	Write-Text $RuntimeJs $runtime
	if (-not (Test-Syntax $RuntimeJs)) {
		Restore-Backup $RuntimeJs
		Write-Fail "electron-runtime 打完补丁语法不通过，已回滚"
	}
	Write-Step ((Split-Path $RuntimeJs -Leaf) + ": 已插入首次显示拦截")
}

# 4) 首次安装写一份默认配置，方便直接改
$ConfigDir = Join-Path (Join-Path $env:USERPROFILE ".dsh") "boot-animation"
$ConfigPath = Join-Path $ConfigDir "splash.json"
if (-not (Test-Path -LiteralPath $ConfigPath)) {
	New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
	$default = [ordered]@{
		enabled = $true
		maxMs = 15000
		fit = "cover"
		skippable = $true
		clip = $null
	} | ConvertTo-Json
	Write-Text $ConfigPath $default
	Write-Step "写入默认配置 $ConfigPath"
} else {
	Write-Step "配置已存在，保留：$ConfigPath"
}

# 5) -BakeClip：把当前片源另存成 ~/.dsh/boot-animation/intro.mp4
#    内置的四段片头是以 base64 存在 dsh-boot-animation 插件的 lib/clips.data.js 里的，
#    所以「用内置片段」这件事其实依赖那个插件还在。烘焙一份自己的副本之后，即使以后
#    卸载插件，开机动画也依然有片子可放。
#    选 intro.mp4 而不是 splash.json 的 clip，是因为两种解析顺序里它都排在
#    「片库选择」之后 —— 片库仍然说了算，不会因为烘焙被钉死。
if ($BakeClip) {
	$intro = Join-Path $ConfigDir "intro.mp4"
	if ((Test-Path -LiteralPath $intro) -and -not $Force) {
		Write-Host "  跳过烘焙：$intro 已存在（要覆盖加 -Force）" -ForegroundColor Yellow
	} elseif (-not (Test-Node)) {
		Write-Host "  跳过烘焙：需要 node 才能解析当前片源" -ForegroundColor Yellow
	} else {
		$resolverUrl = "file:///" + ((Join-Path $AppLib "dsh-boot-splash-clip.js") -replace '\\', '/')
		$source = & node -e "import(process.argv[1]).then((m) => { const c = m.resolveSplashClip(m.readSplashConfig()); process.stdout.write(c === null ? '' : c.path); }).catch(() => {});" $resolverUrl
		$source = "$source".Trim()
		if ($source -eq "" -or -not (Test-Path -LiteralPath $source)) {
			Write-Host "  跳过烘焙：解析不出可用片源（插件已卸载且没有自己的视频？）" -ForegroundColor Yellow
		} else {
			Copy-Item -LiteralPath $source -Destination $intro -Force
			Write-Step ("已烘焙片源 -> " + $intro + " (" + (Get-Item -LiteralPath $intro).Length + " bytes)")
		}
	}
}

# 6) -AutoRepair：注册登录时自动修复的计划任务
#    这是「应用更新后补丁失效」的兜底方案（插件路线本身已经能自愈，两者不冲突）。
#    任务以当前用户身份运行，登录后 30 秒触发一次，执行本脚本的幂等安装。
if ($AutoRepair) {
	$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -AppDir `"$AppDir`" -Quiet"
	$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
	$trigger.Delay = "PT30S"
	$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
	try {
		Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "DSH Desktop 开机动画：应用更新后自动补回补丁" -Force | Out-Null
		Write-Step "已注册计划任务 $TaskName（登录后 30 秒自动补一次）"
	} catch {
		Write-Host "  注册计划任务失败：$($_.Exception.Message)" -ForegroundColor Yellow
		Write-Host "  （不影响本次安装；想手动加就再以管理员身份跑一次 -AutoRepair）" -ForegroundColor Yellow
	}
}

# 7) 记录状态
$state = [ordered]@{
	appVersion = $AppVersion
	patchedAt = (Get-Date).ToString("s")
	mainJs = "main.js"
	runtimeJs = (Split-Path $RuntimeJs -Leaf)
	payload = $PayloadFiles
	autoRepair = [bool]$AutoRepair
	# script = 由本脚本管理：负载看到这个值就永不自清理，还原由 -Revert 负责
	managedBy = "script"
} | ConvertTo-Json -Depth 4
Write-Text (Join-Path $AppLib $StateFile) $state

if (-not (Test-Node)) {
	Write-Host "  提示: 没找到 node，跳过了补丁后的语法校验" -ForegroundColor Yellow
}
Write-Info "完成。请完全退出并重新打开 DSH Desktop 才能看到动画。"
Write-Info "回滚: pwsh -File `"$PSCommandPath`" -Revert"
