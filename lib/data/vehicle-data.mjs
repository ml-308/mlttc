// lib/data/vehicle-data.mjs
/**
 * 车辆信息页的数据加载与缓存：公司 / 车队 / 各字段候选
 *
 * 数据本体（与代码分离，增删不必碰逻辑）：
 *   - lib/data/companies.json        公司 + 车队
 *   - lib/data/vehicle-options.json  运营状态 / 燃料类型 / 车辆类型 / 品牌系列…
 *
 * 与 lib/data/city-data.mjs 同一套模式：
 *   - 结果缓存：多次调用只请求一次
 *   - 并发去重：同时发起的调用共用一个 Promise
 *   - 加载失败不抛错：返回空数据并打印原因，页面其余功能照常
 *
 * 用法：
 *   import { loadVehicleData, fieldItems, companyItems, fleetItems } from '/lib/data/vehicle-data.mjs';
 *
 *   const data = await loadVehicleData();
 *   picker.setItems(fieldItems(data, 'fuel-type'));
 */

export const COMPANIES_URL = '/lib/data/companies.json';
export const VEHICLE_OPTIONS_URL = '/lib/data/vehicle-options.json';

/** 空数据：加载失败时使用，保证调用方不必到处判空 */
export function emptyVehicleData() {
    return { companies: [], fleetSuggestions: [], fields: {} };
}

let cached = null;   // 已解析的数据
let pending = null;  // 进行中的请求（并发调用时复用）

/**
 * 把候选值规范成 { value, label, aliases }。
 * 支持两种写法：字符串，或 { value, label?, aliases? }。
 * @param {*} raw 原始条目
 * @returns {{value: string, label: string, aliases: string[]}|null}
 */
function normalizeItem(raw) {
    if (typeof raw === 'string') {
        const value = raw.trim();
        return value ? { value, label: value, aliases: [] } : null;
    }
    if (!raw || typeof raw !== 'object') return null;

    const value = String(raw.value ?? raw.label ?? '').trim();
    if (!value) return null;

    const label = String(raw.label ?? value);
    const aliases = Array.isArray(raw.aliases)
        ? raw.aliases.map((alias) => String(alias).trim()).filter(Boolean)
        : [];
    return { value, label, aliases };
}

/**
 * 把 JSON 规范成固定形状：缺字段就补空值
 * @param {*} rawOptions vehicle-options.json 的解析结果
 * @param {*} rawCompanies companies.json 的解析结果
 */
function normalize(rawOptions, rawCompanies) {
    const fields = {};
    const source = rawOptions && typeof rawOptions === 'object' ? rawOptions.fields : null;
    if (source && typeof source === 'object') {
        Object.keys(source).forEach((key) => {
            const list = Array.isArray(source[key]) ? source[key] : [];
            fields[key] = list.map(normalizeItem).filter(Boolean);
        });
    }

    const companies = [];
    const rawList = rawCompanies && Array.isArray(rawCompanies.companies) ? rawCompanies.companies : [];
    rawList.forEach((item) => {
        const name = String(item?.name ?? '').trim();
        if (!name) return;
        companies.push({
            name,
            short: String(item?.short ?? '').trim(),
            province: String(item?.province ?? '').trim(),
            city: String(item?.city ?? '').trim(),
            fleets: Array.isArray(item?.fleets) ? item.fleets.map((f) => String(f).trim()).filter(Boolean) : [],
        });
    });

    const fleetSuggestions = rawCompanies && Array.isArray(rawCompanies.fleetSuggestions)
        ? rawCompanies.fleetSuggestions.map((f) => String(f).trim()).filter(Boolean)
        : [];

    return { companies, fleetSuggestions, fields };
}

/**
 * 加载车辆页数据（带缓存）
 * @returns {Promise<{companies: Array, fleetSuggestions: string[], fields: Object}>}
 */
export async function loadVehicleData() {
    if (cached) return cached;
    if (pending) return pending;

    pending = (async () => {
        try {
            const [optionsRes, companiesRes] = await Promise.all([
                fetch(VEHICLE_OPTIONS_URL),
                fetch(COMPANIES_URL),
            ]);
            if (!optionsRes.ok) throw new Error(`${VEHICLE_OPTIONS_URL} HTTP ${optionsRes.status}`);
            if (!companiesRes.ok) throw new Error(`${COMPANIES_URL} HTTP ${companiesRes.status}`);

            const [options, companies] = await Promise.all([optionsRes.json(), companiesRes.json()]);
            cached = normalize(options, companies);
        } catch (err) {
            console.error('[vehicle-data] 加载候选数据失败：', err);
            cached = emptyVehicleData();   // 记下来，避免每次输入都重试同一个坏文件
        } finally {
            pending = null;
        }
        return cached;
    })();

    return pending;
}

