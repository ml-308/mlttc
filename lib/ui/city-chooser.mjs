// lib/ui/city-chooser.mjs
/**
 * 城市选择器（可输入 + 下拉列表）
 *
 * 特性：
 *   - 模糊匹配「省份 / 城市 / 车牌前缀」
 *   - 支持中文、全拼（shanghai）、拼音首字母（sh）
 *   - 多音字特例（六安 luan / liuan、重庆 chong qing / zhong qing 等）
 *   - 键盘导航：↑ ↓ 移动、Enter 选中、Esc 收起
 *   - 相关性排序，最多展示 max 条
 *
 * 用法（城市数据在 lib/data/cities.json，由 ../data/city-data.mjs 自动加载并缓存）：
 *   页面已有自己的 <input> + <ul> 时用本模块；
 *   想让本模块把 DOM 一并生成，用 lib/data/city-picker.mjs 的 mountCityPicker()。
 *
 *   import { createCityChooserWithData } from '/lib/ui/city-chooser.mjs';
 *
 *   const chooser = await createCityChooserWithData({
 *       input: document.getElementById('city-chooser'),
 *       list:  document.getElementById('city-list'),
 *       hint:  document.getElementById('citytest'),   // 可选，<p class="lp">
 *       onPick(item) { ... }                          // 可选，选中回调
 *   });
 *
 *   chooser.getCity()    // → '上海'（选中城市名；未选中时回退为输入框文本）
 *   chooser.getPicked()  // → { province, city, plate } | null
 *   chooser.setPicked(item)
 *   chooser.clear()
 *   chooser.isOpen()
 *
 * 样式见 style/main.css 的「城市选择器」区块。
 *
 * 数据：城市列表与拼音映射在 lib/data/cities.json（与代码分离，便于单独增删）。
 *       需要自己控制加载时机（或多个选择器共用一份数据）时，也可以先
 *       await loadCityData()，再用同步的 createCityChooser({ data })。
 */

import { getCityData, loadCityData } from '../data/city-data.mjs';

/* ==================== 全角转半角 ==================== */
// 中文输入法下常打出全角的数字 / 字母，如 １２３４５、Ｂ
export function toHalfWidth(str) {
    return str
        .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, " ");
}

/* ==================== 城市模糊匹配 ==================== */

// 归一化：全角转半角、去空格与常见分隔符、转小写、去掉行政区划与民族限定词
// 例：全角「１２３」→「123」；「内蒙古自治区」→「内蒙古」；
//     「广西壮族自治区」→「广西」；「宁夏回族自治区」→「宁夏」；「上海市」→「上海」
const CITY_ADMIN_SUFFIX = /(维吾尔|壮族|回族|特别行政区|自治区|自治州|省|市|盟|地区)/g;

export function cityNormalize(str) {
    return toHalfWidth(str == null ? "" : String(str))
        .replace(/[\s·・\-—_/\\,，、.。()（）【】「」]/g, "")
        .toLowerCase()
        .replace(CITY_ADMIN_SUFFIX, "");
}

// 顺序子序列匹配（允许中间跳过字符），返回最后一个命中字符之后的索引；未命中返回 -1
// 例：haystack = "广东省深圳粤b"，needle = "广深" → 命中
function fuzzyIndex(haystack, needle) {
    let pos = 0;
    for (const ch of needle) {
        pos = haystack.indexOf(ch, pos);
        if (pos === -1) return -1;
        pos += 1;
    }
    return pos;
}

/* ==================== 拼音匹配 ==================== */


// 拼音映射与城市列表已迁到 lib/ui/cities.json，由 city-data.mjs 加载后经 data 参数注入

/**
 * 换算拼音变体：full 全拼（shanghai）、short 首字母（sh）、alt* 为 ü→u 的兼容写法
 * 返回数组：普通字只有一个变体，含多读音词的字符串会有多个变体（其余部分自动拼接）
 *
 * @param {string} text 中文（省名 / 市名）
 * @param {{map: Object, exceptions: Object}} maps 拼音映射，来自城市数据
 * @returns {Array<{full: string, short: string, altFull: string, altShort: string}>}
 */
