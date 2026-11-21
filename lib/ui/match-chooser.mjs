// lib/ui/match-chooser.mjs
/**
 * 通用「输入框 + 匹配下拉」（与城市无关的版本）
 *
 * 结构参考 lib/ui/city-chooser.mjs，但把「省 / 市 / 车牌」等城市语义去掉，
 * 改成任意 { value, label, aliases } 条目都能匹配：
 *   - 字面匹配：完全相同 > 前缀 > 包含 > 顺序子序列
 *   - 拼音匹配：全拼 / 首字母（可复用城市数据的 pinyin 表）
 *   - 键盘：↑ ↓ 移动、Enter 选中、Esc 收起
 *   - 点击列表外部自动收起
 *
 * strict 模式（用于封闭字典，如燃料类型）：失焦时若输入内容不在候选里，
 * 自动回退到上次选中值（没有就清空），保证「只能从候选中选」。
 *
 * 与页面既有逻辑的衔接：所有程序化赋值（选中 / 回退 / 清空）都会派发
 * input 事件，因此「表单值收集」「红绿校验」「公司 → 车队联动」无需额外改造。
 *
 * 用法：
 *   import { createMatchChooser } from '/lib/ui/match-chooser.mjs';
 *
 *   const chooser = createMatchChooser({
 *       input: document.getElementById('fuel-type'),
 *       list: document.getElementById('fuel-type-list'),
 *       items: [{ value: '纯电动', label: '纯电动', aliases: [] }],
 *       strict: true,
 *       pinyin: { map, exceptions },
 *   });
 */

/** 下拉列表默认最多展示条数 */
export const DEFAULT_MAX_ITEMS = 10;

/** 全角转半角（中文输入法下常打出全角数字 / 字母） */
export function toHalfWidth(str) {
    return String(str == null ? '' : str)
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, ' ');
}

