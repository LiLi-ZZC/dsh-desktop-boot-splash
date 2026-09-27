/**
 * dsh-desktop-boot-splash — 把开机动画补丁打到 DSH Desktop 的 Electron 壳上。
 *
 * 纯 Node 实现（不碰 Electron API），所以三处都能用同一份逻辑：
 *   1. 插件 host 半侧（lib/index.js）—— 每次启动自检，应用更新后自动补回补丁
 *   2. 命令行（lib/cli.js）—— 手动 patch / revert / status
 *   3. 单元测试（test-shell-patch.mjs）—— 沙箱里跑完整回归
 *
 * 打补丁的两处注入点（都基于官方源码里的锚点，锚点找不到就拒绝动手）：
 *   lib/main.js                  —— app.whenReady() 之后启动启动窗
 *   lib/electron-runtime-*.js    —— revealApplication() 开头拦住主窗口首次显示
 *
 * 设计约束，改的时候别丢：
 *   - 幂等：重复运行不重复插入，内容没变就不写文件
 *   - 可回滚：动之前把官方原文件备份成 *.dsh-boot-splash.bak
 *   - 有校验：打完补丁用 node --check 当 ESM 解析一遍，不过就回滚
 *   - 不猜版本：锚点对不上就报 unsupported，绝不盲插
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

export const BACKUP_SUFFIX = ".dsh-boot-splash.bak";
export const PAYLOAD_FILES = [
	"dsh-boot-splash.js",
	"dsh-boot-splash-clip.js",
	"dsh-boot-splash-orphan.js",
	"dsh-boot-splash.html",
	"dsh-boot-splash-default.mp4"
];
export const STATE_FILE = "dsh-boot-splash-state.json";
export const STATUS_FILE = "patch-status.json";

const MARKER = "__dshBootSplash";
/** main.js 里没有 __dshBootSplash 这个字符串，它的补丁痕迹是这两样。 */
const MAIN_MARKERS = ["startBootSplash", "dsh-boot-splash.js"];
const ELECTRON_IMPORT = 'import { app, crashReporter, dialog, safeStorage, screen, session, shell, utilityProcess } from "electron";';
const WHEN_READY = "await app.whenReady();";
const STARTUP_STAGE = 'startupStage = "shell-environment";';
const REVEAL_FN = "function revealApplication(window, platform = process.platform) {";
const SHELL_PACKAGE = "dsh-plugin-desktop";

function readText(path) {
	return readFileSync(path, "utf8").replace(/^\uFEFF/u, "");
}

function writeText(path, text) {
	writeFileSync(path, text, "utf8");
}

function fileSize(path) {
	try {
		const info = statSync(path);
		return info.isFile() ? info.size : -1;
	} catch {
		return -1;
	}
}

/** 某个文件是不是已经带着补丁了（两个文件的标记不一样，别只看 __dshBootSplash）。 */
export function isPatched(filePath) {
	const text = readText(filePath);
	return filePath.endsWith("main.js") ? MAIN_MARKERS.some((m) => text.includes(m)) : text.includes(MARKER);
}

function findRuntimeFile(libDir) {
	let names;
	try {
		names = readdirSync(libDir);
	} catch {
		return null;
	}
	const hit = names.filter((name) => /^electron-runtime-.*\.js$/u.test(name)).sort();
	return hit.length === 0 ? null : join(libDir, hit[0]);
}

/**
 * 校验一个目录是不是 DSH Desktop 的 resources/app。
 * 只认桌面壳（package.json name = dsh-plugin-desktop），别的 Electron 应用一律不动手。
 */
function validateAppDir(appDir) {
	const packagePath = join(appDir, "package.json");
	const mainJs = join(appDir, "lib", "main.js");
	if (fileSize(packagePath) < 0 || fileSize(mainJs) < 0) return null;
	let pkg;
	try {
		pkg = JSON.parse(readText(packagePath));
	} catch {
		return null;
	}
	if (pkg === null || typeof pkg !== "object" || pkg.name !== SHELL_PACKAGE) return null;
	const runtimeJs = findRuntimeFile(join(appDir, "lib"));
	if (runtimeJs === null) return null;
	return { appDir, libDir: join(appDir, "lib"), mainJs, runtimeJs, version: String(pkg.version ?? "unknown") };
}

