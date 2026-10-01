// lib/data/city-picker.mjs
/**
 * 城市选择框 —— 一站式挂载（连 DOM 一起生成）
 *
 * 原先每个页面都要自己写一段标记（容器 + 输入框 + 箭头 + 下拉 + 提示行），
 * 少写一项就出错（例如忘了给 <ul> 加 hidden，脚本一旦报错下拉会永远展开并
 * 遮挡表单）。本模块把这些一次性做掉，调用方只给一个容器。
 *
 * 两个入口：
 *   【一】mountCityPicker(container, options)  容器里生成完整结构（输入框也由本模块建）
 *   【二】attachCityPicker(input, options)     页面已有 <input> 时，在外面套上箭头与下拉
 *
 *   import { mountCityPicker, attachCityPicker } from '/lib/data/city-picker.mjs';
 *
 *   // 一、页面只留了一个空容器
 *   const picker = await mountCityPicker('#city-picker');
 *   picker.getCity();      // → '上海'
 *   picker.clear();
 *
 *   // 二、表单里已经有自己的 <input id="city">（id / name / required 都保留）
 *   const cityPicker = await attachCityPicker('#city', {
 *       hint: false,                             // 表单自己已有校验提示行
 *       formatPicked: (item) => item.city,       // 写入表单只要城市名，不要「省份 城市」
 *       onPick() { cityinput(); },               // 选中后跑一次既有校验
 *   });
 *
 * 公共选项（options，两个入口都支持）：
 *   id            生成 id 的前缀，默认取容器 / 输入框的 id；都没有则自动生成
 *   ariaLabel     下拉的无障碍名称，默认「可选城市」
 *   hint          容器版默认 true（生成 `{id}-hint`）；输入框版默认 false
 *                 取值：true | '自定义id' | HTMLElement（复用）| false（不要提示行）
 *   data          城市数据，缺省自动加载 lib/data/cities.json
 *   max           下拉最多展示条数，默认 DEFAULT_MAX_ITEMS（10）
 *   formatPicked  选中后写进输入框的文本，默认用 formatCityLabel()
 *                 （普通城市「江苏省 无锡」，县级市「江苏省 无锡市-宜兴市」）；
 *                 写入类表单只想要城市名时传 (item) => item.city
 *   onPick / onInput / onClear  回调
 *   placeholder / inputAttrs    仅容器版有效（输入框由本模块创建时才用得上）
 *
 * 生成的 DOM（属性与原先手写的完全一致，因此 style/main.css 无需改动）：
 *   <div class="city-chooser">
 *     <input hcw-input type="text" id="{id}-input" placeholder="…" autocomplete="off"
 *            role="combobox" aria-expanded="false" aria-controls="{id}-list"
 *            aria-autocomplete="list">
 *     <span class="city-chooser-arrow" aria-hidden="true"></span>
 *     <ul id="{id}-list" class="city-chooser-list" role="listbox" aria-label="可选城市" hidden></ul>
 *   </div>
 *   <p id="{id}-hint" class="lp lp-hide"></p>          <!-- hint 为 false 时不生成 -->
 *
 * ⚠️ 提示行为什么单独给 id：原先 timetable.html 里 #citytest 出现了两次
 *    （新增表单一个、查询表单一个），getElementById 只认第一个，导致查询框的
 *    提示一直写进了新增表单的提示位（被隐藏，看不见）。生成独立 id 就不会再撞。
 *
 * 依赖：./city-data.mjs（加载 cities.json）、../ui/city-chooser.mjs（选择器本体）
 */

import { loadCityData } from './city-data.mjs';
import { createCityChooser, DEFAULT_MAX_ITEMS } from '../ui/city-chooser.mjs';

/** 默认占位文案 */
const DEFAULT_PLACEHOLDER = '输入城市名 / 拼音首字母，如：上海 / sh';

/** 没显式给 id / 容器没有 id 时用来生成唯一后缀 */
let autoSeq = 0;

/* ---------- 内部小工具（两个入口共用） ---------- */

/** 右端箭头（纯装饰） */
function makeArrow() {
    const arrow = document.createElement('span');
    arrow.className = 'city-chooser-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    return arrow;
}

/**
 * 下拉列表
 * ⚠️ 必须一创建就 hidden，否则脚本出错时浮层会永远展开并遮住表单
 * @param {string} listId
 * @param {string} ariaLabel
 */
function makeList(listId, ariaLabel) {
    const list = document.createElement('ul');
    list.id = listId;
    list.className = 'city-chooser-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', ariaLabel);
    list.hidden = true;
    return list;
}

/**
 * 解析 hint 选项
 * @returns {HTMLElement|null} 传 false 时为 null；传元素时原样复用；否则新建 <p class="lp lp-hide">
 */
function resolveHint(hint, base) {
    if (hint === false) return null;
    if (hint instanceof HTMLElement) return hint;
    const el = document.createElement('p');
    el.className = 'lp lp-hide';
    el.id = typeof hint === 'string' ? hint : `${base}-hint`;
    return el;
}

/** 给输入框补上组合框所需的无障碍属性（已有值不覆盖） */
function applyInputAria(input, listId) {
    if (!input.hasAttribute('role')) input.setAttribute('role', 'combobox');
    if (!input.hasAttribute('aria-expanded')) input.setAttribute('aria-expanded', 'false');
    if (!input.hasAttribute('aria-autocomplete')) input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);
}

