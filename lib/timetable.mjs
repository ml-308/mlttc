// lib/timetable.mjs
/**
 * 时刻表相关的纯函数工具
 *
 * 这些函数原先在 src/pages/timetable-result.js 与 src/pages/timetables.js 中各抄了一份
 * （两份仅在缩进/引号/注释上有差别 —— 以及 timetables.js 里多了一段冗余的重复条件和一个
 * 调试 console.log）。现统一到本模块，两个页面共用。
 *
 * 注意：以下同名函数**不在**本模块内，因为它们在不同页面里是**不同的契约或实现**，
 * 盲目合并会改变行为：
 *   - formatTimeDisplay：详情页返回「时刻字符串数组」，列表页返回「截断后的显示字符串」
 *   - msgout：4 个页面各自演化（参数顺序、innerHTML/textContent 均不同）
 *   - cleaninput：timetables.js 版本多一行 input.value = ""（会清空输入框）
 */

/**
 * 输入补全：若内容中不含目标后缀则补上
 * 例："上海" + "市" → "上海市"；"52" + "路" → "52路"；已有后缀则不重复添加
 *
 * @param {string} value 原始输入
 * @param {string} word  要补全的后缀（如「市」「路」「站」「)」）
 * @returns {string|null} 补全后的内容；输入为空（或只有空白）时返回 null
 */
export function Complete(value, word) {
    value = value.replace(/\s+/g, ' ').trim();
    if (!value) return null;

    const a = value.indexOf(word);
    if (a < 0) {
        value = value + word;
    }
    return value;
}

/**
 * 校验 4 位时刻格式 HHMM
 * 规则：必须是 4 位纯数字、0 <= 值 < 2400、分钟位（后两位）< 60
 * 例："0630" → true；"0680" → false（分钟 80 非法）；"2500" → false（用 2500 表示「未知」，另有分支处理）
 *
 * @param {string} time 4 位时刻字符串
 * @returns {boolean}
 */
export function timejudge(time) {
    if (time >= 2400 || time < 0 || time.length != 4 || isNaN(time) || time % 100 >= 60) {
        return false;
    }
    return true;
}

/**
 * 把空格分隔的 4 位时刻串格式化为可读文本
 * 每个时刻转成 "HH:MM" 并用制表符分隔，每 5 个换一行；排序后输出
 * 例："0700 0630" → "06:30\t07:00\t"
 *
 * @param {string} time 空格或换行分隔的 4 位时刻串
 * @returns {string} 格式化后的文本（末尾带制表符）
 */
export function timeformat(time) {
    time = time.replace(/\s+/g, ' ').trim();
    const timec = time.split(' ').sort();

    let out = '';
    let n = 0;
    for (let i = 0; i < timec.length; i++) {
        const naw = timec[i];
        if (naw == ' ' || naw == '') continue;

        out += naw.slice(0, 2) + ':' + naw.slice(2, 4) + '\t';
        n += 1;
        if (n == 5) {
            out += '\n';
            n = 0;
        }
    }
    return out;
}

/**
 * 校验并规范化「执行时间」
 * 支持 "2025.1.1" 与 "25.1.1"（两位年份自动补 "20" 前缀）
 *
 * @param {string} etime 例 "2025.1.1"
 * @returns {string|false} 合法时返回 "YYYY-MM-DD"；非法时返回 false
 */
export function ex_timejudege(etime) {
    const timec = etime.split('.');

    if (timec[0].length != 4) {
        timec[0] = '20' + timec[0];
    }

    if (timec.length != 3 || timec[0] <= 0 || timec[0].length != 4 ||
        timec[1] > 12 || timec[1] < 1 || timec[2] > 31 || timec[2] < 1 ||
        timec[1].length > 2 || timec[2].length > 2) {
        return false;
    }

    return timec[0] + '-' + timec[1] + '-' + timec[2];
}