function pinyinVariantsOf(text, maps) {
    let variants = [{ full: "", short: "" }];

    for (let i = 0; i < text.length; i++) {
        const two = text.slice(i, i + 2);
        let readings;                                // 二维：每种读音 = 若干音节
        if (maps.exceptions[two]) {
            readings = maps.exceptions[two];
            i += 1;                                  // 特例占两个字
        } else {
            const one = maps.map[text[i]];
            readings = one ? [[one]] : [];            // 缺映射的字直接跳过
        }
        if (readings.length === 0) continue;

        const next = [];
        for (const variant of variants) {
            for (const syllables of readings) {
                next.push({
                    full: variant.full + syllables.join(""),
                    short: variant.short + syllables.map((s) => s[0]).join(""),
                });
            }
        }
        variants = next;
    }

    return variants.map((v) => ({
        full: v.full,
        short: v.short,
        altFull: v.full.replace(/v/g, "u"),          // 吕 lv → lu 的兼容写法
        altShort: v.short.replace(/v/g, "u"),
    }));
}

// 3 = 完全相等、2 = 前缀、1 = 包含、0 = 不匹配
// 首字母只按「相等 / 前缀」匹配：否则 zzz 会命中「广西壮族自治区」（首字母 gxzzzq）
function pinyinHit(variants, kw) {
    const fulls = [];
    const shorts = [];
    for (const py of variants) {
        fulls.push(py.full, py.altFull);
        shorts.push(py.short, py.altShort);
    }

    if (fulls.some((t) => t && t === kw) || shorts.some((t) => t && t === kw)) return 3;
    if (fulls.some((t) => t && t.startsWith(kw)) || shorts.some((t) => t && t.startsWith(kw))) return 2;
    if (fulls.some((t) => t && t.includes(kw))) return 1;
    return 0;
}

// 每项只换算一次（WeakMap 缓存，避免每次按键重复计算）
// @param {{map: Object, exceptions: Object}} maps 拼音映射
function makePinyinResolver(maps) {
    const cache = new WeakMap();
    return function cityPinyin(item) {
        let entry = cache.get(item);
        if (!entry) {
            entry = {
                province: pinyinVariantsOf(item.province, maps),
                city: pinyinVariantsOf(item.city, maps),
            };
            cache.set(item, entry);
        }
        return entry;
    };
}

// 相关性打分：命中越精确、位置越靠前分数越高；返回 -1 表示不匹配
function makeScorer(cityPinyin) {
    return function cityScore(item, kw) {
        const province = cityNormalize(item.province);
        const city = cityNormalize(item.city);
        const plate = cityNormalize(item.plate);

        if (city.startsWith(kw)) return 100 - Math.min(city.length, 20);          // 城市前缀命中
        if (city.includes(kw)) return 85 - Math.min(city.indexOf(kw), 20);        // 城市包含
        if (province.startsWith(kw)) return 70 - Math.min(province.length, 20);   // 省份前缀命中
        if (province.includes(kw)) return 60 - Math.min(province.indexOf(kw), 20); // 省份包含

        // 拼音命中：全拼（shanghai）与首字母（sh）都支持
        const py = cityPinyin(item);
        const cityPy = pinyinHit(py.city, kw);
        if (cityPy === 3) return 88;                                             // 城市拼音完全相等
        if (cityPy === 2) return 80;                                             // 城市拼音前缀
        const provPy = pinyinHit(py.province, kw);
        if (provPy === 3) return 72;                                             // 省份拼音完全相等
        if (provPy === 2) return 68;                                             // 省份拼音前缀
        if (cityPy === 1) return 62;                                             // 城市拼音包含
        if (provPy === 1) return 56;                                             // 省份拼音包含

        if (plate.startsWith(kw)) return 55;                                     // 车牌前缀
        if (plate.includes(kw)) return 50;                                       // 车牌包含

        // 字符级模糊：仅对中文关键词生效（按顺序出现即可，如「广深」→ 广东省 深圳）
        // 不用于拼音关键词，否则「zzz」会命中「广西壮族自治区」（壮·族·自 恰好三个 z）
        if (/[\u4e00-\u9fa5]/.test(kw)) {
            const pos = fuzzyIndex(province + city + plate, kw);
            return pos === -1 ? -1 : 30 - Math.min(pos, 25);
        }

        return -1;
    };
}

/* ==================== 选择器工厂 ==================== */

