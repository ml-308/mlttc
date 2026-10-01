// lib/ui/city-chooser.mjs
/**
 * 城市选择器（可输入 + 下拉列表）
 *
 * 特性：
 *   - 模糊匹配「省份 / 城市 / 车牌前缀」
 *   - 支持中文、全拼（shanghai）、拼音首字母（sh）
 *   - 多音字特例（六安 luan / liuan、重庆 chong qing / zhong qing 等）
 *   - 多城市输入（合营线路）：用「/」隔开最多 MAX_CITY_COUNT 个城市，选择器只按斜杠后面那段过滤
 *   - 县级市（数据里的 parent 字段）：「无锡」也能列出江阴/宜兴，选中写「江苏省 无锡市-宜兴市」
 *   - 键盘导航：↑ ↓ 移动、Enter 选中、Esc 收起
 *   - 相关性排序，最多展示 max 条（默认 DEFAULT_MAX_ITEMS）
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
 *       包含地级市与县级市（县级市带 parent 字段），共 700+ 条。
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
// 含「县」是为了县级条目（如「长兴县」→「长兴」，与库里裸名对齐）
const CITY_ADMIN_SUFFIX = /(维吾尔|壮族|回族|特别行政区|自治区|自治州|省|市|盟|地区|县)/g;

export function cityNormalize(str) {
    return toHalfWidth(str == null ? "" : String(str))
        .replace(/[\s·・\-—_/\\,，、.。()（）【】「」]/g, "")
        .toLowerCase()
        .replace(CITY_ADMIN_SUFFIX, "");
}

/* ==================== 多城市输入（合营线路） ==================== */
// 部分线路由多家公司联合运营，城市栏要写多个城市，用「/」隔开：
//   「无锡/苏州」→ 入库「江苏省 无锡市/江苏省 苏州市」
// ⚠️ cityNormalize 会把「/」当分隔符抹掉，所以必须先按分隔符切开再查库。

/** 允许的分隔符（半角 / 与全角 ／ 都认） */
const CITY_SPLIT_RE = /[\/／]/;

/** 库内写法与显示统一用半角斜杠 */
export const CITY_SEPARATOR = '/';

/** 一条线路最多写几个城市（合营的各方），改这个常量就全局生效 */
export const MAX_CITY_COUNT = 6;

/** 下拉列表默认最多展示条数（全局统一；调用方可传 max 覆盖） */
export const DEFAULT_MAX_ITEMS = 10;

/** 取「正在输入的那一段」：最后一个分隔符之后的内容；没有分隔符时就是整串 */
export function citySegmentOf(raw) {
    const parts = (raw == null ? '' : String(raw)).split(CITY_SPLIT_RE);
    return parts[parts.length - 1];
}

/**
 * 按分隔符切开并丢掉空白段
 * （「无锡/」→ ['无锡']，末尾那段空串会被丢掉；「无锡/苏州」→ ['无锡','苏州']）
 * @returns {string[]}
 */
export function splitCityInput(raw) {
    return (raw == null ? '' : String(raw))
        .split(CITY_SPLIT_RE)
        .map((part) => part.trim())
        .filter(Boolean);
}

