/**
 * 检查一个视频能不能当开机动画：容器、编码、时长、分辨率、是否 faststart。
 * 用法：node check-video.mjs "D:\我的\视频.mp4"
 *
 * 为什么需要它：开机动画走浏览器解码，编码不支持就只有声音或黑屏；
 * moov 不在文件头（没做 faststart）则要整段下完才出画面，看起来就是"黑屏十几秒"。
 */
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

const path = process.argv[2];
if (path === undefined) {
	console.error("用法：node check-video.mjs <视频文件>");
	process.exit(2);
}

const size = statSync(path).size;
const buf = readFileSync(path);
const latin = buf.toString("latin1");

// 时长：mvhd 的 timescale / duration
let duration = null;
const mvhd = latin.indexOf("mvhd");
if (mvhd >= 0) {
	const version = buf[mvhd + 4];
	const body = mvhd + 8;
	const timescale = version === 1 ? buf.readUInt32BE(body + 16) : buf.readUInt32BE(body + 8);
	const ticks = version === 1 ? Number(buf.readBigUInt64BE(body + 24)) : buf.readUInt32BE(body + 12);
	if (timescale > 0) duration = ticks / timescale;
}

// 分辨率：所有 tkhd 里最大的那条（视频轨）
let width = 0;
let height = 0;
for (let at = latin.indexOf("tkhd"); at >= 0; at = latin.indexOf("tkhd", at + 1)) {
	const version = buf[at + 4];
	const base = at + (version === 1 ? 92 : 80);
	if (base + 8 > buf.length) continue;
	const w = buf.readUInt32BE(base) / 65536;
	const h = buf.readUInt32BE(base + 4) / 65536;
	if (w > width) {
		width = w;
		height = h;
	}
}

const brands = new Set(buf.subarray(8, 32).toString("latin1").match(/[\w ]{4}/gu) ?? []);
const codecs = new Set((latin.match(/avc1|avc3|hvc1|hev1|vp09|av01|mp4a|Opus|opus|vorbis/gu) ?? []));
const moovAt = latin.indexOf("moov");
const mdatAt = latin.indexOf("mdat");
const faststart = moovAt >= 0 && (mdatAt < 0 || moovAt < mdatAt);

const video = [...codecs].filter((c) => /^(avc1|avc3|hvc1|hev1|vp09|av01)$/u.test(c));
const audio = [...codecs].filter((c) => !/^(avc1|avc3|hvc1|hev1|vp09|av01)$/u.test(c));
const browserOk = video.every((c) => c === "avc1" || c === "avc3" || c === "vp09" || c === "av01");

console.log(`文件      : ${path}`);
console.log(`名称      : ${basename(path, extname(path))}`);
console.log(`大小      : ${size} 字节 (${(size / 1048576).toFixed(2)} MB)`);
console.log(`容器      : ${extname(path).toLowerCase()}  brand=${[...brands].join(",")}`);
console.log(`时长      : ${duration === null ? "未知（不是 mp4？）" : `${duration.toFixed(2)} 秒`}`);
console.log(`分辨率    : ${width > 0 ? `${width}x${height}` : "未知"}`);
console.log(`视频编码  : ${video.length > 0 ? video.join(", ") : "未识别"}`);
console.log(`音频编码  : ${audio.length > 0 ? audio.join(", ") : "无（静音片头没问题）"}`);
console.log(`moov 位置 : ${moovAt < 0 ? "找不到" : `偏移 ${moovAt}`}   faststart=${faststart}`);
console.log("");
const problems = [];
if (moovAt < 0) problems.push("找不到 moov，可能不是 mp4");
if (!faststart) problems.push("没做 faststart（moov 在 mdat 之后）→ 会黑屏到下载完，用 ffmpeg -c copy -movflags +faststart 重排");
if (!browserOk) problems.push(`视频编码 ${video.join(",")} 浏览器可能解不了 → 建议转成 H.264(avc1)`);
if (duration !== null && duration > 60) problems.push(`时长 ${duration.toFixed(0)} 秒偏长，启动会等很久（可在 splash.json 调 maxMs）`);
if (problems.length === 0) console.log("结论：可以直接用作开机动画 ✓");
else {
	console.log("结论：有问题 ——");
	for (const p of problems) console.log(`  · ${p}`);
}
process.exit(problems.length === 0 ? 0 : 1);