/**
 * 定位 DSH Desktop 的 resources/app。
 * 在 host 进程里 process.execPath 就是 DSH Desktop.exe，最可靠；
 * 走命令行时 execPath 是 node.exe，所以要靠 hints / 常见安装位置。
 *
 * hints 里可能同时存在两种形态：安装根目录（…\DSH Desktop）和 app 目录本身
 * （…\resources\app，patch-status.json 记的就是后者）—— 两种都试，别再拼重。
 */
export function locateDesktopApp({ execPath, resourcesPath, hints = [] } = {}) {
	const roots = [];
	if (typeof resourcesPath === "string" && resourcesPath !== "") roots.push(resourcesPath);
	if (typeof execPath === "string" && execPath !== "") roots.push(join(dirname(execPath), "resources"));
	const candidates = roots.map((root) => join(root, "app"));
	for (const hint of hints) {
		if (typeof hint !== "string" || hint === "") continue;
		candidates.push(join(join(hint, "resources"), "app"), join(hint, "app"), hint);
	}
	for (const candidate of candidates) {
		const hit = validateAppDir(candidate);
		if (hit !== null) return hit;
	}
	return null;
}

/**
 * 命令行用的候选位置：先看上次记录的 app 目录，再看常见安装位置。
 * 这里不写死任何开发机路径 —— 这份代码会被拷到别人的电脑上跑。
 */
export function cliHints() {
	const configured = process.env.DSH_HOME?.trim();
	const dshHome = configured !== undefined && configured !== "" ? configured : join(homedir(), ".dsh");
	const hints = [];
	try {
		const status = JSON.parse(readText(join(dshHome, "boot-animation", STATUS_FILE)));
		if (typeof status?.appDir === "string") hints.push(status.appDir);
	} catch {
		// 没有记录就只靠常见位置。
	}
	const local = process.env.LOCALAPPDATA;
	if (typeof local === "string" && local !== "") hints.push(join(local, "Programs", "DSH Desktop"));
	if (typeof process.env.ProgramFiles === "string") hints.push(join(process.env.ProgramFiles, "DSH Desktop"));
	if (typeof process.env["ProgramFiles(x86)"] === "string") hints.push(join(process.env["ProgramFiles(x86)"], "DSH Desktop"));
	hints.push(join(homedir(), "DSH Desktop"));
	return hints;
}

/** 备份官方原文件。当前文件干净才刷新备份；已带补丁时保留既有干净备份。 */
function ensureBackup(filePath, actions, errors) {
	const backup = `${filePath}${BACKUP_SUFFIX}`;
	const name = basename(filePath);
	if (isPatched(filePath)) {
		if (!existsSync(backup)) errors.push(`${name} 已带补丁但没有备份，无法回滚该文件（重装 DSH Desktop 可取回原文件）`);
		else if (isPatched(backup)) errors.push(`${name} 的备份里也是补丁内容，回滚它会还原出带补丁的文件`);
		return;
	}
	const current = readText(filePath);
	const previous = existsSync(backup) ? readText(backup) : null;
	if (previous === current) return;
	writeText(backup, current);
	actions.push(previous === null ? `备份 ${name}` : `刷新备份 ${name}（应用已更新）`);
}

/** 打完补丁用 node --check 当 ESM 解析一遍；解析不了就回滚。 */
function syntaxOk(filePath, execPath) {
	const temp = join(process.env.TEMP ?? process.env.TMPDIR ?? ".", `dsh-boot-splash-check-${String(Date.now())}.mjs`);
	try {
		copyFileSync(filePath, temp);
		const result = spawnSync(execPath, ["--check", temp], {
			env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
			encoding: "utf8",
			timeout: 20000
		});
		if (result.error !== undefined && result.error !== null) return null;
		if (typeof result.status !== "number") return null;
		return result.status === 0;
	} catch {
		return null;
	} finally {
		try {
			unlinkSync(temp);
		} catch {
			// 临时文件清不掉无所谓。
		}
	}
}

function insertAfter(text, anchor, addition) {
	const at = text.indexOf(anchor);
	if (at < 0) return null;
	return text.slice(0, at + anchor.length) + addition + text.slice(at + anchor.length);
}

/**
 * main.js：注入 import，并在主启动路径的 app.whenReady() 之后启动启动窗。
 * 只在内存里算出结果（不写文件）—— 锚点对不上就整体放弃，别留下写了一半的现场。
 */
