// lib/vehicle-import.mjs
/**
 * 车辆信息批量导入：表头映射 + 行校验 + 分页 + CSV 模板
 *
 * 只做纯数据处理，不碰 DOM。CSV / XLSX 的文件解析复用
 * lib/timetable-import.mjs 的 parseTableFile；本模块负责把二维表格
 * 变成「车辆记录 + 错误清单」。
 *
 * 与单条写入保持同一套必填规则：公司、车型、燃料类型、车辆类型、车牌号前缀。
 * 其余字段可选，缺失时存空串。
 */

/** 车辆字段（顺序即导入模板列顺序） */
export const VEHICLE_FIELDS = [
    'selfNo', 'company', 'branch', 'model', 'operationStatus', 'fuelType',
    'vin', 'factoryNo', 'vehicleType', 'plateRegion', 'platePrefix', 'plateSuffix',
    'engine', 'motor', 'battery', 'transmission',
    'axle', 'chassis', 'tire', 'suspension', 'step',
    'airConditioner', 'door',
    'factoryDate', 'onlineDate', 'scrapDate', 'remark'
];

/** 与单条写入一致的必填字段 */
export const REQUIRED_FIELDS = ['company', 'model', 'fuelType', 'vehicleType', 'platePrefix'];

/** 字段中文名 */
export const FIELD_LABELS = {
    selfNo: '自编号',
    company: '公司',
    branch: '分公司/车队',
    model: '车型',
    operationStatus: '运营状态',
    fuelType: '燃料类型',
    vin: 'VIN码',
    factoryNo: '出厂编号',
    vehicleType: '车辆类型',
    plateRegion: '车牌地区',
    platePrefix: '车牌号前缀',
    plateSuffix: '车牌号后缀',
    engine: '发动机',
    motor: '电机',
    battery: '电池',
    transmission: '变速器',
    axle: '车桥',
    chassis: '底盘',
    tire: '轮胎',
    suspension: '悬挂',
    step: '踏步',
    airConditioner: '空调',
    door: '车门',
    factoryDate: '出厂日期',
    onlineDate: '上线日期',
    scrapDate: '报废日期',
    remark: '备注'
};

/**
 * 可识别的表头别名。匹配前会做与 normalizeHeader 相同的归一化，
 * 所以「VIN 码」「VIN码」「vin码」都能落到同一个字段。
 */
export const HEADER_ALIASES = {
    selfNo: ['自编号', '车辆自编号', '自编编号', '自编', '车辆编号', 'selfno'],
    company: ['公司', '公司名称', '所属公司', '运营公司', 'company'],
    branch: ['分公司/车队', '分公司车队', '分公司', '车队', 'branch'],
    model: ['车型', '车辆型号', '型号', 'model'],
    operationStatus: ['运营状态', '车辆状态', '状态', 'operationstatus'],
    fuelType: ['燃料类型', '能源类型', '燃料', 'fueltype', 'fuel'],
    vin: ['VIN码', 'VIN', '车架号', '车辆识别代号', '车辆识别码', 'vin'],
    factoryNo: ['出厂编号', '出厂号', '出厂序号', 'factoryno'],
    vehicleType: ['车辆类型', '车辆类别', '车型类别', 'vehicletype'],
    plateRegion: ['车牌地区', '车牌归属地', '号牌地区', 'plateregion'],
    platePrefix: ['车牌号前缀', '车牌前缀', '号牌前缀', '车牌号', '车牌', 'plateprefix'],
    plateSuffix: ['车牌号后缀', '车牌后缀', '号牌后缀', 'platesuffix'],
    engine: ['发动机', '发动机型号', 'engine'],
    motor: ['电机', '驱动电机', '电机型号', 'motor'],
    battery: ['电池', '电池类型', '电池型号', 'battery'],
    transmission: ['变速器', '变速箱', '变速器型号', 'transmission'],
    axle: ['车桥', '车桥型号', 'axle'],
    chassis: ['底盘', '底盘型号', 'chassis'],
    tire: ['轮胎', '轮胎规格', 'tire'],
    suspension: ['悬挂', '悬挂类型', '悬挂形式', 'suspension'],
    step: ['踏步', '踏步级数', 'step'],
    airConditioner: ['空调', '空调类型', '空调型号', 'airconditioner'],
    door: ['车门', '车门类型', 'door'],
    factoryDate: ['出厂日期', '生产日期', '制造日期', 'factorydate'],
    onlineDate: ['上线日期', '投入运营日期', '运营日期', 'onlinedate'],
    scrapDate: ['报废日期', '停用日期', '报废时间', 'scrapdate'],
    remark: ['备注', '说明', '附注', 'remark', 'note']
};

/** 预览表格的列（与页面里的表格一一对应） */
export const PREVIEW_LABELS = [
    '行号', '自编号', '公司', '车型', '燃料类型', '车辆类型', '车牌号', '状态'
];

export const TEMPLATE_FILENAME = '车辆信息导入模板.csv';

/** 模板里的示例行：不参与校验，只用于说明每一列怎么填 */
const TEMPLATE_EXAMPLE = {
    selfNo: 'C001',
    company: '示例公交公司',
    branch: '一分公司',
    model: '示例车型',
    operationStatus: '待上线',
    fuelType: '纯电动',
    vin: 'LSVAB2BM5EX123456',
    factoryNo: 'C2024001',
    vehicleType: '城市客车',
    plateRegion: '中国大陆',
    platePrefix: '沪A',
    plateSuffix: '12345',
    engine: '—',
    motor: '永磁同步电机',
    battery: '磷酸铁锂',
    transmission: '自动',
    axle: '前桥/后桥',
    chassis: '示例底盘',
    tire: '295/80R22.5',
    suspension: '空气悬挂',
    step: '二级',
    airConditioner: '冷暖空调',
    door: '内摆门',
    factoryDate: '2024-06-01',
    onlineDate: '2024-07-01',
    scrapDate: '',
    remark: '示例数据，可删除'
};