/**
 * 把已存在的输入框挪进一个新建的 .city-chooser 容器
 * （挪动节点不会丢已绑定的监听器，所以页面原有的事件都能继续用）
 */
function wrapExistingInput(input) {
    const wrap = document.createElement('div');
    wrap.className = 'city-chooser';
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input);
    return wrap;
}

/** 加载数据 → 建选择器 → 组装返回对象（两个入口共用） */
async function buildPicker({ input, list, hintEl, wrap, root, adopted, options }) {
    const cityData = options.data ?? await loadCityData();
    const chooser = createCityChooser({
        input,
        list,
        hint: hintEl,
        data: cityData,
        max: options.max ?? DEFAULT_MAX_ITEMS,
        formatPicked: options.formatPicked,
        onPick: options.onPick,
        onInput: options.onInput,
        onClear: options.onClear,
    });

    return {
        ...chooser,
        root,
        wrap,
        input,
        list,
        hint: hintEl,

        /**
         * 解绑事件并移除本次生成的 DOM；
         * 复用别人给的提示元素 / 输入框时，会把它们放回原位而不是删掉
         */
        remove() {
            chooser.destroy();
            if (hintEl && hintEl.parentElement === root) hintEl.remove();
            if (adopted) wrap.parentNode.insertBefore(input, wrap);
            wrap.remove();
        },
    };
}

/**
 * 【用法一】容器版：在容器里生成完整的城市选择框（输入框也由本函数创建）
 *
 * @param {HTMLElement|string} container 容器元素，或其 CSS 选择器字符串
 * @param {object}   [options] 见下方「公共选项」
 * @param {string}   [options.placeholder] 输入框占位文案
 * @param {object}   [options.inputAttrs]  额外加到输入框上的属性，如 { maxlength: 20 }
 * @returns {Promise<object>} 选择器实例 + 元素引用 + remove()
 */
export async function mountCityPicker(container, options = {}) {
    const root = typeof container === 'string' ? document.querySelector(container) : container;
    if (!root) {
        throw new Error(`mountCityPicker: 找不到容器 ${typeof container === 'string' ? container : ''}`);
    }

    const base = options.id || root.id || `city-picker-${++autoSeq}`;
    const listId = `${base}-list`;

    /* ---------- 生成 DOM ---------- */
    const wrap = document.createElement('div');
    wrap.className = 'city-chooser';

    const input = document.createElement('input');
    input.setAttribute('hcw-input', '');   // 与手写的 <input hcw-input> 等价
    input.type = 'text';
    input.id = `${base}-input`;
    input.placeholder = options.placeholder ?? DEFAULT_PLACEHOLDER;
    input.autocomplete = 'off';
    applyInputAria(input, listId);
    for (const [key, value] of Object.entries(options.inputAttrs ?? {})) {
        if (value !== null && value !== undefined) input.setAttribute(key, String(value));
    }

    const list = makeList(listId, options.ariaLabel ?? '可选城市');
    wrap.append(input, makeArrow(), list);

    const hintEl = resolveHint(options.hint ?? true, base);
    root.append(wrap);
    if (hintEl && !hintEl.isConnected) root.append(hintEl);

    return buildPicker({ input, list, hintEl, wrap, root, adopted: false, options });
}

/**
 * 【用法二】已有输入框版：在页面自己的 <input> 外面套上箭头与下拉
 *
 * 适合「表单里已有城市输入框」的场景：输入框会连同它的 id、name、required 等
 * 原样保留（只是被挪进 .city-chooser 容器，已绑定的事件不受影响），
 * 所以页面原有的取值、校验代码一行都不用改。
 *
 *   const picker = await attachCityPicker('#city', {
 *       hint: false,                              // 表单自己已有提示行
 *       formatPicked: (item) => item.city,        // 写入表单只要城市名
 *       onPick() { cityinput(); },                // 选中后跑一次既有校验
 *   });
 *
 * @param {HTMLElement|string} inputTarget 已存在的 <input>，或其选择器
 * @param {object} [options] 见下方「公共选项」；hint 默认 false（表单多有自己的提示行）
 * @returns {Promise<object>} 选择器实例 + 元素引用 + remove()
 */
export async function attachCityPicker(inputTarget, options = {}) {
    const input = typeof inputTarget === 'string' ? document.querySelector(inputTarget) : inputTarget;
    if (!input) {
        throw new Error(`attachCityPicker: 找不到输入框 ${typeof inputTarget === 'string' ? inputTarget : ''}`);
    }
    if (input.closest('.city-chooser')) {
        throw new Error('attachCityPicker: 该输入框已经在 .city-chooser 里了，不要重复挂载');
    }

    const base = options.id || input.id || `city-picker-${++autoSeq}`;
    const listId = `${base}-list`;

    const wrap = wrapExistingInput(input);
    const list = makeList(listId, options.ariaLabel ?? '可选城市');
    wrap.append(makeArrow(), list);
    applyInputAria(input, listId);
    if (input.autocomplete !== 'off') input.autocomplete = 'off';

    // 提示行放在容器之后（紧贴输入框下方），默认不生成
    const hintEl = resolveHint(options.hint ?? false, base);
    const root = wrap.parentNode;
    if (hintEl && !hintEl.isConnected) wrap.after(hintEl);

    return buildPicker({ input, list, hintEl, wrap, root, adopted: true, options });
}
