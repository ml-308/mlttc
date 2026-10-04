// src/pages/tool-dev.js
/**
 * 开发者工具箱（/tool-dev.html）的交互逻辑
 *
 * 职责：
 *   1. JSON 格式化 / 压缩 / 校验（统计类型、层级、键数，出错给出原因）
 *   2. 二 / 八 / 十 / 十六进制实时互转（BigInt 精确换算，含位宽与 32 位视图）
 *   3. 正则表达式测试（匹配位置、匹配内容与捕获分组）
 *   4. 颜色代码转换（#abc / #aabbcc / rgb() / hsl() → HEX / RGB / HSL 与实时预览）
 *
 * 依赖：/lib/ui/message.mjs、./tool-utils.mjs
 * 全程本地运算，不上传数据。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { $, copyText } from './tool-utils.mjs';

/* =====================================================================
 * 共用小工具
 * ===================================================================== */

/**
 * 往结果卡片里写一行：<strong>标题</strong><code>内容</code>…
 * 全部用 textContent 写入，避免把输入内容当 HTML 解析
 */
function row(box, title, codes) {
    const p = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = title + ' ';
    p.appendChild(strong);
    (Array.isArray(codes) ? codes : [codes]).forEach((c) => {
        const code = document.createElement('code');
        code.textContent = String(c);
        p.appendChild(code);
    });
    box.appendChild(p);
}

/**
 * 列表页用 tool-dev.html#json 这样的锚点直达某张卡片，
 * 这里把目标卡片滚动到吸顶页头的正下方
 */
function scrollToHash() {
    const id = location.hash.slice(1);
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    const header = document.querySelector('hcw-body-header');
    const offset = (header ? header.offsetHeight : 0) + 12;
    const top = el.getBoundingClientRect().top + window.scrollY - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

/* =====================================================================
 * 1. JSON 格式化
 * ===================================================================== */

/**
 * 递归统计嵌套深度与「对象键 + 数组元素」总数
 * @param {*} data 已通过 JSON.parse 的数据
 * @returns {{depth:number, items:number}}
 */
function jsonStatOf(data) {
    const info = { depth: 0, items: 0 };
    (function walk(node, depth) {
        if (depth > info.depth) info.depth = depth;
        if (Array.isArray(node)) {
            info.items += node.length;
            node.forEach((x) => walk(x, depth + 1));
        } else if (node && typeof node === 'object') {
            Object.keys(node).forEach((k) => {
                info.items += 1;
                walk(node[k], depth + 1);
            });
        }
    })(data, 1);
    return info;
}

/** 顶层数据的类型描述，如「对象 object」「数组 array」「number 3」 */
function jsonTypeName(data) {
    if (data === null) return 'null';
    if (Array.isArray(data)) return '数组 array';
    if (typeof data === 'object') return '对象 object';
    return typeof data + ' ' + JSON.stringify(data);
}

/** mode：2 / 4 = 缩进空格数，'min' = 压缩，'check' = 仅校验 */
function jsonRun(mode) {
    const raw = $('jsonIn').value;
    const box = $('jsonStat');
    if (!raw.trim()) {
        showMessage('请先输入 JSON 文本', true);
        return;
    }
    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        box.classList.remove('hidden');
        box.innerHTML = '';
        row(box, '解析失败', [err.message]);
        showMessage('JSON 格式有误', true);
        return;
    }
    if (mode !== 'check') {
        $('jsonOut').value = JSON.stringify(data, null, mode === 'min' ? 0 : mode);
    }
    const info = jsonStatOf(data);
    box.classList.remove('hidden');
    box.innerHTML = '';
    row(box, '状态', ['校验通过']);
    row(box, '类型', jsonTypeName(data));
    row(box, '嵌套深度', info.depth + ' 层');
    row(box, '键 / 数组项', info.items + ' 个');
    row(box, '原文字符', raw.length + ' 个');
    showMessage(mode === 'check' ? 'JSON 校验通过' : '已格式化到输出框');
}

/* =====================================================================
 * 2. 进制转换
 * ===================================================================== */

