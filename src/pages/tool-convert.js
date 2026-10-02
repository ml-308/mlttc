// src/pages/tool-convert.js
/**
 * 单位换算（/tool-convert.html）的交互逻辑
 *
 * 结构：CATS[分类] = { name, def: [默认从, 默认到], units: [{name, abbr, f}] }
 *   - 常规分类：以基准单位为 1，f 为该单位相对基准的系数（如 1 m = f 米）
 *   - temp 分类：无 f，改用 toBase / fromBase 两个函数做摄氏 / 华氏 / 开尔文换算
 *
 * 交互：顶部菜单栏切换分类 → 选单位或输数值即实时换算；「交换」对调两端。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { $, formatNumber, copyText } from './tool-utils.mjs';

const CATS = {
    length: {
        name: '长度',
        def: ['米', '厘米'],
        units: [
            { name: '米', abbr: 'm', f: 1 },
            { name: '千米', abbr: 'km', f: 1000 },
            { name: '厘米', abbr: 'cm', f: 0.01 },
            { name: '毫米', abbr: 'mm', f: 0.001 },
            { name: '微米', abbr: 'μm', f: 1e-6 },
            { name: '英里', abbr: 'mi', f: 1609.344 },
            { name: '码', abbr: 'yd', f: 0.9144 },
            { name: '英尺', abbr: 'ft', f: 0.3048 },
            { name: '英寸', abbr: 'in', f: 0.0254 },
            { name: '海里', abbr: 'nmi', f: 1852 },
        ],
    },
    area: {
        name: '面积',
        def: ['平方米', '亩'],
        units: [
            { name: '平方米', abbr: 'm²', f: 1 },
            { name: '平方千米', abbr: 'km²', f: 1e6 },
            { name: '公顷', abbr: 'ha', f: 10000 },
            { name: '亩', abbr: '亩', f: 666.6666666666667 },
            { name: '平方分米', abbr: 'dm²', f: 0.01 },
            { name: '平方厘米', abbr: 'cm²', f: 1e-4 },
            { name: '平方英里', abbr: 'mi²', f: 2589988.110336 },
            { name: '英亩', abbr: 'ac', f: 4046.8564224 },
            { name: '平方英尺', abbr: 'ft²', f: 0.09290304 },
            { name: '平方英寸', abbr: 'in²', f: 0.00064516 },
        ],
    },
    volume: {
        name: '体积',
        def: ['升', '毫升'],
        units: [
            { name: '升', abbr: 'L', f: 1 },
            { name: '毫升', abbr: 'mL', f: 0.001 },
            { name: '立方米', abbr: 'm³', f: 1000 },
            { name: '立方分米', abbr: 'dm³', f: 1 },
            { name: '立方厘米', abbr: 'cm³', f: 0.001 },
            { name: '美制加仑', abbr: 'gal', f: 3.785411784 },
            { name: '美制品脱', abbr: 'pt', f: 0.473176473 },
            { name: '美制液量盎司', abbr: 'fl oz', f: 0.0295735295625 },
            { name: '立方英尺', abbr: 'ft³', f: 28.316846592 },
            { name: '立方英寸', abbr: 'in³', f: 0.016387064 },
        ],
    },
    mass: {
        name: '重量',
        def: ['千克', '斤'],
        units: [
            { name: '千克', abbr: 'kg', f: 1 },
            { name: '克', abbr: 'g', f: 0.001 },
            { name: '毫克', abbr: 'mg', f: 1e-6 },
            { name: '吨', abbr: 't', f: 1000 },
            { name: '斤', abbr: '市斤', f: 0.5 },
            { name: '两', abbr: '市两', f: 0.05 },
            { name: '磅', abbr: 'lb', f: 0.45359237 },
            { name: '盎司', abbr: 'oz', f: 0.028349523125 },
            { name: '英石', abbr: 'st', f: 6.35029318 },
        ],
    },
    temp: {
        name: '温度',
        def: ['摄氏度', '华氏度'],
        units: [
            { name: '摄氏度', abbr: '°C' },
            { name: '华氏度', abbr: '°F' },
            { name: '开尔文', abbr: 'K' },
        ],
    },
    speed: {
        name: '速度',
        def: ['千米每小时', '米每秒'],
        units: [
            { name: '千米每小时', abbr: 'km/h', f: 1 / 3.6 },
            { name: '米每秒', abbr: 'm/s', f: 1 },
            { name: '英里每小时', abbr: 'mph', f: 0.44704 },
            { name: '节', abbr: 'kn', f: 0.5144444444444445 },
            { name: '马赫', abbr: 'Ma', f: 340.2777777777778 },
        ],
    },
    time: {
        name: '时间',
        def: ['小时', '分钟'],
        units: [
            { name: '秒', abbr: 's', f: 1 },
            { name: '毫秒', abbr: 'ms', f: 0.001 },
            { name: '分钟', abbr: 'min', f: 60 },
            { name: '小时', abbr: 'h', f: 3600 },
            { name: '天', abbr: 'd', f: 86400 },
            { name: '周', abbr: 'w', f: 604800 },
            { name: '月（30 天）', abbr: 'mo', f: 2592000 },
            { name: '年（365 天）', abbr: 'y', f: 31536000 },
        ],
    },
    data: {
        name: '数据',
        def: ['GB', 'MB'],
        units: [
            { name: '字节', abbr: 'B', f: 1 },
            { name: 'KB', abbr: 'KB', f: 1024 },
            { name: 'MB', abbr: 'MB', f: 1048576 },
            { name: 'GB', abbr: 'GB', f: 1073741824 },
            { name: 'TB', abbr: 'TB', f: 1099511627776 },
            { name: 'PB', abbr: 'PB', f: 1125899906842624 },
            { name: '比特', abbr: 'bit', f: 0.125 },
        ],
    },
};

let currentCat = 'length';

/** 温度：任意单位 → 摄氏度 */
function tempToC(value, name) {
    if (name === '摄氏度') return value;
    if (name === '华氏度') return (value - 32) * 5 / 9;
    return value - 273.15;
}

