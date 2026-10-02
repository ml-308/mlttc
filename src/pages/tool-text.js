// src/pages/tool-text.js
/**
 * 文本工具箱（/tool-text.html）的交互逻辑
 *
 * 职责：
 *   1. 输入文本的实时统计（字符 / 中文 / 单词 / 行数 / 阅读时间）
 *   2. 处理按钮：去空行、按行去重、排序、大小写、整段反转、JSON、Base64、URL
 *   3. 查找替换（可在输入框内替换，也可只把结果写进输出框）
 *   4. 输出区：复制 / 回填输入 / 交换 / 清空
 *
 * 约定：所有处理结果都写入 #textOut；出错时保留原输出并弹 toast 提示。
 * 全部为浏览器本地运算，文本不会上传服务器。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { $, splitLines, copyText } from './tool-utils.mjs';

/** UTF-8 安全的 Base64 编码 */
function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin);
}

/** UTF-8 安全的 Base64 解码 */
function b64decode(str) {
    const bin = atob(str.trim());
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

/** 各处理按钮对应的函数：入参为输入框文本，返回要写入输出框的文本（null 表示失败） */
const OPS = {
    // 去掉空行 + 每行首尾空格
    clean(text) {
        return splitLines(text)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .join('\n');
    },
    // 按行去重（保留首次出现的顺序）
    dedupe(text) {
        const seen = new Set();
        const out = [];
        splitLines(text).forEach((line) => {
            if (!seen.has(line)) {
                seen.add(line);
                out.push(line);
            }
        });
        return out.join('\n');
    },
    // 按行排序（中文按拼音序）
    sort(text) {
        return splitLines(text).slice().sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')).join('\n');
    },
    upper(text) {
        return text.toUpperCase();
    },
    lower(text) {
        return text.toLowerCase();
    },
    // 整段反转（按字符而非按码元，避免拆坏 emoji / 生僻字）
    reverse(text) {
        return Array.from(text).reverse().join('');
    },
    json(text) {
        try {
            return JSON.stringify(JSON.parse(text), null, 2);
        } catch (err) {
            showMessage('JSON 解析失败：' + err.message, true);
            return null;
        }
    },
    b64enc(text) {
        return b64encode(text);
    },
    b64dec(text) {
        try {
            return b64decode(text);
        } catch (err) {
            return fail('Base64 解码失败，输入不是合法的 Base64');
        }
    },
    urlenc(text) {
        return encodeURIComponent(text);
    },
    urldec(text) {
        try {
            return decodeURIComponent(text);
        } catch (err) {
            return fail('URL 解码失败，输入不是合法的百分号编码');
        }
    },
};

/** 统一的失败出口：提示 + 返回 null（调用方据此保留原输出） */
function fail(msg) {
    showMessage(msg, true);
    return null;
}

/** 统计文本 */
function countText(text) {
    const chars = Array.from(text).length;
    const noSpace = text.replace(/\s/g, '').length;
    const zh = (text.match(/[一-龥]/g) || []).length;
    const words = (text.match(/[A-Za-z0-9]+/g) || []).length;
    const lines = text.length === 0 ? 0 : splitLines(text).length;
    // 估算：中文 400 字/分钟，英文 200 词/分钟
    let read = 0;
    if (noSpace > 0) read = Math.max(1, Math.ceil(zh / 400 + words / 200));
    return { chars, noSpace, zh, words, lines, read };
}

document.addEventListener('DOMContentLoaded', () => {
    const textIn = $('textIn');
    const textOut = $('textOut');
    if (!textIn || !textOut) return;

    // ---------- 1. 实时统计 ----------
    function renderStats() {
        const s = countText(textIn.value);
        $('stChars').textContent = String(s.chars);
        $('stNoSpace').textContent = String(s.noSpace);
        $('stZh').textContent = String(s.zh);
        $('stWords').textContent = String(s.words);
        $('stLines').textContent = String(s.lines);
        $('stRead').textContent = s.read + ' 分钟';
    }
    textIn.addEventListener('input', renderStats);
    renderStats();

    // ---------- 2. 处理按钮 ----------
    document.querySelectorAll('[data-op]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const name = btn.getAttribute('data-op');
            const fn = OPS[name];
            if (!fn) return;
            const result = fn(textIn.value);
            if (result === null || result === undefined) return;
            textOut.value = result;
            showMessage('已生成结果');
        });
    });

    // ---------- 3. 查找替换 ----------
    function doReplace(toOutput) {
        const find = $('findIn').value;
        if (!find) {
            showMessage('请先填写要查找的内容', true);
            return;
        }
        // 用 split/join 做字面量替换，避免正则转义与特殊字符问题
        const replaced = textIn.value.split(find).join($('replaceIn').value);
        if (toOutput) {
            textOut.value = replaced;
            showMessage('替换结果已写入输出框');
        } else {
            textIn.value = replaced;
            renderStats();
            showMessage('已在输入框内完成替换');
        }
    }
    $('replaceBtn').addEventListener('click', () => doReplace(false));
    $('replaceOutBtn').addEventListener('click', () => doReplace(true));

    // ---------- 4. 输出区 ----------
    $('copyOutBtn').addEventListener('click', () => copyText(textOut.value));

    $('toInputBtn').addEventListener('click', () => {
        if (!textOut.value) {
            showMessage('输出框还是空的', true);
            return;
        }
        textIn.value = textOut.value;
        renderStats();
        showMessage('输出已送回输入框');
    });

    $('swapBtn').addEventListener('click', () => {
        const tmp = textIn.value;
        textIn.value = textOut.value;
        textOut.value = tmp;
        renderStats();
    });

    $('clearBtn').addEventListener('click', () => {
        textIn.value = '';
        textOut.value = '';
        $('findIn').value = '';
        $('replaceIn').value = '';
        renderStats();
        showMessage('已清空');
    });
});
