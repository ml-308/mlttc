// src/pages/tool-calc.js
/**
 * 计算工具箱（/tool-calc.html）的交互逻辑
 *
 * 职责：
 *   1. 科学计算器：表达式 → 分词 → 调度场算法求值（DEG/RAD、函数、幂、取余）
 *   2. 房贷计算器：等额本息 / 等额本金，月供、总利息与按年还款计划
 *   3. 个人所得税：按月度税率表估算应缴个税与到手工资
 *   4. BMI 测算：体质指数、中国标准体重评估、基础代谢率
 *
 * 依赖：/lib/ui/message.mjs、./tool-utils.mjs
 * 全程本地运算，不上传数据。
 */
import { showMessage } from '/lib/ui/message.mjs';
import { $, copyText, formatNumber } from './tool-utils.mjs';

/* =====================================================================
 * 共用小工具
 * ===================================================================== */

/** 往结果卡片写一行：<strong>标题</strong><code>内容</code>…（全部 textContent） */
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

/** 金额千分位，固定两位小数 */
function fmtMoney(n) {
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 绑定 .menu-bar 按钮组：点击后把 primary 挪到该按钮并回调 */
function bindMenuBar(barId, onPick) {
    const bar = document.getElementById(barId);
    if (!bar) return;
    bar.querySelectorAll('.menu-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            bar.querySelectorAll('.menu-btn').forEach((b) => b.removeAttribute('primary'));
            btn.setAttribute('primary', '');
            onPick(btn);
        });
    });
}

/** 取按钮组当前选中项的 data-* 值 */
function menuValue(barId, attr) {
    const btn = document.querySelector('#' + barId + ' .menu-btn[primary]');
    return btn ? btn.getAttribute('data-' + attr) : null;
}

/** 列表页锚点直达某张卡片（滚动到吸顶页头下方） */
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
 * 1. 科学计算器：分词 → 调度场（RPN） → 求值
 * ===================================================================== */

const CALC_FUNC = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan',
    'log', 'ln', 'sqrt', 'cbrt', 'abs', 'floor', 'ceil', 'round', 'exp'];
const CALC_CONST = { pi: Math.PI, e: Math.E };
const CALC_PREC = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, 'u-': 3, '^': 4 };
const CALC_RIGHT = { '^': true };   // 幂运算右结合

/**
 * 把表达式切成 token：数字 / 名称 / 运算符，兼容 × ÷ − 与全角括号
 * @param {string} src
 * @returns {{t:string,v:*}[]}
 */
function calcTokenize(src) {
    const s = String(src)
        .replace(/×/g, '*')
        .replace(/÷/g, '/')
        .replace(/−/g, '-')
        .replace(/（/g, '(')
        .replace(/）/g, ')')
        .replace(/π/g, ' pi ')
        .replace(/√/g, ' sqrt ');
    const tokens = [];
    let i = 0;
    while (i < s.length) {
        const c = s.charAt(i);
        if (/\s/.test(c)) { i++; continue; }
        const nm = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
        if (nm) { tokens.push({ t: 'num', v: parseFloat(nm[0]) }); i += nm[0].length; continue; }
        const id = /^[A-Za-z]+/.exec(s.slice(i));
        if (id) { tokens.push({ t: 'ident', v: id[0].toLowerCase() }); i += id[0].length; continue; }
        if ('+-*/^%()'.indexOf(c) >= 0) { tokens.push({ t: 'op', v: c }); i++; continue; }
        throw new Error('无法识别的字符「' + c + '」');
    }
    return tokens;
}

/** 补上隐式乘法：2π、3(4+5)、2sin(30) 这类写法 */
function calcInsertMul(tokens) {
    const out = [];
    for (let k = 0; k < tokens.length; k++) {
        const cur = tokens[k];
        const prev = out[out.length - 1];
        if (prev) {
            const prevEnds = prev.t === 'num'
                || (prev.t === 'ident' && CALC_CONST[prev.v] !== undefined)
                || (prev.t === 'op' && prev.v === ')');
            const curStarts = cur.t === 'num'
                || cur.t === 'ident'
                || (cur.t === 'op' && cur.v === '(');
            if (prevEnds && curStarts) out.push({ t: 'op', v: '*' });
        }
        out.push(cur);
    }
    return out;
}