function planMainPatch(text) {
	if (text.includes('dsh-boot-splash.js') && text.includes("startBootSplash();")) return { text, label: "" };
	let next = text;
	if (!next.includes("dsh-boot-splash.js")) {
		if (!next.includes(ELECTRON_IMPORT)) return { error: "找不到 electron 的 import 行，桌面壳版本可能变了" };
		const newline = next.includes("\r\n") ? "\r\n" : "\n";
		const inserted = insertAfter(next, ELECTRON_IMPORT, `${newline}import { startBootSplash } from "./dsh-boot-splash.js";`);
		if (inserted === null) return { error: "注入 import 失败" };
		next = inserted;
	}
	if (!next.includes("startBootSplash();")) {
		const newline = next.includes("\r\n") ? "\r\n" : "\n";
		let at = -1;
		for (let cursor = 0; ; ) {
			const found = next.indexOf(WHEN_READY, cursor);
			if (found < 0) break;
			const tail = next.slice(found + WHEN_READY.length);
			const ws = /^\s*/u.exec(tail)[0];
			if (tail.slice(ws.length).startsWith(STARTUP_STAGE)) {
				at = found + WHEN_READY.length;
				break;
			}
			cursor = found + WHEN_READY.length;
		}
		if (at < 0) return { error: "找不到主启动路径的 app.whenReady()，桌面壳版本可能变了" };
		next = next.slice(0, at) + `${newline}\t\tstartBootSplash();` + next.slice(at);
	}
	return { text: next, label: "main.js: 注入 import + 启动启动窗" };
}

/** electron-runtime：拦住 revealApplication 的首次显示。同样只在内存里算。 */
function planRuntimePatch(text) {
	if (text.includes(MARKER)) return { text, label: "" };
	const newline = text.includes("\r\n") ? "\r\n" : "\n";
	const inserted = insertAfter(text, REVEAL_FN, `${newline}\tif (globalThis.${MARKER}?.hold?.(window) === true) return;`);
	if (inserted === null) return { error: "找不到 revealApplication，桌面壳版本可能变了" };
	return { text: inserted, label: "electron-runtime: 插入首次显示拦截" };
}

function ensureConfig(home, actions) {
	const dir = join(home, ".dsh", "boot-animation");
	const config = join(dir, "splash.json");
	if (existsSync(config)) return;
	mkdirSync(dir, { recursive: true });
	writeText(config, `${JSON.stringify({ enabled: true, maxMs: 15000, fit: "cover", skippable: true, clip: null }, null, 2)}\n`);
	actions.push("写入默认配置 splash.json");
}

function writeStatus(home, payload) {
	const dir = join(home, ".dsh", "boot-animation");
	mkdirSync(dir, { recursive: true });
	writeText(join(dir, STATUS_FILE), `${JSON.stringify(payload, null, 2)}\n`);
}

function readStatusFrom(home) {
	try {
		return JSON.parse(readText(join(home, ".dsh", "boot-animation", STATUS_FILE)));
	} catch {
		return null;
	}
}

/**
 * 确保补丁在位。返回一份报告（changed 表示这次真的动了文件）。
 *
 * managedBy 决定这份补丁"归谁管"，卸载时要不要自清理就看它：
 *   "plugin"（默认）—— 插件装的。插件从 profile 里消失后，负载会在下次启动时自清理。
 *   "script"        —— install.ps1 装的。永远不自清理，由那个脚本负责还原。
 * profileDir 只在 managedBy === "plugin" 时有意义：自清理靠它判断插件是否还在。
 */
