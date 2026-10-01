// lib/data/city-data.mjs
/**
 * 城市数据的加载与缓存
 *
 * 数据本体在 lib/data/cities.json（与代码分离，增删城市不必碰逻辑）：
 *   {
 *     "cities":     [ { province, city, plate, parent? }, ... ]
 *                   // 省份 / 城市 / 车牌前缀
 *                   // 县级市多一个 parent（所属地级市，不带「市」），省直辖的没有
 *                   // 例：{"province":"江苏省","parent":"无锡","city":"宜兴","plate":"苏B"}
 *                   //     -> 入库写法「江苏省 无锡市-宜兴市」
 *     "pinyin":     { "上": "shang", ... }               // 汉字 → 拼音（无声调，ü 记作 v）
 *     "exceptions": { "六安": [["lu","an"], ["liu","an"]], ... }  // 整词多读音特例
 *   }
 *
 * 用法：
 *   import { loadCityData, loadCities } from '/lib/data/city-data.mjs';
 *
 *   const { cities, pinyin, exceptions } = await loadCityData();
 *   const cities = await loadCities();          // 只要城市列表时的便捷写法
 *
 * 想直接得到一个「城市选择框」（连 DOM 一起生成），见 lib/data/city-picker.mjs。
 *
 * 特性：
 *   - 结果缓存：多次调用、多个组件共用同一次请求
 *   - 并发去重：同时发起的调用只会真的请求一次
 *   - 加载失败不抛错：返回空数据并打印原因，页面其余功能照常
 *     （否则一个数据文件出问题会把整个查询页拖垮）
 */

/** JSON 文件位置（绝对路径，页面均从站点根目录访问） */
export const CITY_DATA_URL = '/lib/data/cities.json';

/** 空数据：加载失败或字段缺失时使用，保证调用方不必到处判空 */
export function emptyCityData() {
    return { cities: [], pinyin: {}, exceptions: {} };
}

let cached = null;   // 已解析的数据
let pending = null;  // 进行中的请求（并发调用时复用）

/**
 * 把 JSON 规范成固定形状：缺字段就补空值
 * @param {*} raw JSON.parse 的结果
 * @returns {{cities: Array, pinyin: Object, exceptions: Object}}
 */
function normalize(raw) {
    if (!raw || typeof raw !== 'object') return emptyCityData();
    return {
        cities: Array.isArray(raw.cities) ? raw.cities : [],
        pinyin: raw.pinyin && typeof raw.pinyin === 'object' ? raw.pinyin : {},
        exceptions: raw.exceptions && typeof raw.exceptions === 'object' ? raw.exceptions : {},
    };
}

/**
 * 加载城市数据（带缓存，重复调用不会重复请求）
 * @returns {Promise<{cities: Array, pinyin: Object, exceptions: Object}>}
 */
export async function loadCityData() {
    if (cached) return cached;
    if (pending) return pending;

    pending = (async () => {
        try {
            const res = await fetch(CITY_DATA_URL);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            cached = normalize(await res.json());
        } catch (err) {
            console.error(`[city-data] 加载 ${CITY_DATA_URL} 失败：`, err);
            cached = emptyCityData();   // 记下来，避免每次输入都重试同一个坏文件
        } finally {
            pending = null;
        }
        return cached;
    })();

    return pending;
}

/**
 * 只要城市列表时的便捷写法
 * @returns {Promise<Array<{province: string, city: string, plate: string}>>}
 */
export async function loadCities() {
    return (await loadCityData()).cities;
}

/**
 * 同步读取「已加载」的数据，未加载时为 null。
 * 适合在渲染路径里不想 await 的地方；首次使用前请先 await loadCityData()。
 * @returns {{cities: Array, pinyin: Object, exceptions: Object}|null}
 */
export function getCityData() {
    return cached;
}

/**
 * 清空缓存（仅测试或热更新数据时需要）
 */
export function resetCityDataCache() {
    cached = null;
    pending = null;
}
