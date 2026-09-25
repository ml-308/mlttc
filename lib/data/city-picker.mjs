// lib/data/city-picker.mjs
/**
 * 城市选择框 —— 一站式挂载（连 DOM 一起生成）
 *
 * 原先每个页面都要自己写一段标记（容器 + 输入框 + 箭头 + 下拉 + 提示行），
 * 少写一项就出错（例如忘了给 <ul> 加 hidden，脚本一旦报错下拉会永远展开并
 * 遮挡表单）。本模块把这些一次性做掉，调用方只给一个容器。
 *
 * 用法：
 *   import { mountCityPicker } from '/lib/data/city-picker.mjs';
 *
 *   const picker = await mountCityPicker('#city-picker');
 *   picker.getCity();      // → '上海'
 *   picker.clear();
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
import { createCityChooser } from '../ui/city-chooser.mjs';

/** 默认占位文案 */
const DEFAULT_PLACEHOLDER = '输入城市名 / 拼音首字母，如：上海 / sh';

/** 没显式给 id / 容器没有 id 时用来生成唯一后缀 */
let autoSeq = 0;

/**
 * 在容器里生成一个城市选择框并挂载交互
 *
 * @param {HTMLElement|string} container 容器元素，或其 CSS 选择器字符串
 * @param {object}   [options]
 * @param {string}   [options.id]         生成 id 的前缀，默认取 container 的 id；都没有则自动生成
 * @param {string}   [options.placeholder] 输入框占位文案
 * @param {string}   [options.ariaLabel]   下拉列表的无障碍名称，默认「可选城市」
 * @param {boolean|string|HTMLElement} [options.hint=true]
 *        true = 生成提示行（id 为 `{id}-hint`）；string = 生成并指定 id；
 *        HTMLElement = 复用页面上已有的提示元素；false = 不生成
 * @param {object}   [options.data]       城市数据；缺省自动加载（lib/data/cities.json）
 * @param {number}   [options.max=5]      下拉最多展示条数
 * @param {Function} [options.onPick]     选中回调 (item) => void
 * @param {Function} [options.onInput]    输入回调 (value) => void
 * @param {Function} [options.onClear]    清空回调 () => void
 * @param {object}   [options.inputAttrs] 额外加到输入框上的属性，如 { maxlength: 20 }
 * @returns {Promise<object>} 选择器实例 + 元素引用（root/wrap/input/list/hint）+ remove()
 */
export async function mountCityPicker(container, options = {}) {
    const root = typeof container === 'string' ? document.querySelector(container) : container;
    if (!root) {
        throw new Error(`mountCityPicker: 找不到容器 ${typeof container === 'string' ? container : ''}`);
    }

    const {
        placeholder = DEFAULT_PLACEHOLDER,
        ariaLabel = '可选城市',
        hint = true,
        data = null,
        max = 5,
        onPick,
        onInput,
        onClear,
        inputAttrs = {},
    } = options;

    const base = options.id || root.id || `city-picker-${++autoSeq}`;
    const inputId = `${base}-input`;
    const listId = `${base}-list`;

    /* ---------- 生成 DOM ---------- */
    const wrap = document.createElement('div');
    wrap.className = 'city-chooser';

    const input = document.createElement('input');
    input.setAttribute('hcw-input', '');   // 与手写的 <input hcw-input> 等价
    input.type = 'text';
    input.id = inputId;
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-autocomplete', 'list');
    for (const [key, value] of Object.entries(inputAttrs)) {
        if (value !== null && value !== undefined) input.setAttribute(key, String(value));
    }

    const arrow = document.createElement('span');
    arrow.className = 'city-chooser-arrow';
    arrow.setAttribute('aria-hidden', 'true');

    const list = document.createElement('ul');
    list.id = listId;
    list.className = 'city-chooser-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', ariaLabel);
    list.hidden = true;   // 关键：一创建就收起，避免脚本出错时浮层挡住表单

    wrap.append(input, arrow, list);

    let hintEl = null;
    if (hint instanceof HTMLElement) {
        hintEl = hint;                                   // 复用已有元素，不移动它
    } else if (hint !== false) {
        hintEl = document.createElement('p');
        hintEl.className = 'lp lp-hide';
        hintEl.id = typeof hint === 'string' ? hint : `${base}-hint`;
    }

    root.append(wrap);
    if (hintEl && !hintEl.isConnected) root.append(hintEl);

    /* ---------- 加载数据 + 挂载交互 ---------- */
    const cityData = data ?? await loadCityData();
    const chooser = createCityChooser({
        input,
        list,
        hint: hintEl,
        data: cityData,
        max,
        onPick,
        onInput,
        onClear,
    });

    return {
        ...chooser,
        root,
        wrap,
        input,
        list,
        hint: hintEl,

        /** 解绑事件并移除本次生成的 DOM（复用已有提示元素时不会删掉它） */
        remove() {
            chooser.destroy();
            wrap.remove();
            if (hintEl && hintEl.parentElement === root) hintEl.remove();
        },
    };
}