export const TEMPLATE_CSV = [
    VEHICLE_FIELDS.map((field) => FIELD_LABELS[field]).join(','),
    VEHICLE_FIELDS.map((field) => TEMPLATE_EXAMPLE[field] ?? '').join(',')
].join('\n') + '\n';

/* ------------------------------------------------------------------ */
/* 表头与行                                                            */
/* ------------------------------------------------------------------ */

/** 表头归一化：全角转半角、去空白 / 括号 / 斜杠 / 冒号，英文转小写 */
export function normalizeHeader(value) {
    return String(value ?? '')
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
        .replace(/\u3000/g, '')
        .replace(/\s+/g, '')
        .replace(/[（）()]/g, '')
        .replace(/[\/／]/g, '')
        .replace(/[：:]/g, '')
        .toLowerCase();
}

/**
 * 表头行 → 各字段列下标
 * @returns {{indices: Object<string, number>, missing: string[]}}
 */
export function mapHeader(headerRow) {
    const cells = Array.isArray(headerRow) ? headerRow : [];
    const normalized = cells.map(normalizeHeader);
    const indices = {};
    const missing = [];

    VEHICLE_FIELDS.forEach((field) => {
        let index = -1;
        for (const alias of HEADER_ALIASES[field]) {
            const at = normalized.indexOf(normalizeHeader(alias));
            if (at >= 0) {
                index = at;
                break;
            }
        }
        indices[field] = index;
        if (index < 0 && REQUIRED_FIELDS.includes(field)) {
            missing.push(FIELD_LABELS[field]);
        }
    });

    return { indices, missing };
}

/**
 * 找表头行：优先取前 10 行里第一条能认出全部必填表头的行；
 * 都认不出时退回第一条非空行，交给 validateRows 报「表头缺少」。
 */
export function findHeaderRowIndex(rows) {
    if (!Array.isArray(rows)) return -1;

    let firstNonEmpty = -1;
    const limit = Math.min(rows.length, 10);
    for (let i = 0; i < limit; i += 1) {
        const row = Array.isArray(rows[i]) ? rows[i] : [];
        if (!row.some((value) => String(value ?? '').trim() !== '')) continue;
        if (firstNonEmpty < 0) firstNonEmpty = i;
        if (mapHeader(row).missing.length === 0) return i;
    }
    return firstNonEmpty;
}

/** 车牌地区归一化：空值默认中国大陆，香港 / 大陆两种常见写法统一 */
export function normalizePlateRegion(value) {
    const text = String(value ?? '').trim();
    if (!text) return '中国大陆';
    if (/香港|hk/i.test(text)) return '中国香港';
    if (/大陆|内地|mainland/i.test(text)) return '中国大陆';
    return text;
}

/** 预览用的完整车牌号 */
export function formatPlate(record) {
    return `${record?.platePrefix ?? ''}${record?.plateSuffix ?? ''}`.trim();
}

/**
 * 校验数据行
 * @param {string[][]} rows 含表头的二维数组
 * @param {number} headerIndex 表头行下标
 * @returns {{records: Object[], errors: Object[], indices: Object}}
 *          records 里同时保留非法行（valid=false），供预览标红；errors 为问题清单。
 */
export function validateRows(rows, headerIndex) {
    const headerRow = Array.isArray(rows?.[headerIndex]) ? rows[headerIndex] : [];
    const { indices, missing } = mapHeader(headerRow);

    if (missing.length > 0) {
        return {
            records: [],
            errors: [{
                row: headerIndex + 1,
                field: 'header',
                message: '表头缺少：' + missing.join('、')
            }],
            indices
        };
    }

    const records = [];
    const errors = [];

    for (let i = headerIndex + 1; i < rows.length; i += 1) {
        const cells = Array.isArray(rows[i]) ? rows[i] : [];
        if (!cells.some((value) => String(value ?? '').trim() !== '')) continue;

        const rowNumber = i + 1;
        const record = { row: rowNumber, valid: true };
        VEHICLE_FIELDS.forEach((field) => {
            const index = indices[field];
            record[field] = index >= 0 ? String(cells[index] ?? '').trim() : '';
        });
        record.plateRegion = normalizePlateRegion(record.plateRegion);

        const missingFields = REQUIRED_FIELDS.filter((field) => !record[field]);
        if (missingFields.length > 0) {
            record.valid = false;
            errors.push({
                row: rowNumber,
                field: missingFields[0],
                message: '缺少必填项：' + missingFields.map((field) => FIELD_LABELS[field]).join('、')
            });
        }
        records.push(record);
    }

    return { records, errors, indices };
}

/** 分页切片（页码会被夹到 1..totalPages） */
export function paginate(items, page = 1, pageSize = 20) {
    const list = Array.isArray(items) ? items : [];
    const size = Math.max(1, Number(pageSize) || 20);
    const total = list.length;
    const totalPages = Math.max(1, Math.ceil(total / size));
    const current = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const start = (current - 1) * size;
    return {
        items: list.slice(start, start + size),
        page: current,
        pageSize: size,
        total,
        totalPages
    };
}
