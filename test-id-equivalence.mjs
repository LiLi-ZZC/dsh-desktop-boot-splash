/**
 * 断言 makeLibraryId 与插件 dsh-boot-animation 的 makeId 一致。
 *
 * 分两层：
 *  1) 冻结用例 —— 不依赖插件是否安装，永远能跑。这些期望值是当初用插件源码里的
 *     makeId() 逐字符比对通过之后固化的。示例路径已匿名化，这不影响结论：makeId
 *     只是对路径字符串做 FNV-1a，换路径就换结果，规则本身与具体路径无关。
 *  2) 实时比对 —— 插件在场时，直接把它源码里的 makeId() 抽出来执行再对比。
 *
 * 为什么在意这件事：片库选择算的是路径派生的 id。id 规则一旦漂移，开机动画就认不出
 * 用户选的那一段，静默退化成「videos 里最新的那个」——不报错，只是播错片。
 */
import { readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { homedir } from "node:os";
import { makeLibraryId } from "./assets/dsh-boot-splash-clip.js";

/** 期望值固化自插件的 makeId()。路径是匿名示例，不是任何人的真实目录。 */
const FIXTURES = [
	["C:\\Users\\example\\.dsh\\boot-animation\\videos\\intro.mp4", "intro-ec17b855"],
	["C:\\Users\\example\\.dsh\\boot-animation\\videos\\我的片头.mp4", "video-41b986f5"],
	["C:\\Users\\example\\.dsh\\boot-animation\\videos\\My Clip (final) v2.MP4", "My-Clip-final-v2-16e213ba"],
	["C:\\Users\\example\\.dsh\\boot-animation\\videos\\___weird___name___.mp4", "___weird___name___-255054c8"],
	["C:\\Users\\example\\.dsh\\boot-animation\\intro.mp4", "intro-0f192870"],
	["/home/user/.dsh/boot-animation/videos/clip.webm", "clip-343108ae"],
	[`C:\\a\\b\\${"x".repeat(60)}.mp4`, "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-d3b37fe7"]
];

/** 只在插件在场时用的额外用例（实时比对，不需要冻结期望值）。 */
const LIVE_CASES = [
	"C:\\Users\\example\\.dsh\\boot-animation\\videos\\idtest-probe.mp4",
	"C:\\Users\\example\\.dsh\\boot-animation\\videos\\a.b.c.mp4",
	"D:\\影片\\片头 最终版.MP4"
];

let bad = 0;

console.log("── 冻结用例");
for (const [path, expected] of FIXTURES) {
	const actual = makeLibraryId(path);
	const ok = actual === expected;
	if (!ok) bad += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${actual.padEnd(44)} 期望 ${expected}  ${basename(path)}`);
}

console.log("\n── 与插件源码实时比对");
const configured = process.env.DSH_HOME?.trim();
const dshHome = configured !== undefined && configured !== "" ? configured : join(homedir(), ".dsh");
const pluginIndex = join(dshHome, "profiles/desktop/node_modules/dsh-boot-animation/lib/index.js");
let source = null;
try {
	source = readFileSync(pluginIndex, "utf8");
} catch {
	console.log("跳过：未安装 dsh-boot-animation（冻结用例已覆盖）");
}
if (source !== null) {
	const at = source.indexOf("function makeId(p) {");
	if (at < 0) {
		console.log("FAIL 插件源码里找不到 makeId（算法可能已改）");
		bad += 1;
	} else {
		const end = source.indexOf("\n}", at) + 2;
		const pluginMakeId = new Function("basename", "extname", `${source.slice(at, end)}\nreturn makeId;`)(basename, extname);
		for (const path of [...FIXTURES.map(([p]) => p), ...LIVE_CASES]) {
			const mine = makeLibraryId(path);
			const theirs = pluginMakeId(path);
			const ok = mine === theirs;
			if (!ok) bad += 1;
			console.log(`${ok ? "ok  " : "FAIL"} ${mine.padEnd(44)} 插件 ${theirs}`);
		}
	}
}

console.log(bad === 0 ? "\n全部一致" : `\n${bad} 项不一致`);
process.exit(bad === 0 ? 0 : 1);