/**
 * 同步读取「已加载」的数据，未加载时为 null
 * @returns {{companies: Array, fleetSuggestions: string[], fields: Object}|null}
 */
export function getVehicleData() {
    return cached;
}

/**
 * 取某个字段的候选（键名即控件 id）
 * @param {object|null} data loadVehicleData() 的返回值
 * @param {string} key 字段 id，如 'fuel-type'
 * @returns {Array<{value: string, label: string, aliases: string[]}>}
 */
export function fieldItems(data, key) {
    const source = data ?? cached;
    return (source && source.fields && source.fields[key]) || [];
}

/**
 * 公司候选：名称写入输入框，简称 / 城市 / 省份作为别名参与匹配
 * @param {object|null} data
 * @returns {Array<{value: string, label: string, aliases: string[]}>}
 */
export function companyItems(data) {
    const source = data ?? cached;
    const list = (source && source.companies) || [];
    return list.map((item) => ({
        value: item.name,
        label: item.name,
        aliases: [item.short, item.city, item.province].filter(Boolean),
    }));
}

/**
 * 车队候选：优先用该公司自带的 fleets，没有则退回落通用命名建议
 * @param {object|null} data
 * @param {string} companyName 当前输入框里的公司名（可为全称或简称）
 * @returns {Array<{value: string, label: string, aliases: string[]}>}
 */
export function fleetItems(data, companyName) {
    const source = data ?? cached;
    if (!source) return [];

    const query = String(companyName ?? '').trim();
    const company = query
        ? source.companies.find((item) => item.name === query || item.short === query)
        : null;

    const list = company && company.fleets.length > 0 ? company.fleets : source.fleetSuggestions;
    return list.map((name) => ({ value: name, label: name, aliases: [] }));
}

/**
 * 车牌号前缀候选：输入城市名（海口 / 无锡）或前缀（琼A）都能匹配。
 * 同一前缀覆盖多个城市时合并成一条，说明里展示前两个城市。
 *
 * @param {{cities: Array}|null} cityData loadCityData() 的返回值
 * @returns {Array<{value: string, label: string, description: string, aliases: string[]}>}
 */
export function platePrefixItems(cityData) {
    const groups = new Map();
    const cities = (cityData && cityData.cities) || [];

    cities.forEach((entry) => {
        const plate = String(entry.plate || '').trim().toUpperCase();
        if (!plate) return;

        const name = `${entry.city}${entry.suffix || '市'}`;
        let group = groups.get(plate);
        if (!group) {
            group = { cities: [], provinces: new Set() };
            groups.set(plate, group);
        }
        if (!group.cities.includes(name)) group.cities.push(name);
        if (entry.province) group.provinces.add(entry.province);
    });

    return Array.from(groups.entries()).map(([plate, group]) => ({
        value: plate,
        label: plate,
        description: group.cities.slice(0, 2).join(' / ')
            + (group.cities.length > 2 ? ` 等 ${group.cities.length} 地` : ''),
        aliases: [...group.cities, ...group.provinces],
    }));
}

/**
 * 信息未知时的占位代号：填它表示「暂不清楚，先留空」。
 * 接口接入后按 null 处理，不当作真实取值。
 */
export const UNKNOWN_CODE = 'UNKN';

/** 「未知」候选：排在所有字典的最前面 */
export const UNKNOWN_ITEM = {
    value: UNKNOWN_CODE,
    label: UNKNOWN_CODE,
    description: '信息未知（暂留空）',
    aliases: ['未知', '不清楚', '不知道', '待补充', '待确认', 'unknown', 'unk'],
};

/**
 * 在候选最前面加上「未知」代号（字典类字段都允许选它）。
 * @param {Array} items 原始候选
 * @returns {Array}
 */
export function withUnknown(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.some((item) => item && item.value === UNKNOWN_CODE)) return list;
    return [UNKNOWN_ITEM, ...list];
}

/** 清空缓存（仅测试或热更新数据时需要） */
export function resetVehicleDataCache() {
    cached = null;
    pending = null;
}