export function applySplashPatch({ app, assetsDir, execPath = process.execPath, home = homedir(), logger, managedBy = "plugin", profileDir = null } = {}) {
	const log = (level, message) => {
		if (logger !== undefined && typeof logger[level] === "function") logger[level](message);
	};
	const actions = [];
	const errors = [];
	const report = { appDir: app?.appDir ?? null, version: app?.version ?? null, changed: false, actions, errors, restartRequired: false };
	if (app === undefined || app === null) {
		errors.push("没有定位到 DSH Desktop 的 resources/app");
		writeStatus(home, { ok: false, at: new Date().toISOString(), ...report });
		return report;
	}
	try {
		// 1) 负载文件：内容一样就不写，避免无谓的 mtime 抖动。
		//    按 Buffer 比较 —— 其中有 mp4 二进制，用 UTF-8 字符串比会把不同字节看成一串替换字符。
		const missingPayload = [];
		for (const name of PAYLOAD_FILES) {
			const source = join(assetsDir, name);
			const target = join(app.libDir, name);
			if (!existsSync(source)) {
				missingPayload.push(name);
				continue;
			}
			const content = readFileSync(source);
			if (existsSync(target) && readFileSync(target).equals(content)) continue;
			writeFileSync(target, content);
			actions.push(`写入 ${name}`);
		}
		// 负载不全就绝不能打 main.js 的补丁：那句 import 指向的文件不存在时，
		// Electron 主进程会直接起不来。宁可没有动画，也不能让软件打不开。
		if (missingPayload.length > 0) {
			errors.push(`缺少负载文件 ${missingPayload.join(", ")}；为确保 DSH 能启动，未打补丁`);
			report.changed = actions.length > 0;
			report.ok = false;
			writeStatus(home, { ok: false, at: new Date().toISOString(), ...report });
			return report;
		}

		// 2) 先在内存里算出补丁内容。锚点对不上就整体放弃 —— 不写文件、不留备份。
		const plans = [];
		for (const [filePath, plan] of [[app.mainJs, planMainPatch], [app.runtimeJs, planRuntimePatch]]) {
			const result = plan(readText(filePath));
			if (result.error !== undefined) {
				errors.push(`${basename(filePath)}: ${result.error}`);
				continue;
			}
			if (result.text === readText(filePath)) continue;
			plans.push({ filePath, text: result.text, label: result.label });
		}
		if (errors.length > 0) {
			report.changed = actions.length > 0;
			report.ok = false;
			log("warn", `dsh-desktop-boot-splash: 桌面壳结构不认识，已放弃打补丁：${errors.join("；")}`);
			writeStatus(home, { ok: false, at: new Date().toISOString(), ...report });
			return report;
		}

		// 3) 备份 → 写入 → 语法校验 → 失败回滚
		for (const item of plans) {
			ensureBackup(item.filePath, actions, errors);
			const backup = `${item.filePath}${BACKUP_SUFFIX}`;
			writeText(item.filePath, item.text);
			const verdict = syntaxOk(item.filePath, execPath);
			if (verdict === false) {
				if (existsSync(backup)) copyFileSync(backup, item.filePath);
				errors.push(`${basename(item.filePath)} 打完补丁语法不通过，已回滚`);
				continue;
			}
			actions.push(item.label);
			report.restartRequired = true;
		}
		ensureConfig(home, actions);
		report.changed = actions.length > 0;
		report.ok = errors.length === 0;
		if (report.changed) log("info", `dsh-desktop-boot-splash: ${actions.join("；")}${report.restartRequired ? "（重启 DSH Desktop 后生效）" : ""}`);
		for (const error of errors) log("warn", `dsh-desktop-boot-splash: ${error}`);
		writeStatus(home, { ok: errors.length === 0, at: new Date().toISOString(), ...report });
		// 记录归属 + 应用版本：负载靠 managedBy/profileDir 判断自己是不是孤儿，
		// 命令行/安装脚本靠 appVersion 判断应用是否刚更新过。
		writeText(join(app.libDir, STATE_FILE), `${JSON.stringify({
			appVersion: app.version,
			patchedAt: new Date().toISOString(),
			managedBy,
			profileDir,
			payload: PAYLOAD_FILES
		}, null, 2)}\n`);
		return report;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		report.ok = false;
		errors.push(`补丁过程异常：${message}`);
		log("error", `dsh-desktop-boot-splash: ${message}`);
		writeStatus(home, { ok: false, at: new Date().toISOString(), ...report });
		return report;
	}
}

/** 还原成官方原样：恢复备份、删掉负载文件。 */
export function revertSplashPatch({ app, logger } = {}) {
	const actions = [];
	const errors = [];
	if (app === undefined || app === null) return { actions, errors: ["没有定位到 DSH Desktop 的 resources/app"] };
	for (const name of readdirSync(app.libDir)) {
		if (!name.endsWith(BACKUP_SUFFIX)) continue;
		const original = join(app.libDir, name.slice(0, -BACKUP_SUFFIX.length));
		if (existsSync(original)) {
			copyFileSync(join(app.libDir, name), original);
			actions.push(`恢复 ${basename(original)}`);
		} else {
			actions.push(`丢弃过期备份 ${name}`);
		}
		unlinkSync(join(app.libDir, name));
	}
	for (const name of [...PAYLOAD_FILES, STATE_FILE]) {
		const target = join(app.libDir, name);
		if (!existsSync(target)) continue;
		unlinkSync(target);
		actions.push(`删除 ${name}`);
	}
	if (typeof logger?.info === "function" && actions.length > 0) logger.info(`dsh-desktop-boot-splash: ${actions.join("；")}`);
	return { actions, errors };
}

export { readStatusFrom as readStatus };