/**
 * 在 input 上挂载城市选择器
 * @param {object}   options
 * @param {HTMLInputElement} options.input  文本输入框
 * @param {HTMLElement}      options.list   下拉列表 <ul>
 * @param {HTMLElement}      [options.hint] 可选，提示元素（<p class="lp">）
 * @param {object}           [options.data] 城市数据 { cities, pinyin, exceptions }，
 *                                          缺省时取 getCityData()（需先 await loadCityData()）；
 *                                          一般直接用 createCityChooserWithData() 即可
 * @param {number}           [options.max]   下拉最多展示条数，默认 5
 * @param {Function}         [options.onPick]  选中回调 (item) => void
 * @param {Function}         [options.onInput] 输入回调 (value) => void
 * @param {Function}         [options.onClear] 清空回调 () => void
 */
export function createCityChooser({
    input,
    list,
    hint = null,
    data = null,
    max = 5,
    onPick,
    onInput,
    onClear,
} = {}) {
    if (!input || !list) {
        throw new Error('createCityChooser 需要 input 与 list 元素');
    }

    // 数据来源：显式传入 → 已加载的缓存 → 空（保持可输入，只是没有候选）
    const cityData = data ?? getCityData() ?? { cities: [], pinyin: {}, exceptions: {} };
    const items = cityData.cities;
    const pinyinMaps = { map: cityData.pinyin, exceptions: cityData.exceptions };

    if (items.length === 0) {
        console.warn('[city-chooser] 城市数据为空：请先 await loadCityData() 再创建选择器，'
            + '或改用 createCityChooserWithData()。选择器仍可输入，但没有下拉候选。');
    }

    const listId = list.id || 'city-list';
    const cityPinyin = makePinyinResolver(pinyinMaps);
    const cityScore = makeScorer(cityPinyin);

    let matches = [];      // 当前展示的数据
    let active = -1;       // 键盘高亮项下标，-1 表示无
    let picked = null;     // 已选中的数据项

    /* ---------- 提示文字 ---------- */
    // state 与全站约定一致：1 = 通过（绿）、2 = 不通过（红）、3 = 警告（橙）、其它 = 隐藏
    function setHint(msg, state) {
        if (!hint) return;
        const kind =
            state === 1 ? 'lp-valid' :
                state === 2 ? 'lp-invalid' :
                    state === 3 ? 'lp-warning' : null;

        hint.textContent = msg || '';
        hint.classList.toggle('lp-valid', kind === 'lp-valid' && !!msg);
        hint.classList.toggle('lp-invalid', kind === 'lp-invalid' && !!msg);
        hint.classList.toggle('lp-warning', kind === 'lp-warning' && !!msg);
        hint.classList.toggle('lp-hide', !msg);
    }

    /* ---------- 渲染列表 ---------- */
    // 模糊匹配 省 / 市 / 车牌前缀，并按相关性排序
    function render(keyword = '') {
        const kw = cityNormalize(keyword);

        const scored = [];
        for (const item of items) {
            const score = kw ? cityScore(item, kw) : 0;
            if (score >= 0) scored.push({ item, score });
        }
        // 分数相同时保持原有顺序（Array.prototype.sort 是稳定排序）
        scored.sort((a, b) => b.score - a.score);

        matches = scored.slice(0, max).map((entry) => entry.item);
        active = -1;
        input.removeAttribute('aria-activedescendant');

        if (matches.length === 0) {
            list.innerHTML = '<li class="is-disabled" role="option" aria-disabled="true">无匹配结果</li>';
            return;
        }

        list.innerHTML = matches
            .map((item, i) =>
                `<li role="option" id="${listId}-opt-${i}" data-index="${i}" aria-selected="${item === picked}">` +
                `${item.province} ${item.city}</li>`)
            .join('');
    }

    /* ---------- 展开 / 收起 ---------- */
    function open() {
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
    }

    function close() {
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
        active = -1;
    }

    function isOpen() {
        return !list.hidden;
    }

    /* ---------- 键盘高亮 ---------- */
    function highlight() {
        const lis = list.querySelectorAll('li[data-index]');
        lis.forEach((li, i) => li.classList.toggle('is-active', i === active));

        const current = lis[active];
        if (current) {
            input.setAttribute('aria-activedescendant', current.id);
            current.scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    /* ---------- 选中 ---------- */
    function pick(item) {
        if (!item) return;
        picked = item;
        input.value = `${item.province} ${item.city}`;
        close();
        setHint(`已选择 ${item.province} ${item.city}`, 1);
        onPick?.(item);
    }

    /* ---------- 输入 ---------- */
    function handleInput() {
        picked = null;                       // 手动改动后视为未选择
        render(input.value);
        open();

        if (!input.value.trim()) setHint('', null);
        else if (matches.length === 0) setHint('未找到匹配的城市', 2);
        else setHint('', null);

        onInput?.(input.value);
    }

    // 点击 / 聚焦输入框：展开并显示（有输入按输入过滤，无输入显示前 max 条）
    function handleOpenList() {
        render(input.value);
        open();
    }

    // 点击选项（mousedown 阻止输入框失焦，避免列表先收起）
    function handleSelect(e) {
        const li = e.target.closest('li[data-index]');
        if (!li) return;
        e.preventDefault();
        pick(matches[+li.dataset.index]);
    }

    // 点击外部收起
    function handleOutside(e) {
        if (e.target === input || list.contains(e.target)) return;
        close();
    }

    /* ---------- 键盘导航：↑ ↓ 移动、Enter 选中、Esc 收起 ---------- */
    function handleKeydown(e) {
        const opened = isOpen();

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (matches.length === 0) {
                    render(input.value);
                    open();
                    return;
                }
                active = opened ? (active + 1) % matches.length : 0;
                if (!opened) open();
                highlight();
                break;

            case 'ArrowUp':
                e.preventDefault();
                if (matches.length === 0) {
                    render(input.value);
                    open();
                    return;
                }
                active = opened ? (active - 1 + matches.length) % matches.length : matches.length - 1;
                if (!opened) open();
                highlight();
                break;

            case 'Enter':
                if (opened && active >= 0 && matches[active]) {
                    e.preventDefault();
                    pick(matches[active]);
                }
                break;

            case 'Escape':
                if (opened) {
                    e.preventDefault();
                    close();
                }
                break;

            case 'Tab':
                close();
                break;
        }
    }

    /* ---------- 对外接口 ---------- */
    function getPicked() {
        return picked;
    }

    function getValue() {
        return input.value;
    }

    // 当前应传给接口的城市名：选中项取 city，手动输入取最后一段
    // （选中后输入框显示「上海市 上海」，取最后一段即「上海」，与手输「上海」一致）
    function getCity() {
        if (picked) return picked.city;
        const raw = input.value.replace(/\s+/g, ' ').trim();
        return raw ? raw.split(' ').pop() : '';
    }

    function setPicked(item) {
        if (!item) {
            clear();
            return;
        }
        // 数据项可能来自 sessionStorage（普通对象），补齐 picked 语义即可
        pick(item);
    }

    function clear() {
        input.value = '';
        picked = null;
        close();
        setHint('', null);
        onClear?.();
    }

    function destroy() {
        input.removeEventListener('input', handleInput);
        input.removeEventListener('click', handleOpenList);
        input.removeEventListener('focus', handleOpenList);
        input.removeEventListener('blur', close);
        input.removeEventListener('keydown', handleKeydown);
        list.removeEventListener('mousedown', handleSelect);
        document.removeEventListener('click', handleOutside);
    }

    /* ---------- 绑定事件 ---------- */
    input.addEventListener('input', handleInput);
    input.addEventListener('click', handleOpenList);
    input.addEventListener('focus', handleOpenList);
    input.addEventListener('blur', close);
    input.addEventListener('keydown', handleKeydown);
    list.addEventListener('mousedown', handleSelect);
    document.addEventListener('click', handleOutside);

    // 初始收起
    close();

    return { getPicked, getValue, getCity, setPicked, clear, open, close, render, isOpen, destroy };
}

/**
 * 便捷入口：自动加载城市数据并创建选择器
 *
 * 等价于「先 await loadCityData()，再把结果传给 createCityChooser」，
 * 调用方不必关心中间那一步，也不会漏传数据：
 *
 *   const chooser = await createCityChooserWithData({
 *       input: document.getElementById('city-chooser'),
 *       list:  document.getElementById('city-list'),
 *       hint:  document.getElementById('citytest'),
 *   });
 *
 * 需要多个选择器共用同一份数据时，也可以自己 await loadCityData() 一次，
 * 再分别调用（同步的）createCityChooser({ data })。
 *
 * @param {object} [options] 同 createCityChooser，但无需传 data
 * @returns {Promise<object>} 选择器实例
 */
export async function createCityChooserWithData(options = {}) {
    const data = options.data ?? await loadCityData();
    return createCityChooser({ ...options, data });
}