const RX_FIELDS = [['rx2', 2], ['rx8', 8], ['rx10', 10], ['rx16', 16]];
const RX_MAX_LEN = 64;   // 超长串直接拒绝，避免 BigInt 卡顿

/**
 * 解析某个进制的输入为 BigInt；空白 / 非法返回 null（表示「还没输完」）
 * @param {string} raw 用户输入
 * @param {number} base 进制
 * @returns {bigint|null}
 */
function parseRadix(raw, base) {
    let s = String(raw).replace(/[\s_]/g, '');
    if (!s) return null;
    let neg = false;
    if (s[0] === '-' || s[0] === '+') {
        neg = s[0] === '-';
        s = s.slice(1);
    }
    if (!s || s.length > RX_MAX_LEN) return null;
    const low = s.toLowerCase();
    if (base === 2 && low.slice(0, 2) === '0b') s = s.slice(2);
    else if (base === 8 && low.slice(0, 2) === '0o') s = s.slice(2);
    else if (base === 16 && low.slice(0, 2) === '0x') s = s.slice(2);
    if (!s) return null;
    const pat = { 2: /^[01]+$/, 8: /^[0-7]+$/, 10: /^[0-9]+$/, 16: /^[0-9a-fA-F]+$/ }[base];
    if (!pat.test(s)) return null;
    if (base !== 16) s = s.replace(/^0+(?=\d)/, '');   // 去前导零，防止前导零被当八进制
    let v;
    try {
        v = BigInt(base === 2 ? '0b' + s : base === 8 ? '0o' + s : base === 16 ? '0x' + s : s);
    } catch (e) {
        return null;
    }
    return neg ? -v : v;
}

/**
 * BigInt → 指定进制的展示串：十六进制大写，二进制超过 8 位按 8 位补零分组
 * @param {bigint} v
 * @param {number} base
 * @returns {string}
 */
function rxFormat(v, base) {
    const neg = v < 0n;
    const a = neg ? -v : v;
    let s = a.toString(base).toUpperCase();
    if (base === 2 && s.length > 8) {
        s = s.padStart(Math.ceil(s.length / 8) * 8, '0');
        s = s.replace(/(.{8})(?=.)/g, '$1 ');
    }
    return (neg ? '-' : '') + s;
}

/** 位宽、32 位视图与安全整数提示 */
function rxRenderInfo(v) {
    const box = $('rxInfo');
    const a = v < 0n ? -v : v;
    const bits = a === 0n ? 1 : a.toString(2).length;
    box.classList.remove('hidden');
    box.innerHTML = '';
    row(box, '位宽 / 字节', [bits + ' 位', Math.ceil(bits / 8) + ' 字节']);
    row(box, '32 位有符号', v >= -2147483648n && v <= 2147483647n
        ? String(BigInt.asIntN(32, v))
        : '超出范围');
    row(box, '32 位无符号', v >= 0n && v <= 4294967295n
        ? '0x' + BigInt.asUintN(32, v).toString(16).toUpperCase()
        : '超出范围');
    row(box, 'Number 精度', a <= 9007199254740991n
        ? '可被 Number 精确表示'
        : '已超出安全整数，仍按 BigInt 精确换算');
}

/** 由某一格输入同步其余进制；输入非法或为空时保持原样 */
function rxUpdate(fromBase, fromEl) {
    const v = parseRadix(fromEl.value, fromBase);
    if (v === null) return;
    RX_FIELDS.forEach((pair) => {
        if (pair[1] === fromBase) return;
        $(pair[0]).value = rxFormat(v, pair[1]);
    });
    rxRenderInfo(v);
}

/* =====================================================================
 * 3. 颜色解析与换算
 * ===================================================================== */

function clamp255(n) {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * HSL → RGB
 * @param {number} h 色相 0-360
 * @param {number} s 饱和度 0-100
 * @param {number} l 亮度 0-100
 * @returns {{r:number,g:number,b:number}}
 */
function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255)
    };
}

