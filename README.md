# dsh-desktop-boot-splash

给 **DSH Desktop** 加一段真正的开机动画：启动软件时先播放片头，播完（或你点一下跳过）才出现主界面。
它以 **DSH 插件**的形式分发，负责把补丁打到 Electron 壳上，并在**应用更新后自动补回**。

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

默认动画是插件自带的片头：1280×720 / 7.07 秒 / 1.38 MB，H.264 + AAC，faststart。想换成自己的片子见[片源](#片源)。

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

支持 Windows / macOS / Linux（补丁本身跨平台；`install.ps1` 是 Windows 专用）。

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
> 想锁定版本就带 tag：`github:LiLi-ZZC/dsh-desktop-boot-splash#v1.0.0`。

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
  "clip": null           // 指定片源：绝对路径，或 "builtin:<名字>"
}
```

配置**每次启动时读取**，改完下次启动生效，不用重打补丁。
（文件带不带 UTF-8 BOM 都能读 —— 用记事本改过也没关系。）

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
Windows       C:\Users\<你>\.dsh\boot-animation\videos\
macOS / Linux ~/.dsh/boot-animation/videos/
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
（1280×720 / 7.07 秒 / 1.38 MB，H.264 + AAC，faststart；sha256 以 `00603f6424644c4b` 开头），
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

### 改代码时别破坏的设计约束

- **任何异常都只能导致「不播动画、正常进软件」**：补丁器全部包在 try/catch 里，插件绝不影响 DSH 启动。
- **负载不全就不打 main.js 的补丁**：那句 `import` 指向的文件不存在时，Electron 主进程会直接起不来。
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

## 许可

MIT。补丁注入的锚点来自 DSH Desktop 官方产物（`dsh-plugin-desktop`），本仓库不分发其代码。