/** 匹配用的归一化：去括注、去空白与标点、转小写 */
export function normalizeText(str) {
    return toHalfWidth(str)
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[\s\-—_·・/\\,，。、;；:：!！?？'"“”‘’()（）[\]【】「」《》<>]/g, '')
        .toLowerCase();
}

/** 顺序子序列匹配（允许中间跳过字符），命中返回末位索引，否则 -1 */
function subsequenceIndex(haystack, needle) {
    let pos = 0;
    for (const ch of needle) {
        pos = haystack.indexOf(ch, pos);
        if (pos === -1) return -1;
        pos += 1;
    }
    return pos;
}

/** 拼 HTML 前的转义（候选文案来自 JSON，仍按不可信处理） */
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

/**
 * 把一个词换成拼音变体：full 全拼、short 首字母。
 * 多音字词（maps.exceptions）会产生多个变体。
 *
 * @param {string} text 中文
 * @param {{map: Object, exceptions: Object}} maps 拼音映射
 * @returns {Array<{full: string, short: string, altFull: string, altShort: string}>}
 */
function pinyinVariantsOf(text, maps) {
    let variants = [{ full: '', short: '' }];

    for (let i = 0; i < text.length; i += 1) {
        const two = text.slice(i, i + 2);
        let readings;
        if (maps.exceptions[two]) {
            readings = maps.exceptions[two];
            i += 1;
        } else {
            const one = maps.map[text[i]];
            readings = one ? [[one]] : [];
        }
        if (readings.length === 0) continue;

        const next = [];
        for (const variant of variants) {
            for (const syllables of readings) {
                next.push({
                    full: variant.full + syllables.join(''),
                    short: variant.short + syllables.map((s) => s[0]).join(''),
                });
            }
        }
        variants = next;
    }

    return variants.map((variant) => ({
        full: variant.full,
        short: variant.short,
        altFull: variant.full.replace(/v/g, 'u'),
        altShort: variant.short.replace(/v/g, 'u'),
    }));
}

/** 3 = 完全相等、2 = 前缀、0 = 不命中（不做「包含」，否则 zhenjiang 会被 nj 命中） */
function pinyinHit(variants, kw) {
    const fulls = [];
    const shorts = [];
    for (const py of variants) {
        fulls.push(py.full, py.altFull);
        shorts.push(py.short, py.altShort);
    }
    if (fulls.some((t) => t && t === kw) || shorts.some((t) => t && t === kw)) return 3;
    if (fulls.some((t) => t && t.startsWith(kw)) || shorts.some((t) => t && t.startsWith(kw))) return 2;
    return 0;
}

/** 每项只换算一次拼音（缓存），避免每次按键重复计算 */
function makePinyinResolver(maps) {
    const cache = new Map();
    return function resolve(text) {
        if (!maps || !maps.map || !text) return [];
        if (cache.has(text)) return cache.get(text);
        const variants = pinyinVariantsOf(String(text), maps);
        cache.set(text, variants);
        return variants;
    };
}

/**
 * 给单个条目打分；-1 表示不匹配。
 * @param {{value: string, label: string, aliases: string[]}} item 条目
 * @param {string} kw 已归一化的关键词
 * @param {Function} resolvePinyin 拼音解析器
 * @returns {number}
 */
function scoreItem(item, kw, resolvePinyin) {
    const primary = [item.label, item.value].map(normalizeText).filter(Boolean);
    const aliases = (item.aliases || []).map(normalizeText).filter(Boolean);

    let score = -1;
    for (const text of primary) {
        if (text === kw) return 100;
        if (text.startsWith(kw)) score = Math.max(score, 90);
        else if (text.includes(kw)) score = Math.max(score, 78);
        else if (subsequenceIndex(text, kw) >= 0) score = Math.max(score, 34);
    }

    // 别名（简称 / 城市 / 省份）权重低于主名称；
    // 单字查询不做「包含」，否则输入「南」会把海南省的公司全带出来
    for (const text of aliases) {
        if (text === kw) score = Math.max(score, 86);
        else if (text.startsWith(kw)) score = Math.max(score, 70);
        else if (kw.length >= 2 && text.includes(kw)) score = Math.max(score, 56);
    }

    const pinyinScore = Math.max(
        pinyinHit(resolvePinyin(item.label), kw),
        ...(item.aliases || []).map((alias) => pinyinHit(resolvePinyin(alias), kw)),
    );
    if (pinyinScore === 3) score = Math.max(score, 70);
    else if (pinyinScore === 2) score = Math.max(score, 62);

    return score;
}

/**
 * 在 input 上挂载匹配下拉。
 *
 * @param {object} options
 * @param {HTMLInputElement} options.input 文本输入框
 * @param {HTMLElement} options.list 下拉列表 <ul role="listbox">
 * @param {Array} [options.items] 初始候选
 * @param {Function} [options.getItems] 动态取候选（优先于 items，用于车队随公司变化）
 * @param {number} [options.max] 最多展示条数
 * @param {boolean} [options.strict] 只允许选候选（失焦时回退 / 清空）
 * @param {{map: Object, exceptions: Object}|null} [options.pinyin] 拼音映射
 * @param {Function} [options.onPick] 选中回调 (item) => void
 * @param {Function} [options.onInput] 输入回调 (value) => void
 * @param {Function} [options.onClear] 清空回调 () => void
 * @param {Function} [options.onInvalid] strict 模式下输入非候选时的回调 (value) => void
 */
export function createMatchChooser({
    input,
    list,
    items = [],
    getItems = null,
    max = DEFAULT_MAX_ITEMS,
    strict = false,
    pinyin = null,
    formatPicked = (item) => item.label,
    onPick,
    onInput,
    onClear,
    onInvalid,
} = {}) {
    if (!input || !list) {
        throw new Error('createMatchChooser 需要 input 与 list 元素');
    }

    const listId = list.id || (input.id ? `${input.id}-list` : 'match-list');
    list.id = listId;

    const resolvePinyin = makePinyinResolver(pinyin);

    let source = Array.isArray(items) ? items : [];
    let matches = [];
    let active = -1;
    let picked = null;
    let settingValue = false;

    /* ---------- 数据 ---------- */
    function currentItems() {
        if (typeof getItems === 'function') {
            const value = getItems();
            return Array.isArray(value) ? value : [];
        }
        return source;
    }

    function setItems(next) {
        source = Array.isArray(next) ? next : [];
        if (picked && !currentItems().some((item) => item.value === picked.value)) {
            picked = null;
        }
    }

    /* ---------- 渲染 ---------- */
    function render(keyword) {
        const kw = normalizeText(keyword);
        const scored = [];

        currentItems().forEach((item, index) => {
            const score = kw ? scoreItem(item, kw, resolvePinyin) : 0;
            if (score >= 0) scored.push({ item, score, index });
        });

        scored.sort((a, b) => b.score - a.score || a.index - b.index);
        matches = scored.slice(0, max).map((entry) => entry.item);
        active = -1;
        input.removeAttribute('aria-activedescendant');

        if (matches.length === 0) {
            list.innerHTML = '<li class="is-disabled" role="option" aria-disabled="true">无匹配结果</li>';
            return;
        }

        list.innerHTML = matches
            .map((item, i) => (
                `<li role="option" id="${listId}-opt-${i}" data-index="${i}"`
                + ` aria-selected="${picked && item.value === picked.value}">`
                + `${escapeHtml(item.label)}`
                + (item.description ? `<span class="match-desc">${escapeHtml(item.description)}</span>` : '')
                + '</li>'
            ))
            .join('');
    }

    /* ---------- 展开 / 收起 ---------- */
    function open() {
        const sameAsPicked = picked && input.value === formatPicked(picked);
        render(sameAsPicked ? '' : input.value);
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
    }

    function close() {
        if (list.hidden) return;
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    }

    function isOpen() {
        return !list.hidden;
    }

    /* ---------- 选中 ---------- */
    function pick(item) {
        if (!item) return;
        picked = item;

        settingValue = true;
        input.value = formatPicked(item);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        settingValue = false;

        close();
        onPick?.(item);
    }

    /* ---------- 键盘高亮 ---------- */
    function highlight() {
        const nodes = list.querySelectorAll('li[data-index]');
        nodes.forEach((node, index) => node.classList.toggle('is-active', index === active));

        const current = nodes[active];
        if (!current) {
            input.removeAttribute('aria-activedescendant');
            return;
        }
        input.setAttribute('aria-activedescendant', current.id);
        current.scrollIntoView({ block: 'nearest' });
    }

    /* ---------- 事件 ---------- */
    function handleFocus() {
        open();
    }

    function handleInput() {
        if (settingValue) return;
        if (picked && input.value !== formatPicked(picked)) picked = null;
        render(input.value);
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        onInput?.(input.value);
    }

    function handleKeyDown(event) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!isOpen()) open();
            if (matches.length === 0) return;
            event.preventDefault();
            const step = event.key === 'ArrowDown' ? 1 : -1;
            active = (active + step + matches.length) % matches.length;
            highlight();
            return;
        }

        if (event.key === 'Enter') {
            if (!isOpen()) return;
            const item = matches[active >= 0 ? active : 0];
            if (!item) return;
            event.preventDefault();
            pick(item);
            return;
        }

        if (event.key === 'Escape') {
            if (!isOpen()) return;
            event.preventDefault();
            if (picked) {
                settingValue = true;
                input.value = formatPicked(picked);
                settingValue = false;
            }
            close();
        }
    }

    function handleBlur() {
        // 延后一拍：让列表的 mousedown（已 preventDefault）先处理
        setTimeout(() => {
            close();
            if (!strict) return;

            const value = input.value.trim();
            if (!value) {
                picked = null;
                return;
            }

            const all = currentItems();
            const exact = all.find((item) => (
                item.value === value
                || item.label === value
                || formatPicked(item) === value
                || (item.aliases || []).some((alias) => alias === value)
            ));
            if (exact) {
                if (!picked || picked.value !== exact.value) {
                    picked = exact;
                    onPick?.(exact);
                }
                // 允许直接打同义词（如「未知」），失焦后规范成候选里的写法
                if (input.value !== formatPicked(exact)) {
                    settingValue = true;
                    input.value = formatPicked(exact);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    settingValue = false;
                }
                return;
            }

            // 输入不在候选里：回退到上次选中值，没有就清空
            const fallback = picked ? formatPicked(picked) : '';
            if (input.value !== fallback) {
                settingValue = true;
                input.value = fallback;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                settingValue = false;
            }
            if (!fallback) picked = null;
            onInvalid?.(value);
        }, 0);
    }

    function handleListMouseDown(event) {
        event.preventDefault();   // 阻止输入框失焦，交给我们自己的 pick 处理
    }

    function handleListClick(event) {
        const node = event.target instanceof Element ? event.target.closest('li[data-index]') : null;
        if (!node) return;
        const item = matches[Number(node.dataset.index)];
        if (item) pick(item);
    }

    function handleDocPointerDown(event) {
        if (list.hidden) return;
        if (input.contains(event.target) || list.contains(event.target)) return;
        close();
    }

    input.addEventListener('focus', handleFocus);
    input.addEventListener('click', handleFocus);
    input.addEventListener('input', handleInput);
    input.addEventListener('keydown', handleKeyDown);
    input.addEventListener('blur', handleBlur);
    list.addEventListener('mousedown', handleListMouseDown);
    list.addEventListener('click', handleListClick);
    document.addEventListener('pointerdown', handleDocPointerDown);

    /* ---------- 对外接口 ---------- */
    return {
        input,
        list,

        /** 重新渲染（数据变化后调用） */
        refresh(keyword = input.value) {
            render(keyword);
        },

        /** 替换候选 */
        setItems,

        open,
        close,
        isOpen,

        /** 当前选中的条目（手动改字后为 null） */
        getPicked() {
            return picked;
        },

        /** 清空输入与选中态（会派发 input，供页面校验 / 记录使用） */
        clear() {
            picked = null;
            settingValue = true;
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            settingValue = false;
            close();
            onClear?.();
        },

        /** 静默复位：不派发事件（清空表单时用，避免触发一次校验） */
        reset() {
            picked = null;
            input.value = '';
            close();
        },

        destroy() {
            input.removeEventListener('focus', handleFocus);
            input.removeEventListener('click', handleFocus);
            input.removeEventListener('input', handleInput);
            input.removeEventListener('keydown', handleKeyDown);
            input.removeEventListener('blur', handleBlur);
            list.removeEventListener('mousedown', handleListMouseDown);
            list.removeEventListener('click', handleListClick);
            document.removeEventListener('pointerdown', handleDocPointerDown);
            input.removeAttribute('aria-expanded');
            input.removeAttribute('aria-activedescendant');
            input.removeAttribute('aria-controls');
        },
    };
}
