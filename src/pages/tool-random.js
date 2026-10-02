// src/pages/tool-random.js
/**
 * 随机与抽签（/tool-random.html）的交互逻辑
 *
 * 职责：
 *   1. 随机整数：可设区间、个数，支持「不重复抽取」
 *   2. 名单抽签：按行 / 逗号 / 顿号拆分名单，抽完不放回或逐个独立抽取
 *   3. 名单随机排序（洗牌）
 *
 * 随机源用 crypto.getRandomValues（拒绝采样无偏），全程本地运算。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { $, copyText } from './tool-utils.mjs';

/** 取 [0, max) 的无偏随机整数 */
function randInt(max) {
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let v;
    do {
        crypto.getRandomValues(buf);
        v = buf[0];
    } while (v >= limit);
    return v % max;
}

/** Fisher-Yates 洗牌 */
function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = randInt(i + 1);
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
    }
    return arr;
}

/** 把一组结果渲染成 code 小块 */
function renderCodes(box, items, prefix) {
    box.innerHTML = '';
    items.forEach((text, i) => {
        const p = document.createElement('p');
        const strong = document.createElement('strong');
        strong.textContent = (prefix || '') + (i + 1) + '. ';
        const code = document.createElement('code');
        code.textContent = text;
        p.appendChild(strong);
        p.appendChild(code);
        box.appendChild(p);
    });
    box.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
    const rdOut = $('rdOut');
    const drawOut = $('drawOut');
    if (!rdOut || !drawOut) return;
    let lastNumbers = [];
    let lastNames = [];

    /** 读取整数输入，附带范围校验 */
    function readInt(id, fallback) {
        const v = Number($(id).value);
        if (!Number.isFinite(v)) return fallback;
        return Math.floor(v);
    }

    // ---------- 1. 随机整数 ----------
    $('rdGoBtn').addEventListener('click', () => {
        const min = readInt('rdMin', 1);
        const max = readInt('rdMax', 100);
        if (max < min) {
            showMessage('最大值不能小于最小值', true);
            return;
        }
        let count = readInt('rdCount', 1);
        if (count < 1) count = 1;
        if (count > 100) count = 100;
        $('rdCount').value = String(count);

        const span = max - min + 1;
        const unique = $('rdMode').value === 'unique';
        if (unique && count > span) {
            showMessage('不重复抽取时，个数不能超过 ' + span, true);
            return;
        }

        lastNumbers = [];
        if (unique) {
            // 区间较大时用洗牌代价高，改用 Set 逐个抽样
            const picked = new Set();
            while (picked.size < count) {
                const v = min + randInt(span);
                if (!picked.has(v)) picked.add(v);
            }
            lastNumbers = Array.from(picked);
        } else {
            for (let i = 0; i < count; i++) lastNumbers.push(min + randInt(span));
        }
        renderCodes(rdOut, lastNumbers.map(String), '第 ');
        showMessage('已生成 ' + count + ' 个随机数');
    });

    $('rdCopyBtn').addEventListener('click', () => copyText(lastNumbers.join(', ')));

    // ---------- 2. 名单抽签 ----------
    /** 按行 / 中英文逗号 / 顿号 / 分号 / 空白 拆名单 */
    function readNames() {
        return $('nameList').value
            .split(/[\n\r,，、;；\t]+/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    }

    $('drawBtn').addEventListener('click', () => {
        const names = readNames();
        if (!names.length) {
            showMessage('名单是空的，先输入一些名字', true);
            return;
        }
        let count = readInt('drawCount', 1);
        if (count < 1) count = 1;
        if (count > 100) count = 100;
        $('drawCount').value = String(count);

        const once = $('drawMode').value === 'once';
        if (once && count > names.length) {
            showMessage('名单只有 ' + names.length + ' 个人，抽不出 ' + count + ' 个', true);
            return;
        }

        const pool = shuffle(names.slice());
        const picked = [];
        if (once) {
            for (let i = 0; i < count; i++) picked.push(pool[i]);
        } else {
            for (let i = 0; i < count; i++) picked.push(names[randInt(names.length)]);
        }
        lastNames = picked;
        renderCodes(drawOut, picked, '抽中 ');
        showMessage('抽签完成');
    });

    $('shuffleBtn').addEventListener('click', () => {
        const names = readNames();
        if (names.length < 2) {
            showMessage('至少需要两个名字才能排序', true);
            return;
        }
        const shuffled = shuffle(names.slice());
        lastNames = shuffled;
        renderCodes(drawOut, shuffled, '第 ');
        showMessage('已随机排序');
    });

    $('drawCopyBtn').addEventListener('click', () => copyText(lastNames.join('\n')));

    $('drawClearBtn').addEventListener('click', () => {
        $('nameList').value = '';
        lastNames = [];
        drawOut.innerHTML = '';
        drawOut.classList.add('hidden');
        showMessage('已清空');
    });
});
