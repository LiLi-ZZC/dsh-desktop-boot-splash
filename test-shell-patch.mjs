/**
 * dsh-desktop-boot-splash 补丁器回归测试（沙箱，不动真实安装）。
 *
 *   node test-shell-patch.mjs
 *
 * 覆盖：
 *   1. 定位桌面壳（locateDesktopApp）
 *   2. 干净安装 → 打补丁 → 校验产物与「PowerShell 安装脚本」逐字节一致
 *   3. 重复打补丁幂等，且不会污染备份（这是踩过的坑）
 *   4. 锚点缺失时拒绝动手并保持原样
 *   5. 还原后与原文件逐字节一致
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PAYLOAD_FILES, applySplashPatch, cliHints, locateDesktopApp, revertSplashPatch } from "./lib/shell-patch.js";
import { detectOrphan, removeShellPatch } from "./assets/dsh-boot-splash-orphan.js";

// 注意必须走 fileURLToPath：import.meta.url 里的中文路径是百分号编码的，
// 直接取 pathname 会拿到百分号编码的路径（中文/空格目录都会被编码），于是文件找不到。
const REPO = fileURLToPath(new URL(".", import.meta.url));
const ASSETS = join(REPO, "assets");
/** 真实安装位置靠自动探测，不写死 —— 换个盘/换台电脑这份测试也要能跑。 */
const LIVE_APP = locateDesktopApp({ execPath: process.execPath, resourcesPath: process.resourcesPath, hints: cliHints() });
if (LIVE_APP === null) {
	console.log("跳过：本机没找到 DSH Desktop 安装。");
	console.log("补丁器回归测试需要一份真实安装里的官方备份当输入 —— 先跑 install.ps1 / cli.js patch 生成备份，再回来跑这个测试。");
	process.exit(0);
}
const LIVE = LIVE_APP.appDir;

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const size = (path) => readFileSync(path).length;
let failures = 0;
function check(label, ok, detail = "") {
	if (!ok) failures += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `  ${detail}`}`);
}

// ---------------------------------------------------------------- 搭沙箱
const root = join(tmpdir(), `dsh-boot-splash-test-${String(Date.now())}`);
const sandbox = join(root, "install");
const appDir = join(sandbox, "resources", "app");
const libDir = join(appDir, "lib");
const home = join(root, "home");
mkdirSync(libDir, { recursive: true });
mkdirSync(home, { recursive: true });

// 干净原文件：直接取真实安装里的官方备份（它们就是官方原文件）
const liveLib = join(LIVE, "lib");
const liveRuntime = readdirSync(liveLib).find((name) => /^electron-runtime-.*\.js$/u.test(name));
if (liveRuntime === undefined) throw new Error("找不到 electron-runtime-*.js 备份来源");
copyFileSync(join(liveLib, "main.js.dsh-boot-splash.bak"), join(libDir, "main.js"));
copyFileSync(join(liveLib, `${liveRuntime}.dsh-boot-splash.bak`), join(libDir, liveRuntime));
copyFileSync(join(LIVE, "package.json"), join(appDir, "package.json"));

const pristineMain = sha(join(libDir, "main.js"));
const pristineRuntime = sha(join(libDir, liveRuntime));
console.log(`沙箱: ${root}`);
console.log(`干净原文件: main.js=${size(join(libDir, "main.js"))} bytes  ${liveRuntime}=${size(join(libDir, liveRuntime))} bytes`);
check("干净原文件尺寸符合官方记录", size(join(libDir, "main.js")) === 208339 && size(join(libDir, liveRuntime)) === 156343);

// ---------------------------------------------------------------- 1. 定位
const fakeExe = join(sandbox, "DSH Desktop.exe");
writeFileSync(fakeExe, "");
const located = locateDesktopApp({ execPath: fakeExe });
check("locateDesktopApp 找到桌面壳", located !== null && located.appDir === appDir, located === null ? "" : located.appDir);
check("locateDesktopApp 读出应用版本", located !== null && located.version === "2.0.15", located?.version ?? "");
check("非桌面壳目录不会被误认", locateDesktopApp({ execPath: join(root, "nope", "other.exe") }) === null);

// ---------------------------------------------------------------- 2. 打补丁
const first = applySplashPatch({ app: located, assetsDir: ASSETS, execPath: process.execPath, home });
check("首次打补丁 changed=true", first.changed === true);
check("首次打补丁无错误", first.errors.length === 0, first.errors.join(" | "));
check("提示需要重启", first.restartRequired === true);
check(
	"main.js 已注入 import 与启动调用",
	readFileSync(located.mainJs, "utf8").includes('import { startBootSplash } from "./dsh-boot-splash.js";') &&
		readFileSync(located.mainJs, "utf8").includes("startBootSplash();")
);
check(
	"electron-runtime 已插入拦截",
	readFileSync(located.runtimeJs, "utf8").includes("globalThis.__dshBootSplash?.hold?.(window) === true")
);
for (const name of PAYLOAD_FILES) {
	check(`负载已部署 ${name}`, existsSync(join(libDir, name)) && sha(join(libDir, name)) === sha(join(ASSETS, name)));
}
check("备份已建立且是干净原文件", sha(join(libDir, "main.js.dsh-boot-splash.bak")) === pristineMain && sha(join(libDir, `${liveRuntime}.dsh-boot-splash.bak`)) === pristineRuntime);

// 若真实安装当前是"已打补丁"状态，顺带做一次跨实现对比：
// 本补丁器（JS）与当初的 install.ps1（PowerShell）必须产出逐字节相同的文件。
// 没打补丁就跳过 —— 否则会拿两个都没打补丁的文件比出"一致"，那是假阳性。
if (readFileSync(join(liveLib, "main.js"), "utf8").includes("startBootSplash();")) {
	check("对比基准确实是已打补丁的 runtime", readFileSync(join(liveLib, liveRuntime), "utf8").includes("__dshBootSplash"));
	check("产物与 PowerShell 版 main.js 逐字节一致", sha(located.mainJs) === sha(join(liveLib, "main.js")), `${size(located.mainJs)} vs ${size(join(liveLib, "main.js"))}`);
	check("产物与 PowerShell 版 electron-runtime 逐字节一致", sha(located.runtimeJs) === sha(join(liveLib, liveRuntime)), `${size(located.runtimeJs)} vs ${size(join(liveLib, liveRuntime))}`);
} else {
	console.log("跳过：真实安装当前未打补丁，无法做跨实现对比（先跑 cli.js patch 再回来）");
}

// ---------------------------------------------------------------- 3. 幂等 + 备份不被污染
const second = applySplashPatch({ app: located, assetsDir: ASSETS, execPath: process.execPath, home });
check("重复打补丁 changed=false", second.changed === false, second.actions.join("；"));
check("重复打补丁后备份仍是原文件", sha(join(libDir, "main.js.dsh-boot-splash.bak")) === pristineMain && sha(join(libDir, `${liveRuntime}.dsh-boot-splash.bak`)) === pristineRuntime);

// ---------------------------------------------------------------- 4. 锚点缺失 → 拒绝动手
const brokenDir = join(root, "broken", "resources", "app");
mkdirSync(join(brokenDir, "lib"), { recursive: true });
copyFileSync(join(LIVE, "package.json"), join(brokenDir, "package.json"));
writeFileSync(join(brokenDir, "lib", "main.js"), "// 未来版本的 main.js，没有我们认识的锚点\nawait app.whenReady();\n");
writeFileSync(join(brokenDir, "lib", liveRuntime), "// 未来版本的 runtime\nfunction revealApplication(window) {}\n");
const brokenBefore = readFileSync(join(brokenDir, "lib", "main.js"), "utf8");
const brokenReport = applySplashPatch({
	app: { appDir: brokenDir, libDir: join(brokenDir, "lib"), mainJs: join(brokenDir, "lib", "main.js"), runtimeJs: join(brokenDir, "lib", liveRuntime), version: "9.9.9" },
	assetsDir: ASSETS,
	execPath: process.execPath,
	home
});
check("锚点缺失时报错", brokenReport.errors.length > 0, brokenReport.errors[0] ?? "");
check("锚点缺失时 main.js 保持原样", readFileSync(join(brokenDir, "lib", "main.js"), "utf8") === brokenBefore);
check("锚点缺失时不留任何备份（没写就不能有痕迹）", !existsSync(join(brokenDir, "lib", "main.js.dsh-boot-splash.bak")));
check("锚点缺失时不报告需要重启", brokenReport.restartRequired === false);

// ---------------------------------------------------------------- 5. 卸载插件 → 补丁自清理
// 这是用户明确要求的行为：点「卸载」之后连开机动画一起拿掉。
// 两条路径都测：插件侧的即时清理（revertSplashPatch），和负载侧的孤儿自清理（removeShellPatch）。
const pluginDir = join(root, "profile", "node_modules", "dsh-desktop-boot-splash");
mkdirSync(pluginDir, { recursive: true });
function writeProfile(installed) {
	const profileDir = join(root, "profile");
	writeFileSync(join(profileDir, "package.json"), JSON.stringify({
		name: "dsh-profile-desktop",
		dependencies: installed ? { "dsh-desktop-boot-splash": "file:x" } : {},
		dsh: { profile: { bundles: installed ? ["@deepseek-ai/dsh-base", "dsh-desktop-boot-splash"] : ["@deepseek-ai/dsh-base"] } }
	}));
	return profileDir;
}

// 重新打一份补丁，这次记下"归属 = 插件 + 哪个 profile"
const profileDir = writeProfile(true);
const owned = applySplashPatch({ app: located, assetsDir: ASSETS, execPath: process.execPath, home, managedBy: "plugin", profileDir });
check("带归属信息打补丁成功", owned.errors.length === 0, owned.errors.join(" | "));
const state = JSON.parse(readFileSync(join(libDir, "dsh-boot-splash-state.json"), "utf8"));
check("状态文件记录了 managedBy=plugin", state.managedBy === "plugin");
check("状态文件记录了 profileDir", state.profileDir === profileDir);

check("插件还在时不算孤儿", detectOrphan(libDir) === null);
check("install.ps1 装的补丁永不自清理", (() => {
	writeFileSync(join(libDir, "dsh-boot-splash-state.json"), JSON.stringify({ managedBy: "script", profileDir, appVersion: "2.0.15" }));
	const verdict = detectOrphan(libDir) === null;
	writeFileSync(join(libDir, "dsh-boot-splash-state.json"), JSON.stringify({ managedBy: "plugin", profileDir, appVersion: "2.0.15" }));
	return verdict;
})());

writeProfile(false); // ← 相当于用户点了「卸载」
const orphan = detectOrphan(libDir);
check("插件被卸载后判定为孤儿", orphan !== null && orphan.profileDir === profileDir);

const cleaned = removeShellPatch(libDir);
check("孤儿自清理无错误", cleaned.errors.length === 0, cleaned.errors.join(" | "));
check("自清理后 main.js 字节级还原", sha(join(libDir, "main.js")) === pristineMain, `${size(join(libDir, "main.js"))} bytes`);
check("自清理后 electron-runtime 字节级还原", sha(join(libDir, liveRuntime)) === pristineRuntime, `${size(join(libDir, liveRuntime))} bytes`);
check("自清理后负载文件已删除", PAYLOAD_FILES.every((name) => !existsSync(join(libDir, name))));
check("自清理后状态文件已删除", !existsSync(join(libDir, "dsh-boot-splash-state.json")));
check("自清理后备份也清掉了", readdirSync(libDir).every((name) => !name.endsWith(".dsh-boot-splash.bak")));

// ---------------------------------------------------------------- 6. 还原（从已清理状态再走一遍官方还原路径）
const reverted = revertSplashPatch({ app: located });
check("还原无错误", reverted.errors.length === 0);
check("main.js 字节级还原", sha(join(libDir, "main.js")) === pristineMain);
check(`electron-runtime 字节级还原`, sha(join(libDir, liveRuntime)) === pristineRuntime);
check("负载文件已清理", !existsSync(join(libDir, "dsh-boot-splash.js")) && !existsSync(join(libDir, "dsh-boot-splash.html")));
check("备份已清理", readdirSync(libDir).every((name) => !name.endsWith(".dsh-boot-splash.bak")));

rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项未通过`);
process.exit(failures === 0 ? 0 : 1);