/** 调度场算法：中缀 token → 后缀 RPN */
function calcToRPN(tokens) {
    const out = [];
    const stack = [];
    let prev = null;
    for (let k = 0; k < tokens.length; k++) {
        const tk = tokens[k];
        if (tk.t === 'num') {
            out.push(tk);
        } else if (tk.t === 'ident') {
            if (CALC_CONST[tk.v] !== undefined) {
                out.push({ t: 'num', v: CALC_CONST[tk.v] });
            } else if (CALC_FUNC.indexOf(tk.v) >= 0) {
                const next = tokens[k + 1];
                // 括号写法 sin(30)，或无括号简写 √16 / sin30 / log1000（参数是紧随其后的单个值）
                const nextOk = next && (next.v === '('
                    || next.t === 'num'
                    || (next.t === 'ident' && CALC_CONST[next.v] !== undefined));
                if (!nextOk) {
                    throw new Error('函数 ' + tk.v + ' 后面需要括号，例如 ' + tk.v + '(30)');
                }
                stack.push({ t: 'func', v: tk.v });
            } else {
                throw new Error('未知的名称「' + tk.v + '」');
            }
        } else if (tk.v === '(') {
            stack.push(tk);
        } else if (tk.v === ')') {
            let matched = false;
            while (stack.length) {
                const top = stack.pop();
                if (top.v === '(') { matched = true; break; }
                out.push(top);
            }
            if (!matched) throw new Error('括号不匹配：多了一个「)」');
            if (stack.length && stack[stack.length - 1].t === 'func') out.push(stack.pop());
        } else {
            // 无括号简写（如 √16）的函数此刻已经拿到参数，遇到后面的运算符先弹出，
            // 这样它只作用于紧随其后的那一个值（√16^2 = (√16)^2）
            while (stack.length && stack[stack.length - 1].t === 'func' && out.length > 0) {
                out.push(stack.pop());
            }
            // 出现在开头或运算符之后的正负号是一元号
            const isUnary = prev === null || (prev.t === 'op' && prev.v !== ')');
            if (tk.v === '-' && isUnary) {
                stack.push({ t: 'op', v: 'u-' });
                prev = { t: 'op', v: 'u-' };
                continue;
            }
            if (tk.v === '+' && isUnary) {
                prev = { t: 'op', v: 'u+' };
                continue;   // 一元正号无意义，直接丢掉
            }
            const p = CALC_PREC[tk.v];
            if (p === undefined) throw new Error('不支持的运算符「' + tk.v + '」');
            while (stack.length) {
                const top = stack[stack.length - 1];
                if (top.t !== 'op') break;
                const tp = CALC_PREC[top.v];
                if (tp === undefined) break;
                if (CALC_RIGHT[tk.v] ? tp > p : tp >= p) out.push(stack.pop());
                else break;
            }
            stack.push({ t: 'op', v: tk.v });
        }
        prev = tk;
    }
    while (stack.length) {
        const top = stack.pop();
        if (top.v === '(') throw new Error('括号不匹配：少了一个「)」');
        out.push(top);
    }
    return out;
}

/** 函数求值；deg = true 时三角函数按角度制 */
function calcApplyFunc(name, a, deg) {
    const toRad = (x) => (deg ? x * Math.PI / 180 : x);
    const fromRad = (x) => (deg ? x * 180 / Math.PI : x);
    switch (name) {
        case 'sin': return Math.sin(toRad(a));
        case 'cos': return Math.cos(toRad(a));
        case 'tan': return Math.tan(toRad(a));
        case 'asin': return fromRad(Math.asin(a));
        case 'acos': return fromRad(Math.acos(a));
        case 'atan': return fromRad(Math.atan(a));
        case 'log':
            if (a <= 0) throw new Error('log 的参数必须大于 0');
            return Math.log10(a);
        case 'ln':
            if (a <= 0) throw new Error('ln 的参数必须大于 0');
            return Math.log(a);
        case 'sqrt':
            if (a < 0) throw new Error('负数不能开平方');
            return Math.sqrt(a);
        case 'cbrt': return Math.cbrt(a);
        case 'abs': return Math.abs(a);
        case 'floor': return Math.floor(a);
        case 'ceil': return Math.ceil(a);
        case 'round': return Math.round(a);
        case 'exp': return Math.exp(a);
    }
    throw new Error('未知函数「' + name + '」');
}