/**
 * RGB → HSL
 * @returns {{h:number,s:number,l:number}} h 0-360，s / l 为 0-100 的整数
 */
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * 解析颜色字符串（#abc / #aabbcc / #aarrggbb / rgb() / rgba() / hsl() / hsla()）
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
function parseColor(raw) {
    const s = String(raw == null ? '' : raw).trim().toLowerCase();
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (m) {
        let h = m[1];
        if (h.length === 3) h = h.split('').map((c) => c + c).join('');
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
            a: h.length === 8 ? Math.round(parseInt(h.slice(6, 8), 16) / 255 * 1000) / 1000 : 1
        };
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (m) {
        let a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (a > 1 && a <= 100) a = a / 100;
        return {
            r: clamp255(parseFloat(m[1])),
            g: clamp255(parseFloat(m[2])),
            b: clamp255(parseFloat(m[3])),
            a: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1
        };
    }
    m = /^hsla?\(\s*([\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (m) {
        const out = hslToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
        let a = m[4] === undefined ? 1 : parseFloat(m[4]);
        if (a > 1 && a <= 100) a = a / 100;
        out.a = Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1;
        return out;
    }
    return null;
}

/* =====================================================================
 * 页面交互
 * ===================================================================== */
document.addEventListener('DOMContentLoaded', () => {
    if (!$('jsonIn')) return;

    // ---------- 1. JSON ----------
    $('jsonFmt2').addEventListener('click', () => jsonRun(2));
    $('jsonFmt4').addEventListener('click', () => jsonRun(4));
    $('jsonMin').addEventListener('click', () => jsonRun('min'));
    $('jsonCheck').addEventListener('click', () => jsonRun('check'));
    $('jsonCopy').addEventListener('click', () => {
        if (!$('jsonOut').value) { showMessage('还没有输出内容', true); return; }
        copyText($('jsonOut').value);
    });
    $('jsonToIn').addEventListener('click', () => {
        if (!$('jsonOut').value) { showMessage('还没有输出内容', true); return; }
        $('jsonIn').value = $('jsonOut').value;
        showMessage('已送回输入框');
    });
    $('jsonClear').addEventListener('click', () => {
        $('jsonIn').value = '';
        $('jsonOut').value = '';
        $('jsonStat').classList.add('hidden');
        $('jsonStat').innerHTML = '';
        showMessage('已清空');
    });

    // ---------- 2. 进制转换 ----------
    RX_FIELDS.forEach((pair) => {
        const el = $(pair[0]);
        el.addEventListener('input', () => rxUpdate(pair[1], el));
    });
    rxUpdate(10, $('rx10'));   // 页面默认十进制为 10，先同步一遍

    $('rxCopy').addEventListener('click', () => {
        const v = $('rx10').value.replace(/[\s_]/g, '');
        if (!v) { showMessage('还没有可复制的数字', true); return; }
        copyText(v);
    });
    $('rxRand').addEventListener('click', () => {
        const buf = new Uint32Array(1);
        crypto.getRandomValues(buf);
        $('rx10').value = String(buf[0]);
        rxUpdate(10, $('rx10'));
        showMessage('已生成随机数');
    });
    $('rxClear').addEventListener('click', () => {
        RX_FIELDS.forEach((pair) => { $(pair[0]).value = ''; });
        const box = $('rxInfo');
        box.classList.remove('hidden');
        box.innerHTML = '';
        row(box, '提示', ['输入任意一格即可实时换算']);
        showMessage('已清空');
    });

    // ---------- 3. 正则测试 ----------
    let reMatches = [];

    $('reGo').addEventListener('click', () => {
        const pat = $('rePat').value;
        if (!pat) { showMessage('请输入正则表达式', true); return; }
        const flags = $('reFlags').value.replace(/\s+/g, '');
        let re;
        try {
            re = new RegExp(pat, flags);
        } catch (err) {
            showMessage('正则有误：' + err.message, true);
            return;
        }
        const text = $('reText').value;
        reMatches = [];
        if (flags.indexOf('g') >= 0) {
            let m;
            let guard = 0;
            while ((m = re.exec(text)) !== null) {
                reMatches.push(m);
                if (m[0] === '') re.lastIndex += 1;   // 零宽匹配防死循环
                if (++guard > 5000) break;
            }
        } else {
            const m = re.exec(text);
            if (m) reMatches.push(m);
        }

        const out = $('reOut');
        out.classList.remove('hidden');
        out.innerHTML = '';
        if (!reMatches.length) {
            row(out, '结果', ['没有找到匹配']);
            showMessage('没有找到匹配', true);
            return;
        }
        row(out, '匹配数量', reMatches.length + ' 条');
        reMatches.slice(0, 100).forEach((m, i) => {
            const codes = ['位置 ' + m.index, '"' + m[0] + '"'];
            for (let g = 1; g < m.length; g++) {
                codes.push('分组' + g + '=' + (m[g] === undefined ? '未参与匹配' : '"' + m[g] + '"'));
            }
            row(out, '#' + (i + 1), codes);
        });
        if (reMatches.length > 100) row(out, '提示', ['仅展示前 100 条，复制可获得全部']);
        showMessage('找到 ' + reMatches.length + ' 条匹配');
    });

    $('reCopy').addEventListener('click', () => {
        if (!reMatches.length) { showMessage('还没有匹配结果', true); return; }
        copyText(reMatches.map((m) => m[0]).join('\n'));
    });

    $('reClear').addEventListener('click', () => {
        $('rePat').value = '';
        $('reFlags').value = 'g';
        $('reText').value = '';
        reMatches = [];
        $('reOut').classList.add('hidden');
        $('reOut').innerHTML = '';
        showMessage('已清空');
    });

    // ---------- 4. 颜色转换 ----------
    /** 解析并渲染预览 + 换算结果；无效返回 null */
    function colorUpdate() {
        const box = $('colBox');
        const out = $('colOut');
        const c = parseColor($('colIn').value);
        if (!c) {
            box.classList.add('hidden');
            out.classList.add('hidden');
            return null;
        }
        const hex = '#' + [c.r, c.g, c.b]
            .map((x) => x.toString(16).padStart(2, '0'))
            .join('')
            .toUpperCase();
        const alpha = Math.round(c.a * 1000) / 1000;
        const rgbStr = 'rgb(' + c.r + ', ' + c.g + ', ' + c.b + ')';
        const shown = alpha < 1 ? 'rgba(' + c.r + ', ' + c.g + ', ' + c.b + ', ' + alpha + ')' : rgbStr;
        const hsl = rgbToHsl(c.r, c.g, c.b);
        const hslStr = 'hsl(' + hsl.h + ', ' + hsl.s + '%, ' + hsl.l + '%)';

        // 预览块：按亮度切换前景色保证文字可读（背景由 JS 动态设置）
        box.classList.remove('hidden');
        box.style.background = shown;
        box.style.color = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b > 140 ? '#1d1d1f' : '#ffffff';
        box.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = '预览　' + hex + (alpha < 1 ? '（透明度 ' + Math.round(alpha * 100) + '%）' : '');
        box.appendChild(p);

        out.classList.remove('hidden');
        out.innerHTML = '';
        row(out, 'HEX', hex);
        row(out, 'RGB', rgbStr);
        if (alpha < 1) row(out, 'RGBA', shown);
        row(out, 'HSL', hslStr);
        row(out, 'CSS', 'background: ' + shown + ';');
        return hex;
    }

    $('colIn').addEventListener('input', colorUpdate);
    $('colRand').addEventListener('click', () => {
        const buf = new Uint8Array(3);
        crypto.getRandomValues(buf);
        $('colIn').value = '#' + Array.from(buf)
            .map((x) => x.toString(16).padStart(2, '0'))
            .join('');
        colorUpdate();
    });
    $('colCopy').addEventListener('click', () => {
        const hex = colorUpdate();
        if (!hex) { showMessage('当前颜色值无法识别', true); return; }
        copyText(hex);
    });
    colorUpdate();   // 页面默认值 #0071e3 直接渲染

    // 从列表页锚点进入时，滚动到对应卡片
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
});