/** 温度：摄氏度 → 任意单位 */
function tempFromC(value, name) {
    if (name === '摄氏度') return value;
    if (name === '华氏度') return value * 9 / 5 + 32;
    return value + 273.15;
}

function unitByName(cat, name) {
    const found = CATS[cat].units.find((u) => u.name === name);
    return found || CATS[cat].units[0];
}

/** 用当前分类 / 单位 / 数值计算并显示 */
function convert() {
    const cat = CATS[currentCat];
    const from = unitByName(currentCat, $('cvFrom').value);
    const to = unitByName(currentCat, $('cvTo').value);
    const raw = $('cvIn').value.trim();

    if (raw === '' || isNaN(Number(raw))) {
        $('cvOut').value = '';
        $('cvFormula').textContent = '请输入有效数值';
        return;
    }
    const value = Number(raw);
    let result;
    if (currentCat === 'temp') {
        result = tempFromC(tempToC(value, from.name), to.name);
    } else {
        result = value * from.f / to.f;
    }
    $('cvOut').value = formatNumber(result);

    if (currentCat === 'temp') {
        $('cvFormula').textContent = '1 ' + from.name + ' = ' + formatNumber(tempFromC(tempToC(1, from.name), to.name)) + ' ' + to.name;
    } else {
        $('cvFormula').textContent = '1 ' + from.name + '（' + from.abbr + '）= '
            + formatNumber(from.f / to.f) + ' ' + to.name + '（' + to.abbr + '）';
    }
}

/** 切换分类：重建两个下拉框并套用默认单位 */
function switchCategory(cat, btn) {
    if (!CATS[cat]) return;
    currentCat = cat;
    document.querySelectorAll('#catBar .menu-btn').forEach((b) => b.removeAttribute('primary'));
    if (btn) btn.setAttribute('primary', '');

    const options = CATS[cat].units.map((u) => {
        const o = document.createElement('option');
        o.value = u.name;
        o.textContent = u.name + '（' + u.abbr + '）';
        return o;
    });
    const from = $('cvFrom');
    const to = $('cvTo');
    from.innerHTML = '';
    to.innerHTML = '';
    options.forEach((o) => {
        from.appendChild(o.cloneNode(true));
        to.appendChild(o.cloneNode(true));
    });
    from.value = CATS[cat].def[0];
    to.value = CATS[cat].def[1];
    convert();
}

document.addEventListener('DOMContentLoaded', () => {
    if (!$('cvFrom')) return;

    document.querySelectorAll('#catBar .menu-btn').forEach((btn) => {
        btn.addEventListener('click', () => switchCategory(btn.getAttribute('data-cat'), btn));
    });

    ['cvIn', 'cvFrom', 'cvTo'].forEach((id) => {
        const el = $(id);
        el.addEventListener('input', convert);
        el.addEventListener('change', convert);
    });

    $('cvSwapBtn').addEventListener('click', () => {
        const from = $('cvFrom');
        const to = $('cvTo');
        const tmp = from.value;
        from.value = to.value;
        to.value = tmp;
        convert();
    });

    $('cvCopyBtn').addEventListener('click', () => copyText($('cvOut').value));

    switchCategory('length', document.querySelector('#catBar .menu-btn[data-cat="length"]'));
});