/** 双目运算符求值 */
function calcApplyOp(op, a, b) {
    switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
            if (b === 0) throw new Error('除数不能为 0');
            return a / b;
        case '%':
            if (b === 0) throw new Error('取余的除数不能为 0');
            return a % b;
        case '^': return Math.pow(a, b);
    }
    throw new Error('未知运算符「' + op + '」');
}

/** 后缀表达式求值 */
function calcEvalRPN(rpn, deg) {
    const st = [];
    for (let k = 0; k < rpn.length; k++) {
        const tk = rpn[k];
        if (tk.t === 'num') { st.push(tk.v); continue; }
        if (tk.t === 'func') {
            if (!st.length) throw new Error('表达式不完整');
            st.push(calcApplyFunc(tk.v, st.pop(), deg));
            continue;
        }
        if (tk.v === 'u-') {
            if (!st.length) throw new Error('表达式不完整');
            st.push(-st.pop());
            continue;
        }
        if (st.length < 2) throw new Error('表达式不完整');
        const b = st.pop();
        const a = st.pop();
        st.push(calcApplyOp(tk.v, a, b));
    }
    if (st.length !== 1) throw new Error('表达式不完整，请检查运算符与括号');
    return st[0];
}

/**
 * 表达式求值入口
 * @param {string} src 表达式
 * @param {boolean} deg true = 角度制
 * @returns {number} 有限数值（否则抛错）
 */
function calcEval(src, deg) {
    const tokens = calcInsertMul(calcTokenize(src));
    if (!tokens.length) throw new Error('表达式是空的');
    const result = calcEvalRPN(calcToRPN(tokens), deg);
    if (!Number.isFinite(result)) throw new Error('结果不是有限数值');
    return result;
}

/* =====================================================================
 * 2. 房贷计算
 * ===================================================================== */

/**
 * 房贷核心计算
 * @param {'ai'|'ap'} mode ai = 等额本息，ap = 等额本金
 * @param {number} principal 本金（元）
 * @param {number} years 年限
 * @param {number} annualRate 年利率（%，如 3.1）
 */
function loanCalc(mode, principal, years, annualRate) {
    const n = Math.round(years * 12);
    const i = annualRate / 100 / 12;
    const out = { mode, n, monthly: 0, monthlyFirst: 0, monthlyLast: 0, totalPay: 0, totalInterest: 0 };
    if (mode === 'ai') {
        const monthly = i === 0
            ? principal / n
            : principal * i * Math.pow(1 + i, n) / (Math.pow(1 + i, n) - 1);
        out.monthly = monthly;
        out.totalPay = monthly * n;
        out.totalInterest = out.totalPay - principal;
    } else {
        const base = principal / n;
        out.monthlyFirst = base + principal * i;
        out.monthlyLast = base + base * i;
        for (let k = 1; k <= n; k++) out.totalInterest += (principal - base * (k - 1)) * i;
        out.totalPay = principal + out.totalInterest;
    }
    return out;
}

/**
 * 按年汇总的还款计划
 * @returns {{year:number,pay:number,principal:number,interest:number,balance:number}[]}
 */
function loanSchedule(mode, principal, years, annualRate) {
    const n = Math.round(years * 12);
    const i = annualRate / 100 / 12;
    const base = principal / n;
    const monthly = (mode === 'ai')
        ? (i === 0 ? principal / n : principal * i * Math.pow(1 + i, n) / (Math.pow(1 + i, n) - 1))
        : 0;
    const rows = [];
    let balance = principal;
    let yearP = 0;
    let yearI = 0;
    for (let k = 1; k <= n; k++) {
        const int = balance * i;
        const prin = mode === 'ai' ? monthly - int : base;
        balance -= prin;
        if (balance < 1e-6 || k === n) balance = 0;
        yearP += prin;
        yearI += int;
        if (k % 12 === 0 || k === n) {
            rows.push({
                year: Math.ceil(k / 12),
                pay: yearP + yearI,
                principal: yearP,
                interest: yearI,
                balance: Math.max(0, balance)
            });
            yearP = 0;
            yearI = 0;
        }
    }
    return rows;
}

