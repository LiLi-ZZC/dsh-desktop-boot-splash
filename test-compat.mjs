/**
 * 兼容性自测：node test-compat.mjs
 *
 * 用**合成的桌面壳源码**验证补丁锚点的容错范围。背景：有用户在一台 DSH 版本更低的电脑上安装后
 * 插件没生效，更新 DSH 后才生效 —— 根因是补丁锚点写死了（整行 electron import、连参数列表都写死），
 * 相邻版本稍有差异就失配。这里就是防止那种回归。
 *
 * 每个用例要么"补丁打上且位置正确"，要么"明确失败且不改动原文"，不允许写坏。
 */
import { planMainPatch, planRuntimePatch } from "./lib/shell-patch.js";

const IMPORT_STD = 'import { app, crashReporter, dialog, safeStorage, screen, session, shell, utilityProcess } from "electron";';
/** 相邻版本的常见差异：增删一两个导入、换顺序。 */
const IMPORT_ALT = 'import { app, BrowserWindow, dialog, nativeTheme, screen, shell, utilityProcess } from "electron";';

const makeMain = (importLine, suffix) => [
	'import path from "node:path";',
	importLine,
	"",
	"async function start() {",
	"\tawait app.whenReady();",
	suffix,
	"\t// ...",
	"}"
].join("\n");

const makeRuntime = (definition) => [
	"function applicationNeedsReveal(window) {",
	"\treturn window.isMinimized();",
	"}",
	definition,
	"function reveal() {",
	"\trevealApplication(this.window, \"win32\");",
	"}"
].join("\n");

const DEF_STD = "function revealApplication(window, platform = process.platform) {\n\tif (platform === \"darwin\" && app.isHidden()) app.show();\n}";
/** 老版本可能没有默认参数 —— 这正是这次踩到的差异。 */
const DEF_OLD = "function revealApplication(window) {\n\twindow.show();\n}";
const DEF_METHOD = ["class Shell {", "\trevealApplication(window) {", "\t\twindow.show();", "\t}", "}"].join("\n");

const cases = [];
const check = (name, ok, detail = "") => cases.push([name, ok, detail]);

// ── main.js ──────────────────────────────────────────────────────────────────
for (const [label, importLine] of [["标准 import", IMPORT_STD], ["增删过导入的 import 行", IMPORT_ALT]]) {
	const source = makeMain(importLine, '\tstartupStage = "shell-environment";');
	const result = planMainPatch(source);
	const ok = typeof result.text === "string" && result.text.includes("dsh-boot-splash.js") && result.text.includes("startBootSplash();");
	check(`main.js（${label}）能打上`, ok, result.error ?? result.label);
	// 注入位置：import 必须紧跟 electron import、调用必须在 whenReady 之后
	if (ok) {
		const importAt = result.text.indexOf('import { startBootSplash }');
		check(`main.js（${label}）import 紧跟 electron import`, importAt > result.text.indexOf(importLine) && importAt - result.text.indexOf(importLine) < 120);
		check(`main.js（${label}）调用在 whenReady 之后`, result.text.indexOf("startBootSplash();") > result.text.indexOf("await app.whenReady();"));
	}
}

const noStage = planMainPatch(makeMain(IMPORT_STD, "\t// 没有 startupStage 标记"));
check("main.js（没有 startupStage 标记）回退到第一个 whenReady 仍能打上", typeof noStage.text === "string" && noStage.text.includes("startBootSplash();"), noStage.error ?? noStage.label);

const noImport = planMainPatch('const { app } = require("electron");\nawait app.whenReady();');
check("main.js（没有 electron 具名 import）明确失败且不改动", noImport.text === void 0 && typeof noImport.error === "string" && noImport.error.includes("electron"), noImport.error ?? "");

const already = planMainPatch(makeMain(IMPORT_STD, "\tstartupStage = \"shell-environment\";").replace("async function start() {", "import { startBootSplash } from \"./dsh-boot-splash.js\";\nasync function start() {\n\tstartBootSplash();"));
check("main.js 幂等：已打过补丁就不再动", already.label === "" && typeof already.text === "string");

// ── electron-runtime ────────────────────────────────────────────────────────
for (const [label, definition] of [["标准签名", DEF_STD], ["老版本没有默认参数", DEF_OLD], ["类方法写法", DEF_METHOD]]) {
	const source = makeRuntime(definition);
	const result = planRuntimePatch(source);
	const ok = typeof result.text === "string" && result.text.includes("__dshBootSplash?.hold?.(window)");
	check(`runtime（${label}）能打上`, ok, result.error ?? result.label);
	if (ok) {
		// 拦截必须插在函数体第一行（在函数体起始 { 之后、且在原来的第一句之前）
		const holdAt = result.text.indexOf("__dshBootSplash?.hold?.(window)");
		const bodyAt = result.text.indexOf(definition.slice(0, definition.indexOf("{")) + "{");
		check(`runtime（${label}）插在函数体开头`, holdAt > bodyAt && holdAt - bodyAt < 120);
	}
}

const callOnly = planRuntimePatch(['function reveal() {', '\trevealApplication(this.window);', '}'].join("\n"));
check("runtime（只有调用、没有定义）明确失败且不改动", callOnly.text === void 0 && typeof callOnly.error === "string" && callOnly.error.includes("revealApplication"), callOnly.error ?? "");

// 已经打过补丁的运行时文件必须原样跳过（自愈不能反复插入）
const patchedOnce = planRuntimePatch(makeRuntime(DEF_STD)).text;
const patchedTwice = planRuntimePatch(patchedOnce);
check("runtime 幂等：第二次不再插入", patchedTwice.label === "" && patchedTwice.text === patchedOnce);

let bad = 0;
for (const [name, ok, detail] of cases) {
	if (!ok) bad += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === "" ? "" : `   (${detail})`}`);
}
if (bad > 0) {
	console.log(`\n${bad} 项失败`);
	process.exit(1);
}
console.log("\n全部通过");
