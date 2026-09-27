#!/usr/bin/env node
/**
 * dsh-desktop-boot-splash 命令行：不装插件也能用同一套逻辑。
 *
 *   node lib/cli.js status            看当前状态（补丁在不在、应用版本、生效片源）
 *   node lib/cli.js patch             打补丁（幂等）
 *   node lib/cli.js revert            还原成官方原样
 *   node lib/cli.js patch --app "D:\DSH Desktop"
 *
 * --app 可以指定安装目录；不指定时先读上次记录的路径，再试常见安装位置。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { PAYLOAD_FILES, applySplashPatch, cliHints, isPatched, locateDesktopApp, readStatus, revertSplashPatch } from "./shell-patch.js";

const ASSETS_DIR = fileURLToPath(new URL("../assets/", import.meta.url));
const HOME = homedir();

function parseArgs(argv) {
	const options = { command: argv[0] ?? "status", app: null, yes: false };
	for (let index = 1; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--app" || argument === "--app-dir") options.app = argv[index + 1] ?? null;
		else if (argument.startsWith("--app=")) options.app = argument.slice(6);
		else if (argument === "--yes" || argument === "-y") options.yes = true;
	}
	return options;
}

function findApp(options) {
	const hints = options.app === null ? cliHints(HOME) : [options.app];
	const app = locateDesktopApp({ execPath: process.execPath, resourcesPath: process.resourcesPath, hints });
	if (app === null) {
		console.log("✗ 没找到 DSH Desktop 的 resources/app。用 --app 指定安装目录，例如：");
		console.log(`    node ${fileURLToPath(import.meta.url)} status --app "D:\\DSH Desktop"`);
		process.exit(2);
	}
	return app;
}

/** 生效片源：复用补丁自己部署出去的那个解析模块，保证和真正播放时同一套规则。 */
async function describeClip(app) {
	const deployed = join(app.libDir, "dsh-boot-splash-clip.js");
	if (!existsSync(deployed)) return "（补丁还没打，暂无法判断）";
	try {
		const module = await import(`file://${deployed.replace(/\\/gu, "/")}`);
		const clip = module.resolveSplashClip(module.readSplashConfig());
		if (clip === null) return "（解析不出片源 —— 不会播动画）";
		return `${clip.source}  ->  ${clip.path}`;
	} catch (cause) {
		return `（读取失败：${cause instanceof Error ? cause.message : String(cause)}）`;
	}
}

const options = parseArgs(process.argv.slice(2));
const app = findApp(options);

console.log(`DSH Desktop : ${app.appDir}`);
console.log(`应用版本    : ${app.version}`);

if (options.command === "revert") {
	const result = revertSplashPatch({ app });
	for (const action of result.actions) console.log(`  ${action}`);
	for (const error of result.errors) console.log(`  ! ${error}`);
	console.log(result.actions.length === 0 ? "本来就是干净的" : "已还原，重启 DSH Desktop 生效");
	process.exit(result.errors.length === 0 ? 0 : 1);
}

if (options.command === "status") {
	for (const [label, filePath] of [["main.js", app.mainJs], ["runtime", app.runtimeJs]]) {
		console.log(`补丁 ${label.padEnd(8)}: ${isPatched(filePath) ? "已就位" : "缺失"}`);
	}
	let missing = 0;
	for (const name of PAYLOAD_FILES) if (!existsSync(join(app.libDir, name))) missing += 1;
	console.log(`负载文件    : ${missing === 0 ? `${PAYLOAD_FILES.length} 个齐全` : `缺 ${missing} 个`}`);
	const status = readStatus(HOME);
	console.log(`上次检查    : ${status === null ? "无记录" : `${status.at}（ok=${String(status.ok)}）`}`);
	console.log(`生效片源    : ${await describeClip(app)}`);
	const config = join(HOME, ".dsh", "boot-animation", "splash.json");
	if (existsSync(config)) console.log(`配置        : ${readFileSync(config, "utf8").replace(/\s+/gu, " ")}`);
	process.exit(0);
}

if (options.command !== "patch") {
	console.log(`未知命令 ${options.command}；可用：status | patch | revert`);
	process.exit(2);
}

// 命令行属于"脚本管理"：不能标成 plugin，否则卸载插件时会把脚本装的补丁一起撤掉。
const report = applySplashPatch({ app, assetsDir: ASSETS_DIR, execPath: process.execPath, home: HOME, managedBy: "script" });
for (const action of report.actions) console.log(`  ${action}`);
for (const error of report.errors) console.log(`  ! ${error}`);
if (!report.changed) console.log("  已经在位，无需改动");
console.log(report.restartRequired ? "补丁已更新，重启 DSH Desktop 生效" : "完成");
process.exit(report.errors.length === 0 ? 0 : 1);
