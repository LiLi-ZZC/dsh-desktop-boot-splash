# dsh-desktop-boot-splash

给 **DSH Desktop** 加一段真正的开机动画：启动软件时先播放片头，播完（或你点一下跳过）才出现主界面。
它以 **DSH 插件**的形式分发，负责把补丁打到 Electron 壳上，并在**应用更新后自动补回**。

> **平台：仅 Windows。** 只在 Windows 上开发与实测过；非 Windows 未支持、未验证（原因见[兼容性](#兼容性)）。

- 想直接装：看 [安装](#安装)
- 想换片子：看 [片源](#片源)
- 更新后会不会失效：看 [为什么应用更新后还能用](#为什么应用更新后还能用)
- 出问题了：看 [排错](#排错)

---

## 效果

- 启动 DSH Desktop 立刻出现一个**无边框、与主窗口同尺寸同位置**的窗口开始播片头 —— 这段正好盖住原本"什么都不显示"的启动等待。
- 片头播完 → 主窗口淡入。
- **点击画面 / Esc / 空格 / 回车** 立即跳过。
- 视频出错、加载失败、解码卡住、超过 `maxMs` → 立刻放行，绝不把你关在动画外面。
- 每次启动都播。

默认动画是插件自带的片头：3840×2160 / 7.1 秒 / 31.0 MB，H.264 + AAC，faststart。想换成自己的片子见[片源](#片源)。

---

## 它为什么必须打补丁

DSH 的插件运行在 `utilityProcess` 子进程和网页里；等它们拿到窗口时，主窗口**已经显示出来了**。
而「软件还没进来就先播动画」只能由 **Electron 主进程**在显示主窗口之前开一个窗口来做。

所以本项目做两件事：

1. 往 `resources\app\lib\` 里放 4 个负载文件（启动窗本体、播放页、片源解析、自带片头）；
2. 在桌面壳源码里插两行：
   - `lib/main.js`：`await app.whenReady()` 之后调用 `startBootSplash()`
   - `lib/electron-runtime-*.js`：`revealApplication()` 开头拦一次，把主窗口首次显示推迟到动画结束

插入点全部基于官方源码里的锚点。**锚点对不上（比如以后版本改了结构）就拒绝动手**，只记一条状态，不会把软件改坏。

---

## 安装

> **平台：仅 Windows。** 本插件只在 Windows 上开发与实测过，非 Windows 请不要使用：
>
> - 安装脚本本身就是 Windows 专用（`install.ps1` / `安装插件.cmd`）。
> - 补丁按 Electron 的 `resources\app` 布局实现；macOS 的 `.app/Contents/Resources/app` 没测过，
>   而且**改写 `.app` 包内文件会破坏应用代码签名**，即使锚点匹配也不该这么做。
> - Linux 未测试。
>
> （DSH Desktop 的壳代码里确实有 macOS/Linux 分支，但那是上游的事；本插件不对它们做任何承诺。
> 细节见[兼容性](#兼容性)。）

### 路线一：从 GitHub 装（推荐：最省事，且不依赖本机任何文件夹）

**前提：目标电脑上要先装好 DSH Desktop 并至少启动过一次** —— 插件装在 DSH 的 profile 里，
而 profile 是应用首次启动时创建的；`dsh` 命令也由它生成。

```powershell
# dsh 命令随 DSH Desktop 分发，路径里带一个会变的 generation 目录，通常不在 PATH 里
$dsh = (Get-ChildItem "$env:APPDATA\DSH Desktop\host-commands\desktop\generations" -Recurse -Filter dsh.cmd |
        Sort-Object LastWriteTime -Descending)[0].FullName

& $dsh plugin --profile desktop add "github:LiLi-ZZC/dsh-desktop-boot-splash"
```

> 如果你在 DSH 会话里（或 `dsh` 已在 PATH 上），第 1 步可以省略，直接
> `dsh plugin --profile desktop add github:LiLi-ZZC/dsh-desktop-boot-splash`。
>
> 发布到 npm 之后也可以：`dsh plugin --profile desktop add dsh-desktop-boot-splash`。
>
> **要不要带 tag？**
>
> - **不带 tag**（上面这条默认写法）= 跟随仓库默认分支的最新提交 → 现在装到的是 **1.2.0**；
>   以后推了新版本，别人**新装**会直接拿到新版。
> - **带 tag**（如 `#v1.2.0`）= 固定那一版，适合"发给别人装"或需要可复现的场景。
>   历史上出现过的 tag 只有 `v1.0.0` 与 `v1.2.0`（见[仓库历史](#仓库历史为什么只有两个-tag)）。
> - 注意：**已经装过的那份不会自动更新** —— 同一个 spec 再执行 `add` 只会报 "Already up to date"，
>   更新必须 `remove` 再 `add`。

**这条路的好处**：依赖在 profile 里记的是 `git+https://…#<commit>`，跟本地文件夹毫无关系 ——
装完本机不需要留任何副本，删掉也不会有后患（对比 `file:` 方式，源目录一消失后续
`pnpm install` 就会报 `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`）。

### 路线二：把文件夹拷过去装（离线 / 内网环境）

把整个 `dsh-desktop-boot-splash` 文件夹拷到目标电脑，然后**双击 `安装插件.cmd`**
（它会自动找到 `dsh`、装进 desktop profile、并打印后续步骤）。

> 等价的手工命令：
>
> ```powershell
> & $dsh plugin --profile desktop add "file:C:\你存放的路径\dsh-desktop-boot-splash"
> ```
>
> ⚠️ 用 `file:` 装的话，**那份文件夹之后别删/别移走**：profile 的 `package.json` 与
> `pnpm-lock.yaml` 记着这个路径，以后任何触发 `pnpm install` 的操作（装/卸别的插件、
> 应用更新后的 profile 迁移）都会因为它不存在而失败。已经删了的话，先
> `dsh plugin --profile desktop remove dsh-desktop-boot-splash` 清掉依赖即可恢复。
>
> 卸掉插件：双击 `卸载插件.cmd`。

然后**完全退出并重新打开 DSH Desktop**。插件在启动约 1.5 秒后自动打补丁，所以：

- 装完第一次重启：补丁是在这次启动期间打上的，**这次可能还没有动画**；
- **再重启一次**，动画就出现了，之后一直有。

装好之后什么都不用管：每次启动插件都会自检，更新把补丁冲掉也会自动补回。
**默认播的是插件自带的片头**（见[片源](#片源)），你随时可以换掉。

### 路线三：只跑脚本（不装插件）

```powershell
pwsh -File install.ps1                    # 安装 / 重新安装（幂等）
pwsh -File install.ps1 -AutoRepair        # 额外注册"登录时自动修复"的计划任务
pwsh -File install.ps1 -Revert            # 还原成官方原样（并移除计划任务）
pwsh -File install.ps1 -BakeClip          # 把当前片源另存一份，摆脱对 dsh-boot-animation 的依赖
pwsh -File install.ps1 -AppDir "D:\DSH Desktop"   # 装在别处时指定
```

**不用管安装路径**：不传 `-AppDir` 时脚本会自己找（依次看 `%DSH_DESKTOP_APP%` → 上次记录 →
`%LOCALAPPDATA%\Programs\DSH Desktop` → `%ProgramFiles%\DSH Desktop` → 用户目录）。

不装插件、也不加计划任务的话，**应用每次更新都要手动重跑一次 `install.ps1`**。

### 三条路线可以混用

补丁是幂等的，插件和计划任务不会打架。推荐组合：**装插件**（主力自愈）+ 需要时加 `-AutoRepair`（多一层保险）。

---

## 发布与分发（维护者）

本目录**就是** npm 包的根目录，直接把它的内容作为仓库根推上去即可，不需要 `#path:`。

```powershell
cd dsh-desktop-boot-splash
git init -b main
git add -A
git commit -m "dsh-desktop-boot-splash 1.0.0：DSH Desktop 开机动画插件"
git tag v1.0.0
# 在 GitHub 建一个空仓库（不要勾选 README/.gitignore），然后：
git remote add origin https://github.com/LiLi-ZZC/dsh-desktop-boot-splash.git
git push -u origin main --tags
```

发布前把 `LiLi-ZZC` 全部替换成你的 GitHub 用户名（README、快速开始、`package.json`、
`LICENSE` 里都有）。

几条经验：

- **打 tag**，让安装方写 `github:用户名/仓库#v1.0.0`。不带 tag 时 pnpm 会把解析到的 commit 记进
  lockfile，**同一个 spec 再装不会跟进新提交**（实测会直接 `Already up to date`）。
- **改了内容要让别人重新装一次**才会生效（先 `remove` 再 `add`）。`安装插件.cmd` 已经内置这个逻辑，
  手工命令的话记得先 remove。
- 仓库结构：`package.json` 必须在**仓库根**。如果哪天把它挪进子目录，安装方就得写
  `github:用户名/仓库#path:/子目录`（DSH profile 里那几个皮肤依赖就是这么写的）。
- 别让 `.gitignore` 过滤掉 `assets/dsh-boot-splash-default.mp4` —— 那 1.4 MB 是插件自带的默认片头。
- 发布到 npm 更规范：`npm publish` 之后安装方直接 `dsh plugin add dsh-desktop-boot-splash`。
  `package.json` 的 `files` 已经把该带的都列上了（`lib`、`assets`、补丁清单、三个安装脚本与文档）。

---

## 为什么应用更新后还能用

DSH Desktop 更新会**整体替换 `resources\app`**，所以任何打在它里面的补丁都会消失 —— 这是物理事实，
没办法让补丁"免疫"更新。能做的是**更新后自动补回来**：

| 自动化 | 机制 | 更新后表现 | 需要什么 |
|---|---|---|---|
| **插件自愈**（推荐） | profile 在 `~/.dsh/profiles/...`，**更新不碰它**；插件每次启动自检，发现补丁缺失就补回 | 更新后第一次启动没有动画，**第二次起恢复** | 装插件 |
| **计划任务**（可选） | 登录 30 秒后触发一次幂等的 `install.ps1 -Quiet` | 同上（更新后第一次启动可能错过，登录后 30 秒内补回） | `-AutoRepair`（可能需要管理员权限） |

两者都是"补一次"，不是常驻进程；补完在下次启动生效。

手工检查当前状态（两条路线通用）：

```powershell
node lib/cli.js status
```

---

## 配置

`~/.dsh/boot-animation/splash.json`（首次安装自动写入）：

```json
{
  "enabled": true,       // false = 不播开机动画
  "maxMs": 15000,        // 最长等待，超时立刻进软件（1000–120000）
  "fit": "cover",        // cover = 填满窗口裁掉多余；contain = 完整显示，可能留黑边
  "skippable": true,     // false = 只能等它播完
  "clip": null,          // 指定片源：绝对路径，或 "builtin:<名字>"
  "rememberWindowState": true,  // 记住上次是不是最大化/全屏（见下）
  "restoreFullScreen": false,   // 是否原样恢复"真全屏"（默认 false，见下）
  "overscan": 8                 // 启动窗向外多出多少，用来盖掉 Windows 11 的窗口边框/圆角
}
```

配置**每次启动时读取**，改完下次启动生效，不用重打补丁。
（文件带不带 UTF-8 BOM 都能读 —— 用记事本改过也没关系。）

### 记住窗口的最大化 / 全屏状态

DSH Desktop 自己只持久化窗口的**还原尺寸**（`main-window-state.json` 里只有 x/y/宽/高），
**不记最大化/全屏**——所以你最大化之后关掉软件，下次打开会退回小窗。

`rememberWindowState`（默认 `true`）由本插件补上这个能力：把上次是不是最大化/全屏记到
`~/.dsh/boot-animation/window-state.json`，下次启动时**在显示主窗口之前**恢复（所以不会先闪
一下小窗再弹大）。改为 `false` 可关闭。

> 实现上是**订阅窗口事件**（`maximize`/`unmaximize`/`enter-full-screen`/`leave-full-screen`/`close`）
> 而不是退出钩子：桌面壳有些退出路径走 `app.exit()`，`before-quit` 不一定触发，事件则一定会。
>
> 这个能力**不依赖启动窗**：把 `enabled` 设为 `false` 也照样生效。恢复的时机是桌面壳
> 调用 `revealApplication()` 的那一刻（正好在窗口 `show()` 之前），所以不会先闪一下小窗。
>
> **慢机器上的"晚到的 reveal"**：宿主启动可能比片头更久（实测有 host-boot 9.4 秒、主窗口
> 11.7 秒才 reveal 的）。这时启动窗早就自然播完了，恢复动作只能等窗口 `show()` 之后补上 ——
> 可能出现**一瞬未最大化**再变最大化。记录侧不受影响（`window-state.json` 照常写）；
> 诊断文件里的 `windowStateRegisteredAfterFinish: true` 就表示这次走的是这条路径。
>
> ⚠️ v1.2.0 及更早的版本在这里有个真实 bug：`hold()` 开头的 `state.finished` 提前返回排在窗口
> 状态逻辑**之前**，于是"晚到的 reveal"会让**记录与恢复两侧一起失效**（表现为这个功能完全不存在）。
> v1.2.1 已修，并加了行为级回归测试（`test-resolve.mjs` 里把 `hold()` 抽出来用 mock 跑）。

#### 全屏默认不原样恢复（会退化成最大化）

`restoreFullScreen` 默认 `false`。原因是**这个壳在 Windows 上没有退出全屏的入口**：菜单里的
`togglefullscreen` role 没有加速键，而主窗口是无边框自绘标题栏 —— 一旦进入全屏，窗口按钮和
菜单都消失，用户就被困在里面了。所以默认行为是"上次全屏 → 这次最大化"，仍然可以退出；
确实想原样恢复真全屏时再把它设为 `true`。

> 另外，只要窗口进入全屏，插件会给它挂一个 **F11 切换**（`before-input-event`），
> 作为一个兜底的退出方式 —— 壳本身没提供。

#### 为什么不能在"窗口还没显示"时改窗口状态

`maximize()` 和 `setFullScreen(true)` 在隐藏窗口上调用，Windows 会把主窗口**直接显示出来**。
后果不只是"被盖住"：Chromium 会**降低被遮挡窗口的媒体优先级**，视频 `timeupdate` 随之停摆，
启动窗页面的停滞看门狗（4 秒）随后报 `stalled-playback` 收尾 —— 于是表现为"动画只播几秒就进软件"。

所以恢复动作一律推迟到"即将 `show()` 的同一拍"（`applyPendingWindowState`），
`hold()` 里只登记意图、绝不碰窗口。`test-resolve.mjs` 里有源码级不变量检查，防止这个坑再次回归。

`last-splash.json` 里的 `mainWindowShownBeforeFinish` 就是这件事的探针：它一旦为 `true`，
说明收尾之前主窗口已经自己露过脸了。

### 启动窗的尺寸 / 层级跟着窗口状态走

启动窗不是简单地套用 `main-window-state.json` 里的还原尺寸 —— 那样在"上次是最大化/全屏"时，
动画只会出现在屏幕中间一块。实际规则：

| 上次的状态 | 启动窗尺寸 | 置顶 |
|---|---|---|
| 全屏 | **整屏**（含任务栏区域）四面再向外多 `overscan` | 是 |
| 最大化 | **显示器工作区**再向外多 `overscan`（默认 8） | 否 |
| 普通窗口 | **原样跟随主窗口**（哪怕有一部分在屏幕外也对齐） | 否 |
| 窗口几乎整个在屏幕外 | 夹回工作区，保证动画还看得见 | 否 |
| 没有记录 | 工作区内居中 1280×720 | 否 |

两点容易踩的坑：

- **尺寸要跟随，而不是夹进屏幕**。把窗口拖到偏下、有一部分在屏幕外时，如果启动窗被"夹"回来，
  它就和主窗口错位了 —— 看起来像"动画不跟随窗口"。
- **除全屏外不要置顶**。`alwaysOnTop` 的窗口会压过任务栏；普通窗口压在任务栏区域时任务栏本来就在
  上面（主窗口就是这个行为），所以只要不置顶，连 1px 的边框重叠都不会盖住任务栏。

尺寸按 Electron 的 DIP 计算（125% 缩放的 2560×1440 屏 → 工作区 2048×1104），和主窗口一致。

#### 为什么要 `overscan`

Windows 11 会给窗口画一条 DWM 亮边框并加圆角。启动窗如果**正好**卡在工作区边界上，这两样就会露出来：
屏幕最上面一条亮线、左上角漏出后面的桌面。实测最大化窗口的边框在 125% 缩放下每边 7 px
（`SM_CXSIZEFRAME + SM_CXPADDEDBORDER` = 8），所以默认让启动窗向外多出 8：

- **最大化**：上/左/右各多 8，下边也多 8 —— 下面的 8 px 会盖到任务栏顶部，但启动窗是
  **非置顶**的，任务栏（topmost）仍然画在最上层，所以看不出来，同时把底部的边框线也藏掉了。
- **全屏**：四面各多 8（全屏本来就该盖住任务栏）。
- **普通窗口**：不加 —— 必须原样跟随主窗口，圆角和主窗口自己的圆角重合，反而自然。

另外还会尝试 `setRoundedCorners(false)` 直接关掉 Windows 11 的圆角（老版本 Electron 没这个 API，
靠 `overscan` 也能达到同样效果）。`overscan: 0` 可恢复旧行为。
每次启动还会把实际用的几何落一份到 `~/.dsh/boot-animation/last-splash.json`（含窗口状态、
工作区/整屏、`scaleFactor`、结束原因），排查"动画位置不对"时先看它 —— 主进程的 `console`
输出不一定会进桌面壳的日志文件。

---

## 片源

按顺序找，用第一个能用的：

| 顺序 | 来源 |
|---|---|
| 1 | `splash.json` 的 `clip`（绝对路径或 `builtin:<名字>`） |
| 2 | `selection.json` 里片库选中的那一条（内置片段，或你自己加的视频） |
| 3 | 环境变量 `DSH_BOOT_ANIMATION` 指向的文件 |
| 4 | `~/.dsh/boot-animation/intro.mp4` |
| 5 | `~/.dsh/boot-animation/videos/` 里最新修改的视频 |
| 6 | **本插件自带的默认片头**（`assets/dsh-boot-splash-default.mp4`） |
| 7 | `dsh-boot-animation` 插件的内置 `brand` 片段（最后的兜底） |

1–5 是"你显式选的东西"，6 是本插件的默认值，7 是另一个插件的隐式兜底。
**注意 6 排在 7 前面**：`dsh-boot-animation` 在"用户没选过任何片"时会用 `brand`，
那是它自己的默认，不该盖掉本插件的默认 —— 所以装了本插件之后开箱播的**就是插件自带的那段片头**。
你在片库/配置里显式选过的仍然优先。

### 放自己的视频

```
C:\Users\<你>\.dsh\boot-animation\videos\
```

丢进去之后：装了 `dsh-boot-animation` 可以在它的片库面板点「刷新」并选中；没装的话规则 5 会直接取
这个目录里**最新修改**的那个。想精确指定：

```jsonc
// ~/.dsh/boot-animation/splash.json
{ "clip": "C:\\我的\\片头.mp4" }
```

或者覆盖 `~/.dsh/boot-animation/intro.mp4`（规则 4，优先于 `videos/` 里其它文件）。

### 支持什么格式

`.mp4 .m4v .webm .mov .mkv` —— 但**能不能播取决于浏览器解码**。H.264 + AAC 的 mp4 最稳；
HEVC(H.265)、ProRes、部分 mkv 大概率只有声或黑屏。

务必是 **faststart**（`moov` 在文件头），否则浏览器要整段下完才出画面，叠加 15 秒看门狗就是"点开黑屏"：

```bash
ffmpeg -i 原片.mp4 -c copy -movflags +faststart 修好的.mp4
```

### 插件自带的默认片头

插件包里带了一段片头 `assets/dsh-boot-splash-default.mp4`
（3840×2160 / 7.1 秒 / 31.0 MB，H.264 + AAC，faststart；sha256 以 `c02a8af8b42e9888` 开头），
安装时一并部署到 `resources\app\lib\`，它就是**本插件的默认片源**。

它解决两件事：

1. **换电脑开箱有动画**：`dsh-boot-animation` 的"内置四段"属于那个插件，新电脑没装就没有；
2. **默认值不被别人改掉**：那个插件在"用户没选过任何片"时会退回它自己的 `brand`。本插件的
   默认片头排在它前面，所以装完本插件、你什么都没配时，播的就是它。

你在片库面板、`splash.json`、`intro.mp4`、`videos\` 里的任何显式选择**都优先于它**。

想换掉这个默认值：用别的 mp4 覆盖 `assets/dsh-boot-splash-default.mp4`，再跑一次
`node lib/cli.js patch`（插件路线还要按[开发](#开发)那节刷新 profile 副本）。

---

## 命令行

不装插件也能用同一套逻辑（需要 Node 20+；插件场景下 `lib/` 就在 profile 的 `node_modules` 里）：

```bash
node lib/cli.js status              # 补丁在不在、应用版本、生效片源、配置
node lib/cli.js patch               # 打补丁（幂等）
node lib/cli.js revert              # 还原成官方原样
node lib/cli.js patch --app "D:\DSH Desktop"    # 指定安装目录
```

`status` 输出示例：

```
DSH Desktop : C:\Users\<你>\AppData\Local\Programs\DSH Desktop\resources\app
应用版本    : 2.0.15
补丁 main.js : 已就位
补丁 runtime : 已就位
负载文件    : 4 个齐全
上次检查    : 2026-09-27T18:29:50.646Z（ok=true）
生效片源    : intro.mp4  ->  C:\Users\<你>\.dsh\boot-animation\intro.mp4
配置        : { "enabled": true, "maxMs": 15000, ... }
```

---

## 排错

| 现象 | 处理 |
|---|---|
| 最大化后下次打开变小窗 | 确认 `splash.json` 的 `rememberWindowState` 不是 `false`；看 `last-splash.json` 里的 `windowStateRegisteredAt` / `restoredWindowState`；删除 `~/.dsh/boot-animation/window-state.json` 可重置记忆 |
| 完全没动画 | 1) 确认真的完全退出并重启过；2) `node lib/cli.js status` 看补丁是否"已就位"；3) 看 `splash.json` 的 `enabled`；4) 看日志里有没有 `dsh-boot-splash:` |
| 播完卡住、要等十几秒才进软件 | 页面回话通道断了。日志搜 `finish (`，正常应出现 `finish (title:done:ended)`；只有 `finish (timeout)` 说明回话没到 |
| 弹「获取打开此链接的应用」 | 页面在用导航回话（旧版本 bug）。重跑 `install.ps1` / `cli.js patch` 更新负载 |
| 黑屏一会儿才进软件 | 片源没做 faststart，用上面的 ffmpeg 命令重排 |
| 只有声音没画面 | 编码浏览器不支持，换 H.264 + AAC 的 mp4 |
| 动画被裁掉字幕/水印 | 把 `fit` 改成 `contain` |
| 启动变慢 | 把 `maxMs` 调小，或 `enabled: false` |
| 应用更新后没动画了 | 正常现象，见[上一节](#为什么应用更新后还能用)；手动补一次：`node lib/cli.js patch` |
| 桌面壳版本不认识（锚点缺失） | `patch-status.json` 里会记 `桌面壳版本可能变了`；需要更新本插件以适配新结构 |
| `patch-status.json` 说"没有定位到 resources/app" | 该版本可能改成了 `app.asar` 打包。本方案只支持**解包**布局（当前版本就是解包的）；遇到 asar 时补丁器会明确报错、不会乱改 |
| 软件起不来 | `install.ps1 -Revert` 或 `node lib/cli.js revert` 还原（备份就在 `resources\app\lib\*.dsh-boot-splash.bak`） |

**日志与状态**

- 桌面壳日志：`%APPDATA%\DSH Desktop\logs\dsh-<日期>.log`，搜 `dsh-boot-splash:`
- 补丁状态：`~/.dsh/boot-animation/patch-status.json`（每次自检后写入，含 `ok` / `actions` / `errors` / `appDir`）

---

## 卸载

**卸载插件 = 连开机动画一起拿掉。** 三种方式：

| 方式 | 做什么 |
|---|---|
| 插件市场面板里点「卸载」 | 从 profile 移除插件；补丁随之清理（见下） |
| 双击 `卸载插件.cmd` | 移除插件 + **立刻**撤掉补丁，不用等下次启动 |
| `dsh plugin --profile desktop remove dsh-desktop-boot-splash` | 只移除插件；补丁在**下次启动**时由负载自动撤掉 |

清理走**两条路径**，覆盖所有时机：

1. **快速路径**：插件被卸载时（`ctx.effect` 的清理回调）读一眼 profile 的 `package.json`，
   发现依赖没了就把补丁撤掉。正常退出时插件还在，什么也不做。
2. **兜底路径**：万一快速路径没跑到（卸载时应用是关着的、进程被强杀），下次启动时
   **负载自己**会发现"我的插件不在了"，撤掉补丁，**并且这次不播动画**。
   这一步不依赖插件存在，所以不会漏。

> 判断依据是补丁状态文件里的 `managedBy` + `profileDir`：
> - `managedBy: "plugin"` → 插件装的，插件没了就自清理；
> - `managedBy: "script"` → `install.ps1` / 命令行装的，**永远不自动撤**，由 `-Revert` 负责。
>
> 所以用 `install.ps1` 装的人，不会因为卸载插件而意外丢掉动画。

**你自己的片源不会被删。** `~/.dsh/boot-animation/` 里的 `intro.mp4`、`videos\`、`selection.json`
都是你的文件；卸载只清补丁和它自己的状态文件。想连片源一起清掉就手动删那个目录。

想彻底回到官方原样（含计划任务）：

```powershell
pwsh -File install.ps1 -Revert
```

---

## 目录结构

```
dsh-desktop-boot-splash/
├─ 快速开始.md                   一页纸上手（发给别人时先看这个）
├─ README.md                    本文件：完整说明
├─ 安装插件.cmd                 双击即装（内部调用 install-plugin.ps1）
├─ 卸载插件.cmd                 双击卸载
├─ install-plugin.ps1           找 dsh 命令 → 装进 profile（-Remove 卸载，-Profile 换 profile）
├─ package.json                 DSH 插件清单（host 插件，无界面）
├─ cordis.patch.yml             bundle 补丁：把插件挂进 profile
├─ lib/
│  ├─ index.js                  Cordis 插件：启动后自检并打补丁
│  ├─ shell-patch.js            补丁逻辑（纯 Node，插件/命令行/测试共用）
│  └─ cli.js                    命令行：status | patch | revert
├─ assets/                      ← 会被部署进 resources\app\lib\
│  ├─ dsh-boot-splash.js        启动窗本体（Electron 侧）
│  ├─ dsh-boot-splash-clip.js   片源解析（纯 Node）
│  ├─ dsh-boot-splash-orphan.js 孤儿补丁自清理（卸载插件时撤掉补丁）
│  ├─ dsh-boot-splash.html      播放页
│  └─ dsh-boot-splash-default.mp4  自带默认片头（想换就覆盖它）
├─ install.ps1                  Windows 独立安装/还原脚本（含 -AutoRepair，自动探测安装路径）
├─ test-shell-patch.mjs         补丁器沙箱回归测试
├─ test-resolve.mjs             片源解析 + Range 解析自测
├─ test-id-equivalence.mjs      片库 id 规则与 dsh-boot-animation 的一致性
├─ check-video.mjs              体检一个视频能不能当开机动画（编码/时长/faststart）
└─ extract-*.mjs                把当前/内置片源提取成独立 mp4 的小工具
```

---

## 开发

```bash
node test-shell-patch.mjs       # 补丁器：定位、打补丁、幂等、锚点缺失、还原（沙箱，不动真实安装）
node test-resolve.mjs           # 片源解析、Range 解析、配置读取
node test-id-equivalence.mjs    # 片库 id 规则一致性（冻结用例 + 插件在场时实时比对）
```

改完源码后：

```bash
node lib/cli.js patch     # 把新负载部署到真实安装
```

**插件**路线还要刷新 profile 里的副本（`file:` 依赖不会自动跟进源码改动）：

```powershell
& $dsh plugin --profile desktop remove dsh-desktop-boot-splash
& $dsh plugin --profile desktop add "file:<本目录>"
```

### 仓库历史（为什么只有两个 tag）

为了让仓库不被"**每换一次片头就永久多一份**"拖大，本仓库在 v1.2.0 之后做过一次**历史瘦身**：

- 只保留 **v1.0.0**（1.38 MB 片头）与 **v1.2.0**（31 MB 片头）两个 tag、两份片头 blob；
- 中间的开发提交被压成一次提交，28.38 MB 的旧片头 blob 已从历史里移除；
- 因此 **v1.1.x 的 tag 与提交 SHA 都不存在了** —— 用它们安装会失败，请改用 `#v1.2.0` 或更新的 tag。

代价说清楚：**在这次重写之前克隆过的人需要重新 clone**（历史被改写，`git pull` 会冲突）。
以后每次换片头，旧片头都会继续留在历史里；想控制体积就得再做一次同样的操作，
或者干脆换成 1080p/1440p 的规格。

### 改代码时别破坏的设计约束

- **任何异常都只能导致「不播动画、正常进软件」**：补丁器全部包在 try/catch 里，插件绝不影响 DSH 启动。- **负载不全就不打 main.js 的补丁**：那句 `import` 指向的文件不存在时，Electron 主进程会直接起不来。
  宁可没有动画，也不能让软件打不开。
- **先算后写**：补丁内容先在内存里算好，锚点对不上就整体放弃 —— 不写文件、不留备份。
- **备份判据按文件区分**：`main.js` 的补丁痕迹是 `startBootSplash`，`electron-runtime` 的是
  `__dshBootSplash`。只看后者会把已打补丁的 `main.js` 当原文件备份，`revert` 就会还原出带补丁的文件。
- **负载按字节比较**：里面有 mp4 二进制，用 UTF-8 字符串比会把不同字节看成一串替换字符。
- **撤销顺序是硬性的**：先摘 `main.js` 的 import，再摘 `electron-runtime` 的拦截，最后才删负载文件。
  反过来一旦中途失败，就会留下"main.js 还 import 着一个已被删掉的文件"——主进程直接起不来。
- **自清理要保守**：只有 `managedBy === "plugin"` 且状态文件里记下了 `profileDir` 才动手；
  读不出 profile 就当作"插件还在"，宁可留着补丁也不误删。`script` 装的补丁永不自动撤。
- **判据只有一份**：插件侧和负载侧共用 `assets/dsh-boot-splash-orphan.js` 里的 `isPluginInstalled`，
  两边各写一份迟早漂移成"卸载后还留着补丁"这种难查的 bug。
- **打完补丁必须语法校验**，不过就回滚。
- **模块唯一的顶层调用（`registerSchemesAsPrivileged`）要包 try**：它抛异常会让主进程起不来。
- **页面回话不能走导航**：`location.href = "dsh-boot-splash:done"` 会被 Chromium 当成外部协议交给
  操作系统（Windows 弹「获取打开此链接的应用」），主进程收不到任何通知。现在用
  `document.title` + 全局变量双通道轮询。
- **总有 `maxMs` 上限**；视频 error / 加载失败 / 渲染进程崩溃 / 播放卡住都立刻放行。
- **启动窗 bounds 先和真实显示器求交**，落在不存在的屏幕上就改成主屏居中。
- **JSON 读取容忍 UTF-8 BOM**：记事本和 `Set-Content -Encoding UTF8` 都会写 BOM，`JSON.parse` 撞上直接抛异常。
- **`.ps1` 必须带 UTF-8 BOM**：PowerShell 5.1 会把无 BOM 的中文按 ANSI 读，导致整个脚本解析失败。
- **所有路径都从 `dshHome()` 派生**（`$DSH_HOME` → `~/.dsh`）：早先 `bootAnimationDir()` 认 `DSH_HOME`
  而 `pluginRoots()` 硬用 `homedir()`，DSH_HOME 不在默认位置时会出现"片源找得到、插件的内置片段找不到"。
- **默认片源的优先级是刻意的**：插件自带的默认片头要排在 `dsh-boot-animation` 的 `brand` 兜底之前，
  否则用户的"没选过"状态会被另一个插件的默认值接管，装完看不到本插件的默认片。

---

## 兼容性

### 分辨率 / 缩放 / 多显示器：自动适配

代码里**没有任何硬编码的分辨率或缩放比例**，几何全部在运行时从 Electron 的 `screen` API 取，
单位是 DIP（逻辑像素）：

| 机制 | 效果 |
|---|---|
| `screen.getDisplayMatching()` | 动画出现在**主窗口所在那块显示器**上 |
| `workArea` / `bounds` | 1280×720、4K、带鱼屏、任务栏在左/右/竖排都能算对 |
| 显示器自带坐标 | 副屏在主屏左侧（负坐标）也正确 |
| `overscan: 8`（DIP） | 100% 缩放下约等于 DWM 边框宽度，125%/150%/200% 下余量更大 |
| 视频用 `object-fit: cover` | 窗口多大就铺多大，任何宽高比都不留边 |

**未验证的保留意见**：混合 DPI 的多显示器（例如一块 100% + 一块 150%）—— Electron 在这类配置下有
已知的 DIP 坐标换算怪癖，本插件没有在那种配置上实测过。最坏情况是位置略有偏差，不会崩。

### DSH Desktop 版本差异

补丁**锚点匹配**，不锁版本。为了容忍相邻版本，锚点是"宽松"的：

- electron 的 import：只要存在 `import { ... } from "electron";` 就算数（**增删导入不影响**）
- `revealApplication`：认 `function revealApplication(...)` 和类方法两种写法，**参数列表怎么写都行**
- `await app.whenReady();`：优先选后面紧跟 `startupStage` 的那个；找不到就回退到第一个并记日志

版本差异导致的两种结果：

| 情况 | 结果 |
|---|---|
| 锚点都在（大多数相邻版本） | 正常打上补丁 ✓ |
| 锚点变了（结构性改动） | 补丁**整体放弃**并写明原因 —— **没有动画，但软件照常启动** ✓ |

`node test-compat.mjs` 用合成的壳源码专门回归这件事。

### 应用更新之后

桌面壳更新会重写 `resources\app`，补丁和负载都会被清掉。插件（装在 profile 的 `node_modules` 里，
不受更新影响）会在**每次启动时自愈**：

> ⚠️ 补丁是在插件加载时补回的，而那时 Electron 主进程已经启动完毕 —— 所以**更新后的第一次启动通常
> 没有动画，第二次启动才有**。这不是故障，等一次重启即可。

### 其他

- **仅 Windows（本插件唯一支持并实测过的平台）**：
  - 安装脚本是 PowerShell / `安装插件.cmd`（Windows 专用）；
  - 补丁按 Electron 的 `resources\app` 布局实现，macOS 的 `.app/Contents/Resources/app` 未测试，
    且**改写 `.app` 包内文件会破坏代码签名** —— 所以即使锚点匹配也不要用；
  - Linux 未测试；
  - DSH Desktop 壳代码里虽有 macOS/Linux 分支（`darwin` 22 处 / `linux` 9 处），那是上游的实现，
    本插件不对非 Windows 做任何承诺。
- **写权限**：补丁要写 `<AppDir>\resources\app\lib\`。装在 `%LOCALAPPDATA%\Programs`（默认）普通权限即可；
  装在 `C:\Program Files` 需要管理员运行一次（否则只是没有动画）。
- **性能**：自带 4K72fps 片头需要硬件解码，老核显可能掉帧 —— 换掉片头即可，与功能无关。
- **杀软**：改写应用目录可能触发告警，属正常现象。
- 首次使用无需配置：没有 `splash.json` 时用默认值，开箱即播自带片头。
## 已知限制

- **"上次全屏"默认恢复成最大化**：见上面的 `restoreFullScreen`。想完全原样恢复就把配置打开。
- **启动窗只在主窗口显示之前存在**：如果桌面壳某次启动不走 `revealApplication()`（例如 `--require` 之类的后台启动），启动窗和窗口状态记忆都不会介入。
- **4K 默认片头让仓库变大**：默认片头 31 MB（4K，FlashVSR 超分片源，CRF 18 重编码），`git clone` / 插件安装都要拉这一份。
  想瘦身就换成 1080p/1440p 版本再 `node lib/cli.js patch`。注意**每次换片头都会在 git 历史里留下旧的那份**，历史体积只增不减。

---

## 许可

MIT。补丁注入的锚点来自 DSH Desktop 官方产物（`dsh-plugin-desktop`），本仓库不分发其代码。