/* =====================================================================
 * 3. 个人所得税（月度税率表）
 * ===================================================================== */

const TAX_BRACKETS = [
    { cap: 3000, rate: 0.03, ded: 0 },
    { cap: 12000, rate: 0.1, ded: 210 },
    { cap: 25000, rate: 0.2, ded: 1410 },
    { cap: 35000, rate: 0.25, ded: 2660 },
    { cap: 55000, rate: 0.3, ded: 4410 },
    { cap: 80000, rate: 0.35, ded: 7160 },
    { cap: Infinity, rate: 0.45, ded: 15160 }
];

/**
 * 按月度税率表估算个税
 * @param {number} income 税前月薪
 * @param {number} social 五险一金个人部分
 * @param {number} special 专项附加扣除
 */
function taxCalc(income, social, special) {
    const taxable = Math.max(0, income - 5000 - social - special);
    let b = TAX_BRACKETS[TAX_BRACKETS.length - 1];
    for (let k = 0; k < TAX_BRACKETS.length; k++) {
        if (taxable <= TAX_BRACKETS[k].cap) { b = TAX_BRACKETS[k]; break; }
    }
    const tax = Math.max(0, taxable * b.rate - b.ded);
    return { taxable, rate: b.rate, ded: b.ded, tax, net: income - social - tax };
}

/* =====================================================================
 * 4. BMI 与基础代谢
 * ===================================================================== */

/**
 * @param {number} heightCm 身高 cm
 * @param {number} weightKg 体重 kg
 * @param {number} age 年龄
 * @param {'m'|'f'} sex
 */
function bmiCalc(heightCm, weightKg, age, sex) {
    const h = heightCm / 100;
    const bmi = weightKg / (h * h);
    let category;
    if (bmi < 18.5) category = '偏瘦';
    else if (bmi < 24) category = '正常';
    else if (bmi < 28) category = '超重';
    else category = '肥胖';
    const ideal = heightCm - 105;           // 简易标准体重
    const low = ideal * 0.9;
    const high = ideal * 1.1;
    const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'm' ? 5 : -161);
    let advice;
    if (weightKg < low) advice = '低于标准范围，建议增重约 ' + (low - weightKg).toFixed(1) + ' kg';
    else if (weightKg > high) advice = '超出标准范围，建议减重约 ' + (weightKg - high).toFixed(1) + ' kg';
    else advice = '体重处于标准范围，保持即可';
    return { bmi, category, ideal, low, high, bmr, advice };
}

/* =====================================================================
 * 页面交互
 * ===================================================================== */