/** 输入串是否以分隔符结尾（用户刚打完「/」，正要输入下一个城市） */
function endsWithSeparator(raw) {
    const text = (raw == null ? '' : String(raw)).trim();
    return text !== '' && CITY_SPLIT_RE.test(text.slice(-1));
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
                parent: pinyinVariantsOf(item.parent || '', maps),
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
        const parent = cityNormalize(item.parent || '');   // 县级市的上级地级市，普通城市为空
        const city = cityNormalize(item.city);
        const plate = cityNormalize(item.plate);

        if (city.startsWith(kw)) return 100 - Math.min(city.length, 20);          // 城市前缀命中
        if (city.includes(kw)) return 85 - Math.min(city.indexOf(kw), 20);        // 城市包含
        // 县级市：输上级名也应该能列出下级（「无锡」→ 无锡 + 江阴/宜兴），分数低于城市本身
        if (parent) {
            if (parent.startsWith(kw)) return 92 - Math.min(parent.length, 20);
            if (parent.includes(kw)) return 78 - Math.min(parent.indexOf(kw), 20);
        }
        if (province.startsWith(kw)) return 70 - Math.min(province.length, 20);   // 省份前缀命中
        if (province.includes(kw)) return 60 - Math.min(province.indexOf(kw), 20); // 省份包含

        // 拼音命中：全拼（shanghai）与首字母（sh）都支持
        const py = cityPinyin(item);
        const cityPy = pinyinHit(py.city, kw);
        if (cityPy === 3) return 88;                                             // 城市拼音完全相等
        if (cityPy === 2) return 80;                                             // 城市拼音前缀
        const parentPy = pinyinHit(py.parent, kw);
        if (parent !== '' && parentPy === 3) return 86;                          // 上级市拼音完全相等
        if (parent !== '' && parentPy === 2) return 76;                          // 上级市拼音前缀
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
            const pos = fuzzyIndex(province + parent + city + plate, kw);
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
 * @param {number}           [options.max]   下拉最多展示条数，默认 DEFAULT_MAX_ITEMS
 * @param {Function}         [options.formatPicked] 选中后写进输入框的文本，
 *                                          默认 `省 市`（搜索框要留着省份好看）；
 *                                          写入类表单只想要城市名时传 (item) => item.city
 * @param {Function}         [options.onPick]  选中回调 (item) => void
 * @param {Function}         [options.onInput] 输入回调 (value) => void
 * @param {Function}         [options.onClear] 清空回调 () => void
 */
export function createCityChooser({
    input,
    list,
    hint = null,
    data = null,
    max = DEFAULT_MAX_ITEMS,
    formatPicked = (item) => formatCityLabel(item),
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
        // 多城市写法只按「正在输入的那一段」过滤：输入「无锡/苏」时候选应只受「苏」影响
        const kw = cityNormalize(citySegmentOf(keyword));

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
                `${formatCityLabel(item)}</li>`)
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
    // 支持多城市（合营线路）：「无锡/苏」点选苏州 → 「江苏省 无锡市/江苏省 苏州市」
    // 斜杠前面的段先尽量规范化成库内写法，最多保留 MAX_CITY_COUNT - 1 段
    function pick(item) {
        if (!item) return;
        const head = String(input.value)
            .split(CITY_SPLIT_RE)
            .slice(0, -1)                       // 丢掉正在输入（还不完整）的那一段
            .map((part) => part.trim())
            .filter(Boolean)
            .slice(-(MAX_CITY_COUNT - 1))
            .map((part) => normalizeCityInput(part) ?? part);

        picked = item;
        input.value = [...head, formatPicked(item)].join(CITY_SEPARATOR);
        close();
        setHint(`已选择 ${input.value}`, 1);
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

    // 当前应传给接口的城市名：取「第一个城市」的最后一段
    // ⚠️ 多城市写法「江苏省 无锡市/江苏省 苏州市」只取前一个城市：后端是 CITY LIKE %x%，
    //    传短名就能匹配到整条记录；而长串会超过后端 validateSearchParam 的 20 字上限
    function getCity() {
        const raw = input.value.replace(/\s+/g, ' ').trim();
        if (!raw) return picked ? picked.city : '';
        const first = splitCityInput(raw)[0] || '';
        if (!first) return '';
        // 能在库里查到就用库里的短名（同样宽容，而且县级市不会带出「无锡市-」这截）
        const hit = findCity(first);
        if (hit) return hit.item.city;
        return first.split(' ').pop();
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

/* ==================== 城市库查询（写入表单的规范校验） ==================== */

/** 索引缓存：数据对象没换就不用重算 */
let indexedCities = null;
let indexedMap = null;

/**
 * 建立「规范化写法 → 数据项」索引，同时收录：
 *   城市名（无锡）、省份+城市（江苏无锡），县级市另外收「上级+城市」「省份+上级+城市」
 *   （即「无锡宜兴」与「江苏无锡宜兴」，后者对应选择器写入的「江苏省 无锡市-宜兴市」）
 */
function buildCityIndex(cities) {
    const index = new Map();
    for (const item of cities) {
        const city = cityNormalize(item.city);
        const province = cityNormalize(item.province);
        const parent = cityNormalize(item.parent || '');
        if (!city) continue;
        if (!index.has(city)) index.set(city, { item, matchedBy: 'city' });
        if (parent) {
            if (!index.has(parent + city)) index.set(parent + city, { item, matchedBy: 'parent-city' });
            if (province && !index.has(province + parent + city)) {
                index.set(province + parent + city, { item, matchedBy: 'province-parent-city' });
            }
        }
        if (province && !index.has(province + city)) {
            index.set(province + city, { item, matchedBy: 'province-city' });
        }
    }
    return index;
}

/**
 * 在城市库里查输入对应的城市。
 *
 * 接受这几种写法（都是本站会用到的）：
 *   「无锡」「无锡市」                          —— 城市名
 *   「江苏省 无锡」「江苏省 无锡市」             —— 选择器写法（也是入库写法）
 *   「宜兴」「无锡宜兴」「江苏省 无锡市-宜兴市」    —— 县级市（parent 字段的存在）
 *
 * @param {string} query 用户输入
 * @param {object} [data] 城市数据；缺省用已加载的缓存（见 loadCityData）
 * @returns {{item: object, matchedBy: 'city'|'parent-city'|'province-city'|'province-parent-city'}|null} 未命中返回 null
 */
export function findCity(query, data = getCityData()) {
    const cities = data && Array.isArray(data.cities) ? data.cities : null;
    if (!cities) return null;                     // 数据还没加载好：不误判，交给调用方

    if (indexedCities !== cities) {
        indexedCities = cities;
        indexedMap = buildCityIndex(cities);
    }

    const key = cityNormalize(query);
    return key ? (indexedMap.get(key) || null) : null;
}

/**
 * 下拉列表 / 选中后写进输入框的文案。
 *   普通地级市 → 「江苏省 无锡」（不带「市」，与原来看感一致）
 *   县级（市/县）→ 与入库写法相同（「江苏省 无锡市-宜兴市」「浙江省 湖州市-长兴县」）
 *
 * @param {object} item 城市库里的数据项
 * @returns {string}
 */
export function formatCityLabel(item) {
    if (!item) return '';
    return item.parent ? formatCityForStorage(item) : `${item.province} ${item.city}`;
}

/**
 * 把库里的城市项格式化成**入库写法**（**已带行政区划后缀**，调用方无需再补）
 *   普通地级市 → 「江苏省 无锡市」
 *   县级市     → 「江苏省 无锡市-宜兴市」（省 + 上级地级市 + 县级市）
 *   县（数据里写了 suffix）→ 「浙江省 湖州市-长兴县」
 *   直辖市     → 「北京市」（库里 province 本身就是完整城市名，不重复写）
 *
 * @param {object} item 城市库里的数据项
 * @returns {string}
 */
export function formatCityForStorage(item) {
    if (!item) return '';

    // 默认补「市」；数据里显式给了 suffix（如「县」「旗」）就用它，已经带后缀的不重复补
    const withSuffix = (name, suffix = '市') => (name.endsWith(suffix) ? name : `${name}${suffix}`);

    // 县级（市/县）：带上上级地级市，写成「江苏省 无锡市-宜兴市」
    if (item.parent) return `${item.province} ${withSuffix(item.parent)}-${withSuffix(item.city, item.suffix)}`;

    // 直辖市：库里的 province 本身就是完整城市名（北京市），拼成「北京市 北京市」就重复了
    // ⚠️ 不能用「省份名以城市名开头」来判断 —— 吉林省 / 吉林市 也满足，会被误判成直辖市
    if (item.province.endsWith('市')) return item.province;

    // 其余补上「市」——库里存的是「无锡」这种不带后缀的名字
    return `${item.province} ${withSuffix(item.city, item.suffix)}`;
}

/**
 * 校验写入表单的城市输入（支持「合营线路」的多城市写法）。
 *
 * 入参写法：单个城市「无锡」/「无锡市」/「江苏省 无锡市」，
 *           多个城市用「/」隔开（最多 MAX_CITY_COUNT 个）「无锡/苏州」「江苏省 无锡市/江苏省 苏州市」。
 *
 * @param {string} query 用户输入
 * @param {object} [data] 城市数据；缺省用已加载的缓存
 * @returns {{ok: true, value: string, count: number}
 *         | {ok: false, reason: 'empty'|'incomplete'|'too-many'|'not-found', part?: string, count: number}}
 *   ok:true    → value 为入库写法（已带「市」，多城市用 CITY_SEPARATOR 连接）
 *   not-found  → part 是库外那一段的原文（给提示文案用）
 *   incomplete → 输入以「/」结尾（还在打第二个城市）
 */
export function checkCityInput(query, data = getCityData()) {
    const raw = query == null ? '' : String(query);
    const parts = splitCityInput(raw);

    if (parts.length === 0) return { ok: false, reason: 'empty', count: 0 };
    if (endsWithSeparator(raw) && parts.length >= MAX_CITY_COUNT) {
        // 「无锡/苏州/…/」——已经到上限了还在打分隔符
        return { ok: false, reason: 'too-many', count: parts.length + 1 };
    }
    if (endsWithSeparator(raw)) return { ok: false, reason: 'incomplete', count: parts.length };
    if (parts.length > MAX_CITY_COUNT) return { ok: false, reason: 'too-many', count: parts.length };

    const formatted = [];
    for (const part of parts) {
        const hit = findCity(part, data);
        if (!hit) return { ok: false, reason: 'not-found', part, count: parts.length };
        formatted.push(formatCityForStorage(hit.item));
    }
    return { ok: true, value: formatted.join(CITY_SEPARATOR), count: formatted.length };
}

/**
 * 把 checkCityInput() 的结果翻译成提示行文案。
 * 放在这里是为了让「新增」与「修改」两个表单措辞一致（原先各写一份）。
 *
 * @param {{ok: boolean, value?: string, reason?: string, part?: string}} result checkCityInput() 的返回值
 * @returns {string}
 */
export function describeCityInput(result) {
    if (result.ok) return `"${result.value}" 符合格式规范`;
    switch (result.reason) {
        case 'empty':
            return '请输入城市';
        case 'incomplete':
            return `请继续输入下一个城市（合营线路用「${CITY_SEPARATOR}」隔开）`;
        case 'too-many':
            return `最多只能填 ${MAX_CITY_COUNT} 个城市（合营线路），用「${CITY_SEPARATOR}」隔开`;
        default:
            return `城市库中找不到「${result.part}」，请从下拉列表中选择`;
    }
}

/**
 * 写入表单用：把用户输入规范成库内写法（一个或多个城市）。
 *
 * ⚠️ **只要有任意一段不在城市库里就返回 null** —— 调用方据此把该字段判为「不通过」。
 *
 * @param {string} query 用户输入（手打或选择器写入，多个城市用「/」隔开）
 * @param {object} [data] 城市数据
 * @returns {string|null} 库内写法（如「江苏省 无锡市」「江苏省 无锡市/江苏省 苏州市」）；未命中返回 null
 */
export function normalizeCityInput(query, data = getCityData()) {
    const result = checkCityInput(query, data);
    return result.ok ? result.value : null;
}
