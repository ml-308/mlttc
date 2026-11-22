// lib/data/match-picker.mjs
/**
 * 一键挂载「输入框 + 匹配下拉」
 *
 * 把页面上已有的 <input> 包进 .city-chooser 容器（沿用 style/main.css 里
 * 城市选择器那套样式：右侧箭头、浮层下拉、悬停高亮），再交给
 * lib/ui/match-chooser.mjs 处理匹配与键盘交互。
 *
 * 输入框的 id / name / 已绑定的事件全部保留（只是换了父节点）。
 *
 * 用法：
 *   import { attachMatchPicker } from '/lib/data/match-picker.mjs';
 *
 *   const picker = attachMatchPicker(document.getElementById('fuel-type'), {
 *       items: [{ value: '纯电动', label: '纯电动', aliases: [] }],
 *       strict: true,
 *   });
 *
 *   picker.setItems(next);   // 换候选（车队随公司变化）
 *   picker.reset();          // 静默清空（清空表单时用）
 *   picker.destroy();        // 还原 DOM 并解绑
 */

import { createMatchChooser } from '../ui/match-chooser.mjs';

/** 取输入框关联 label 的文案，用作下拉的无障碍名称 */
function labelTextOf(input) {
    if (!input.id) return '';
    const label = document.querySelector(`label[for="${input.id}"]`);
    return label ? label.textContent.trim() : '';
}

/**
 * 给输入框挂上匹配下拉。
 *
 * @param {HTMLInputElement} input 目标输入框
 * @param {object} [options] 透传给 createMatchChooser 的选项（items / getItems / strict / pinyin / 回调）
 * @returns {object} 选择器实例（含 input / list / wrap / setItems / reset / destroy 等）
 */
export function attachMatchPicker(input, options = {}) {
    if (!input) throw new Error('attachMatchPicker: 找不到输入框');
    if (input.closest('.city-chooser')) {
        throw new Error('attachMatchPicker: 该输入框已经挂过匹配下拉，不要重复挂载');
    }

    const wrap = document.createElement('div');
    wrap.className = 'city-chooser match-chooser';

    const arrow = document.createElement('span');
    arrow.className = 'city-chooser-arrow';
    arrow.setAttribute('aria-hidden', 'true');

    const list = document.createElement('ul');
    list.id = `${input.id || 'match'}-list`;
    list.className = 'city-chooser-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', options.ariaLabel || labelTextOf(input) || '可选项');
    list.hidden = true;

    // 原地包一层，输入框只是换父节点，id / name / 监听器都不受影响
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input, arrow, list);

    // 「全部」按钮：与下拉并列在 .match-row 里，点开即可看到该字段的全部候选
    const row = document.createElement('div');
    row.className = 'match-row';
    wrap.parentNode.insertBefore(row, wrap);
    row.append(wrap);

    const count = Array.isArray(options.items) ? options.items.length : 0;
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'match-all-btn';
    allBtn.textContent = '全部';
    allBtn.title = count ? `查看全部候选（${count} 条）` : '查看全部候选';
    allBtn.setAttribute('aria-label', (labelTextOf(input) || '该字段') + '的全部候选');
    row.append(allBtn);

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('autocomplete', 'off');

    const chooser = createMatchChooser({ ...options, input, list, ignoreClick: [allBtn] });

    // 按钮点击：已展开全部则收起，否则展开全部候选
    // mousedown 阻止默认行为，避免输入框先失焦触发 handleBlur→close，导致第二次点击又变成「展开」
    allBtn.addEventListener('mousedown', (event) => event.preventDefault());
    allBtn.addEventListener('click', () => {
        if (chooser.isShowingAll()) chooser.close();
        else chooser.openAll();
    });

    return {
        ...chooser,
        wrap,
        arrow,
        row,
        allBtn,

        /** 还原 DOM 并解绑所有事件 */
        destroy() {
            chooser.destroy();
            allBtn.remove();
            if (row.parentNode) {
                row.parentNode.insertBefore(input, row);
                row.remove();
            }
        },
    };
}
