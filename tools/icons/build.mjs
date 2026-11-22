// tools/icons/build.mjs
/**
 * 生成 MLTTC 站点图标：favicon.ico（多尺寸）+ favicon.svg（矢量）+ apple-touch-icon.png。
 *
 * 设计源是 tools/icons/ 下的三份 SVG，本脚本解析并光栅化它们：
 *   icon.svg        精细版（32px 及以上），同时作为站点 /favicon.svg
 *   icon-small.svg  16 / 24px 简化版（去掉渐变与内描边、加粗笔画）
 *   apple-touch.svg 180×180 满铺版（iOS 自己加圆角遮罩）
 * 几何刻意只用「圆角矩形 + 折线 + 圆 + 线性渐变 + 圆角裁剪」，所以这里的 SVG 子集
 * 解析器只有一百多行，不需要 sharp / ImageMagick / Pillow，也不需要拉起浏览器。
 * 每个像素超采样 SS×SS 次、按 premultiplied alpha 求平均，边缘是精确覆盖率。
 *
 * 产物（都放在站点根目录，Cloudflare Pages 原样发布）：
 *   /favicon.ico            16/24 用简化版，32~256 用精细版
 *   /favicon.svg            精细版矢量，现代浏览器优先使用
 *   /apple-touch-icon.png   180×180
 *
 * 用法：node tools/icons/build.mjs
 * 另外会在 .workbuddy/icon-preview.png 生成一张 6× 预览拼图（git 忽略），用于肉眼确认。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const ICON_SVG = path.join(HERE, 'icon.svg');
const SMALL_SVG = path.join(HERE, 'icon-small.svg');
const APPLE_SVG = path.join(HERE, 'apple-touch.svg');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SMALL_MAX = 24;

/* ────────────────────────── SVG 子集解析 ────────────────────────── */

const parseAttrs = (text) => {
    const attrs = {};
    // 注意属性名里可以带数字（x1 / y1 / x2 / y2），写成 [a-zA-Z-]+ 会把这些漏掉，
    // 渐变退化成一个点、整块底色变成单色 —— 曾经就是这么踩的。
    for (const m of text.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2];
    return attrs;
};

const hexToRgb = (hex) => {
    let h = hex.replace('#', '').trim();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
};

const num = (attrs, key, fallback = 0) => (attrs[key] !== undefined ? parseFloat(attrs[key]) : fallback);

const rectFrom = (attrs) => ({
    x: num(attrs, 'x'),
    y: num(attrs, 'y'),
    w: num(attrs, 'width'),
    h: num(attrs, 'height'),
    r: num(attrs, 'rx', 0),
});

/** path 的 d 只支持绝对 M / L / V / H / Z（本项目的字形就只用这些），返回折线点列 */
function parsePolyline(d) {
    const tokens = [];
    for (const m of d.matchAll(/[MLVHZ]|-?\d*\.?\d+/g)) tokens.push(m[0]);

    const points = [];
    let mode = null;
    let cur = [0, 0];
    let nums = [];
    const flush = () => {
        if (!nums.length) return;
        if (mode === 'M' || mode === 'L') {
            // M 之后的连续数字对按 L 处理，这正是 SVG 的隐式续写规则
            for (let i = 0; i + 1 < nums.length; i += 2) {
                cur = [nums[i], nums[i + 1]];
                points.push(cur);
            }
        } else if (mode === 'V') {
            for (const v of nums) {
                cur = [cur[0], v];
                points.push(cur);
            }
        } else if (mode === 'H') {
            for (const v of nums) {
                cur = [v, cur[1]];
                points.push(cur);
            }
        }
        nums = [];
    };

    for (const token of tokens) {
        if (/[MLVHZ]/.test(token)) {
            flush();
            mode = token === 'Z' ? null : token;
        } else {
            nums.push(parseFloat(token));
        }
    }
    flush();

    if (points.length < 2) throw new Error(`path 解析出的点不够：${d}`);
    return points;
}

/** 有符号距离场：圆角矩形，<0 在内部 */
function sdRoundedRect(x, y, rect) {
    const hw = rect.w / 2;
    const hh = rect.h / 2;
    const cx = rect.x + hw;
    const cy = rect.y + hh;
    const r = Math.min(rect.r || 0, hw, hh);
    const qx = Math.abs(x - cx) - (hw - r);
    const qy = Math.abs(y - cy) - (hh - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function distToPolyline(x, y, points) {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1];
        const [bx, by] = points[i];
        const abx = bx - ax;
        const aby = by - ay;
        const len2 = abx * abx + aby * aby || 1;
        let t = ((x - ax) * abx + (y - ay) * aby) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(x - (ax + abx * t), y - (ay + aby * t));
        if (d < best) best = d;
    }
    return best;
}