document.addEventListener('DOMContentLoaded', () => {
    if (!$('calcIn')) return;

    /** 每个工具最近一次的结果纯文本，供「复制」使用 */
    const last = { calc: '', loan: '', tax: '', bmi: '' };

    /** 结果卡片写入并同时保存可复制的纯文本 */
    function showBox(box, lines, text) {
        box.classList.remove('hidden');
        box.innerHTML = '';
        lines.forEach((ln) => row(box, ln[0], ln[1]));
        return text;
    }

    /** 读取一个数字输入，非法返回 null */
    function readNum(id) {
        const v = parseFloat($(id).value);
        return Number.isFinite(v) ? v : null;
    }

    // ---------- 1. 科学计算器 ----------
    let angleMode = 'deg';
    bindMenuBar('angleBar', (btn) => { angleMode = btn.getAttribute('data-angle'); });

    // 快捷按钮：把符号插到光标位置
    document.querySelectorAll('#calcIns hcw-button').forEach((btn) => {
        btn.addEventListener('click', () => {
            const el = $('calcIn');
            const ins = btn.getAttribute('data-ins') || '';
            const start = el.selectionStart == null ? el.value.length : el.selectionStart;
            const end = el.selectionEnd == null ? start : el.selectionEnd;
            el.value = el.value.slice(0, start) + ins + el.value.slice(end);
            el.focus();
            if (el.setSelectionRange) el.setSelectionRange(start + ins.length, start + ins.length);
        });
    });

    function calcRun() {
        const src = $('calcIn').value.trim();
        if (!src) { showMessage('请先输入表达式', true); return; }
        let result;
        try {
            result = calcEval(src, angleMode === 'deg');
        } catch (err) {
            last.calc = '';
            showBox($('calcOut'), [['计算失败', [err.message]]], '');
            showMessage('算式有误', true);
            return;
        }
        const res = formatNumber(result);
        last.calc = res;
        showBox($('calcOut'), [
            ['表达式', [src]],
            ['角度模式', angleMode === 'deg' ? 'DEG 角度制' : 'RAD 弧度制'],
            ['结果', [res]]
        ], res);
        showMessage('计算完成');
    }

    $('calcGo').addEventListener('click', calcRun);
    $('calcIn').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') calcRun();
    });
    $('calcCopy').addEventListener('click', () => {
        if (!last.calc) { showMessage('还没有计算结果', true); return; }
        copyText(last.calc);
    });
    $('calcClear').addEventListener('click', () => {
        $('calcIn').value = '';
        $('calcOut').classList.add('hidden');
        $('calcOut').innerHTML = '';
        last.calc = '';
        showMessage('已清空');
    });

    // ---------- 2. 房贷 ----------
    bindMenuBar('lnModeBar', () => { /* 取值在计算时读取，无需缓存 */ });

    /** 读取并校验房贷输入；非法返回 null */
    function loanInputs() {
        const amount = readNum('lnAmount');
        const years = readNum('lnYears');
        const rate = readNum('lnRate');
        if (amount === null || amount <= 0) { showMessage('贷款金额要大于 0', true); return null; }
        if (years === null || years < 1 || years > 50) { showMessage('年限需在 1-50 年之间', true); return null; }
        if (rate === null || rate < 0) { showMessage('年利率不能为负', true); return null; }
        return { amount, years, rate, mode: menuValue('lnModeBar', 'mode') || 'ai' };
    }

    function loanRun() {
        const inp = loanInputs();
        if (!inp) return;
        const principal = inp.amount * 10000;
        const r = loanCalc(inp.mode, principal, inp.years, inp.rate);
        const name = inp.mode === 'ai' ? '等额本息' : '等额本金';
        const lines = [
            ['贷款本金', [fmtMoney(principal) + ' 元']],
            ['期限 / 年利率', [inp.years + ' 年', inp.rate + '%']]
        ];
        if (inp.mode === 'ai') lines.push(['每月月供', [fmtMoney(r.monthly) + ' 元']]);
        else lines.push(['首月 / 末月', [fmtMoney(r.monthlyFirst) + ' 元', fmtMoney(r.monthlyLast) + ' 元']]);
        lines.push(['还款总额', [fmtMoney(r.totalPay) + ' 元']]);
        lines.push(['利息合计', [fmtMoney(r.totalInterest) + ' 元']]);
        lines.push(['利息 / 本金', [(r.totalInterest / principal * 100).toFixed(2) + '%']]);
        lines.push(['计算方式', [name]]);

        last.loan = [
            '贷款本金：' + fmtMoney(principal) + ' 元',
            '期限：' + inp.years + ' 年　年利率：' + inp.rate + '%　方式：' + name,
            inp.mode === 'ai'
                ? '每月月供：' + fmtMoney(r.monthly) + ' 元'
                : '首月：' + fmtMoney(r.monthlyFirst) + ' 元　末月：' + fmtMoney(r.monthlyLast) + ' 元',
            '还款总额：' + fmtMoney(r.totalPay) + ' 元',
            '利息合计：' + fmtMoney(r.totalInterest) + ' 元'
        ].join('\n');
        showBox($('lnOut'), lines, last.loan);
        showMessage('计算完成');
    }

    function loanPlanRun() {
        const inp = loanInputs();
        if (!inp) return;
        const rows = loanSchedule(inp.mode, inp.amount * 10000, inp.years, inp.rate);
        const lines = [['计划说明', [inp.mode === 'ai' ? '等额本息' : '等额本金', '共 ' + rows.length + ' 年']]];
        rows.forEach((r) => {
            lines.push(['第 ' + r.year + ' 年', [
                '本息 ' + fmtMoney(r.pay),
                '本金 ' + fmtMoney(r.principal),
                '利息 ' + fmtMoney(r.interest),
                '剩余 ' + fmtMoney(r.balance)
            ]]);
        });
        showBox($('lnPlanOut'), lines, '');
        showMessage('已生成 ' + rows.length + ' 年的还款计划');
    }

    $('lnGo').addEventListener('click', loanRun);
    $('lnPlan').addEventListener('click', loanPlanRun);
    $('lnCopy').addEventListener('click', () => {
        if (!last.loan) { showMessage('先点一次「计算月供」', true); return; }
        copyText(last.loan);
    });

    // ---------- 3. 个人所得税 ----------
    function taxRun() {
        const income = readNum('txIncome');
        const social = readNum('txSocial');
        const special = readNum('txSpecial');
        if (income === null || income < 0) { showMessage('请填写税前月薪', true); return; }
        if (social === null || social < 0) { showMessage('五险一金不能为负', true); return; }
        if (special === null || special < 0) { showMessage('专项附加扣除不能为负', true); return; }
        const r = taxCalc(income, social, special);
        const lines = [
            ['税前月薪', [fmtMoney(income) + ' 元']],
            ['五险一金 / 专项扣除', [fmtMoney(social) + ' 元', fmtMoney(special) + ' 元']],
            ['应纳税所得额', [fmtMoney(r.taxable) + ' 元']],
            ['适用税率 / 速算扣除', [(r.rate * 100) + '%', fmtMoney(r.ded) + ' 元']],
            ['应缴个税', [fmtMoney(r.tax) + ' 元']],
            ['实发到手', [fmtMoney(r.net) + ' 元']],
            ['税负率', [income > 0 ? (r.tax / income * 100).toFixed(2) + '%' : '0%']]
        ];
        last.tax = [
            '税前月薪：' + fmtMoney(income) + ' 元',
            '应纳税所得额：' + fmtMoney(r.taxable) + ' 元',
            '税率：' + (r.rate * 100) + '%　速算扣除：' + fmtMoney(r.ded) + ' 元',
            '应缴个税：' + fmtMoney(r.tax) + ' 元',
            '实发到手：' + fmtMoney(r.net) + ' 元'
        ].join('\n');
        showBox($('txOut'), lines, last.tax);
        showMessage('计算完成（按月度税率表估算）');
    }

    $('txGo').addEventListener('click', taxRun);
    $('txCopy').addEventListener('click', () => {
        if (!last.tax) { showMessage('先点一次「计算个税」', true); return; }
        copyText(last.tax);
    });

    // ---------- 4. BMI ----------
    bindMenuBar('bmiSexBar', () => { /* 性别在计算时读取 */ });

    function bmiRun() {
        const h = readNum('bmiH');
        const w = readNum('bmiW');
        const age = readNum('bmiAge');
        if (h === null || h < 50 || h > 250) { showMessage('身高需在 50-250 cm 之间', true); return; }
        if (w === null || w < 10 || w > 300) { showMessage('体重需在 10-300 kg 之间', true); return; }
        if (age === null || age < 1 || age > 120) { showMessage('年龄需在 1-120 岁之间', true); return; }
        const sex = menuValue('bmiSexBar', 'sex') || 'm';
        const r = bmiCalc(h, w, age, sex);
        const lines = [
            ['BMI', [r.bmi.toFixed(1), r.category + '（中国标准）']],
            ['标准体重', [r.ideal.toFixed(1) + ' kg']],
            ['建议范围', [r.low.toFixed(1) + ' - ' + r.high.toFixed(1) + ' kg']],
            ['基础代谢', [Math.round(r.bmr) + ' 千卡 / 天']],
            ['评估', [r.advice]]
        ];
        last.bmi = [
            'BMI：' + r.bmi.toFixed(1) + '（' + r.category + '）',
            '标准体重：' + r.ideal.toFixed(1) + ' kg，建议范围 ' + r.low.toFixed(1) + '-' + r.high.toFixed(1) + ' kg',
            '基础代谢：' + Math.round(r.bmr) + ' 千卡 / 天',
            r.advice
        ].join('\n');
        showBox($('bmiOut'), lines, last.bmi);
        showMessage('测算完成');
    }

    $('bmiGo').addEventListener('click', bmiRun);
    $('bmiCopy').addEventListener('click', () => {
        if (!last.bmi) { showMessage('先点一次「测算」', true); return; }
        copyText(last.bmi);
    });

    // 从列表页锚点进入时，滚动到对应卡片
    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
});