/**
 * 把一份 SVG 解析成「按绘制顺序排列的图层」。
 * 图层 = { clip, shape, paint }，shape 负责点命中判断，paint 负责取色。
 */
function parseSvg(text) {
    const gradients = {};
    for (const m of text.matchAll(/<linearGradient\b([^>]*)>([\s\S]*?)<\/linearGradient>/g)) {
        const attrs = parseAttrs(m[1]);
        const stops = [...m[2].matchAll(/<stop\b([^>]*)\/>/g)].map((s) => {
            const a = parseAttrs(s[1]);
            return {
                offset: parseFloat(a.offset),
                rgb: hexToRgb(a['stop-color']),
                alpha: a['stop-opacity'] !== undefined ? parseFloat(a['stop-opacity']) : 1,
            };
        }).sort((p, q) => p.offset - q.offset);
        gradients[attrs.id] = {
            x1: num(attrs, 'x1'),
            y1: num(attrs, 'y1'),
            x2: num(attrs, 'x2'),
            y2: num(attrs, 'y2'),
            stops,
        };
    }

    const clips = {};
    for (const m of text.matchAll(/<clipPath\b([^>]*)>([\s\S]*?)<\/clipPath>/g)) {
        const attrs = parseAttrs(m[1]);
        const rect = m[2].match(/<rect\b([^>]*)\/>/);
        clips[attrs.id] = rectFrom(parseAttrs(rect[1]));
    }

    const body = text.replace(/<defs>[\s\S]*?<\/defs>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const layers = [];
    const clipStack = [];

    const tagRe = /<(\/?)(g|rect|circle|path)([^>]*?)(\/?)>/g;
    let m;
    while ((m = tagRe.exec(body))) {
        const closing = m[1] === '/';
        const tag = m[2];
        const attrs = parseAttrs(m[3]);
        if (tag === 'g') {
            if (closing) {
                clipStack.pop();
            } else if (m[4] === '/') {
                // 自闭合 <g/> 不会出现，忽略
            } else {
                const clipRef = (attrs['clip-path'] || '').match(/url\(#([^)]+)\)/);
                clipStack.push(clipRef ? clips[clipRef[1]] : null);
            }
            continue;
        }

        const clip = clipStack.length ? clipStack[clipStack.length - 1] : null;
        const push = (shape, paint) => layers.push({ clip, shape, paint });

        if (tag === 'rect') {
            const rect = rectFrom(attrs);
            if (attrs.fill !== 'none') {
                const paint = resolvePaint(attrs, 'fill', gradients);
                if (paint) push({ kind: 'rectFill', rect }, paint);
            }
            if (attrs.stroke && attrs.stroke !== 'none') {
                const paint = resolvePaint(attrs, 'stroke', gradients);
                if (paint) push({ kind: 'rectStroke', rect, width: num(attrs, 'stroke-width', 1) }, paint);
            }
        } else if (tag === 'circle') {
            if (attrs.fill !== 'none') {
                const paint = resolvePaint(attrs, 'fill', gradients);
                if (paint) {
                    push({ kind: 'circle', cx: num(attrs, 'cx'), cy: num(attrs, 'cy'), r: num(attrs, 'r') }, paint);
                }
            }
        } else if (tag === 'path') {
            const points = parsePolyline(attrs.d);
            if (attrs.stroke && attrs.stroke !== 'none') {
                const paint = resolvePaint(attrs, 'stroke', gradients);
                if (paint) push({ kind: 'stroke', points, width: num(attrs, 'stroke-width', 1) }, paint);
            }
            if (attrs.fill && attrs.fill !== 'none') {
                const paint = resolvePaint(attrs, 'fill', gradients);
                if (paint) push({ kind: 'polygonFill', points }, paint); // 本项目未用到，留个明确的失败点
            }
        }
    }

    if (!layers.length) throw new Error('SVG 里没解析出任何图层');
    return { layers };
}

function resolvePaint(attrs, which, gradients) {
    const opacity = num(attrs, `${which}-opacity`, 1);
    const value = attrs[which];
    if (!value) return null;
    const gradientRef = value.match(/url\(#([^)]+)\)/);
    if (gradientRef) {
        const gradient = gradients[gradientRef[1]];
        if (!gradient) throw new Error(`找不到渐变 #${gradientRef[1]}`);
        return { kind: 'gradient', gradient, opacity };
    }
    return { kind: 'solid', rgb: hexToRgb(value), alpha: opacity };
}

/* ────────────────────────── 取色与命中 ────────────────────────── */

function gradientAt(gradient, x, y) {
    const dx = gradient.x2 - gradient.x1;
    const dy = gradient.y2 - gradient.y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((x - gradient.x1) * dx + (y - gradient.y1) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const stops = gradient.stops;
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i].offset) {
            const a = stops[i - 1];
            const b = stops[i];
            const k = (t - a.offset) / (b.offset - a.offset || 1);
            return [
                a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k,
                a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k,
                a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k,
                a.alpha + (b.alpha - a.alpha) * k,
            ];
        }
    }
    const last = stops[stops.length - 1];
    return [last.rgb[0], last.rgb[1], last.rgb[2], last.alpha];
}

function hit(shape, x, y) {
    switch (shape.kind) {
        case 'rectFill':
            return sdRoundedRect(x, y, shape.rect) <= 0;
        case 'rectStroke':
            return Math.abs(sdRoundedRect(x, y, shape.rect)) <= shape.width / 2;
        case 'circle':
            return Math.hypot(x - shape.cx, y - shape.cy) <= shape.r;
        case 'stroke':
            return distToPolyline(x, y, shape.points) <= shape.width / 2;
        case 'polygonFill':
            throw new Error('polygonFill 不在本渲染器支持范围内');
        default:
            return false;
    }
}

/** 单点采样：按图层顺序 source-over，返回 premultiplied RGBA */
function sample(svg, x, y) {
    let pr = 0;
    let pg = 0;
    let pb = 0;
    let pa = 0;
    for (const layer of svg.layers) {
        if (layer.clip && sdRoundedRect(x, y, layer.clip) > 0) continue;
        if (!hit(layer.shape, x, y)) continue;
        let r;
        let g;
        let b;
        let a;
        if (layer.paint.kind === 'solid') {
            [r, g, b] = layer.paint.rgb;
            a = layer.paint.alpha;
        } else {
            const c = gradientAt(layer.paint.gradient, x, y);
            r = c[0];
            g = c[1];
            b = c[2];
            a = c[3] * layer.paint.opacity;
        }
        if (a <= 0) continue;
        pr = r * a + pr * (1 - a);
        pg = g * a + pg * (1 - a);
        pb = b * a + pb * (1 - a);
        pa = a + pa * (1 - a);
    }
    return [pr, pg, pb, pa];
}

/* ────────────────────────── 光栅化 ────────────────────────── */

function rasterize(svg, size, grid = 64) {
    const scale = size / grid;
    const SS = size <= 48 ? 8 : size <= 128 ? 6 : 4;
    const samples = SS * SS;
    const out = Buffer.alloc(size * size * 4);

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let pr = 0;
            let pg = 0;
            let pb = 0;
            let pa = 0;
            for (let sy = 0; sy < SS; sy++) {
                const y = (py + (sy + 0.5) / SS) / scale;
                for (let sx = 0; sx < SS; sx++) {
                    const x = (px + (sx + 0.5) / SS) / scale;
                    const c = sample(svg, x, y);
                    pr += c[0];
                    pg += c[1];
                    pb += c[2];
                    pa += c[3];
                }
            }
            const i = (py * size + px) * 4;
            if (pa <= 0) continue;
            out[i] = Math.round((pr / pa) * 255);
            out[i + 1] = Math.round((pg / pa) * 255);
            out[i + 2] = Math.round((pb / pa) * 255);
            out[i + 3] = Math.round((pa / samples) * 255);
        }
    }
    return out;
}

/* ────────────────────────── PNG 编码 ────────────────────────── */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        raw[y * stride] = 0; // filter: none
        rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/* ────────────────────────── ICO 打包 ────────────────────────── */

/**
 * ICO = 6 字节文件头 + 每档 16 字节目录 + 各档 PNG 数据。
 * ICO 里存 PNG 是 Vista 起写进规范的做法，Chrome / Edge / Firefox / Safari 和
 * Windows 资源管理器都认，所以在 Node 里不必把 PNG 解成 BMP 再塞进去。
 * 宽高字段只有 1 字节，256 写 0。
 */
function packIco(entries) {
    const sorted = [...entries].sort((a, b) => a.size - b.size);
    const HEADER = 6;
    const DIR = 16;
    let offset = HEADER + DIR * sorted.length;

    const header = Buffer.alloc(HEADER);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2); // 1 = icon
    header.writeUInt16LE(sorted.length, 4);

    const dir = Buffer.alloc(DIR * sorted.length);
    sorted.forEach((entry, i) => {
        const base = i * DIR;
        const dim = entry.size >= 256 ? 0 : entry.size;
        dir.writeUInt8(dim, base + 0);
        dir.writeUInt8(dim, base + 1);
        dir.writeUInt8(0, base + 2);
        dir.writeUInt8(0, base + 3);
        dir.writeUInt16LE(1, base + 4);
        dir.writeUInt16LE(32, base + 6);
        dir.writeUInt32LE(entry.png.length, base + 8);
        dir.writeUInt32LE(offset, base + 12);
        offset += entry.png.length;
    });

    return Buffer.concat([header, dir, ...sorted.map((e) => e.png)]);
}

/* ────────────────────────── 预览拼图 ────────────────────────── */

/**
 * 整数倍最近邻放大并排成一张图：16px 有没有糊，肉眼一眼能看出来。
 * @param {Record<string, Buffer>} renders 尺寸 → RGBA
 * @param {number} zoom 放大倍数
 */
function previewSheet(renders, zoom = 6) {
    const gap = 10;
    const images = Object.entries(renders).map(([size, rgba]) => ({ size: Number(size), rgba }));
    const width = images.reduce((sum, img) => sum + img.size * zoom + gap, gap);
    const height = Math.max(...images.map((img) => img.size * zoom)) + gap * 2;
    const sheet = Buffer.alloc(width * height * 4);

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const light = ((x >> 3) + (y >> 3)) % 2 === 0;
            const v = light ? 0xe9 : 0xcf;
            const i = (y * width + x) * 4;
            sheet[i] = v;
            sheet[i + 1] = v;
            sheet[i + 2] = v;
            sheet[i + 3] = 255;
        }
    }

    let xOff = gap;
    for (const img of images) {
        const drawSize = img.size * zoom;
        const yOff = Math.round(gap + (height - gap * 2 - drawSize) / 2);
        for (let y = 0; y < drawSize; y++) {
            for (let x = 0; x < drawSize; x++) {
                const si = (Math.floor(y / zoom) * img.size + Math.floor(x / zoom)) * 4;
                const a = img.rgba[si + 3] / 255;
                if (a <= 0) continue;
                const di = ((yOff + y) * width + xOff + x) * 4;
                for (let c = 0; c < 3; c++) sheet[di + c] = Math.round(img.rgba[si + c] * a + sheet[di + c] * (1 - a));
                sheet[di + 3] = 255;
            }
        }
        xOff += drawSize + gap;
    }
    return { width, height, pixels: sheet };
}

/* ────────────────────────── 主流程 ────────────────────────── */

const main = () => {
    const detailed = parseSvg(fs.readFileSync(ICON_SVG, 'utf8'));
    const small = parseSvg(fs.readFileSync(SMALL_SVG, 'utf8'));
    const apple = parseSvg(fs.readFileSync(APPLE_SVG, 'utf8'));

    const report = [];
    const entries = [];
    const renders = {};

    for (const size of ICO_SIZES) {
        const rgba = rasterize(size <= SMALL_MAX ? small : detailed, size);
        entries.push({ size, png: encodePng(size, size, rgba) });
        if ([16, 24, 32, 64, 128, 256].includes(size)) renders[size] = rgba;
    }

    const ico = packIco(entries);
    fs.writeFileSync(path.join(REPO_ROOT, 'favicon.ico'), ico);
    report.push(`favicon.ico             ${ico.length} B，含 ${ICO_SIZES.join('/')}px`);

    // 矢量版直接就是精细版源文件，不再生成第二份（避免两份源各自漂移）
    fs.copyFileSync(ICON_SVG, path.join(REPO_ROOT, 'favicon.svg'));
    report.push('favicon.svg             （= tools/icons/icon.svg）');

    const applePng = encodePng(180, 180, rasterize(apple, 180));
    fs.writeFileSync(path.join(REPO_ROOT, 'apple-touch-icon.png'), applePng);
    report.push(`apple-touch-icon.png    ${applePng.length} B，180×180 满铺`);

    try {
        const preview = previewSheet(renders);
        fs.writeFileSync(path.join(REPO_ROOT, '.workbuddy', 'icon-preview.png'),
            encodePng(preview.width, preview.height, preview.pixels));

        // 小尺寸单独再来一张 14× 的：16px 在浏览器标签页里就是这个观感，
        // 它糊不糊，6× 拼图上看不准。
        const smallRenders = { 16: renders[16], 24: renders[24], 32: renders[32] };
        const smallPreview = previewSheet(smallRenders, 14);
        fs.writeFileSync(path.join(REPO_ROOT, '.workbuddy', 'icon-preview-small.png'),
            encodePng(smallPreview.width, smallPreview.height, smallPreview.pixels));

        report.push(`.workbuddy/icon-preview.png  ${preview.width}×${preview.height}，6× 预览`);
        report.push(`.workbuddy/icon-preview-small.png  16/24/32px 的 14× 预览`);
    } catch (err) {
        report.push(`（预览拼图跳过：${err.message}）`);
    }

    console.log(report.join('\n'));
};

main();
