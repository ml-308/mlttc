// lib/ui/city-chooser.mjs
/**
 * 城市选择器（可输入 + 下拉列表）
 *
 * 特性：
 *   - 模糊匹配「省份 / 城市 / 车牌前缀」
 *   - 支持中文、全拼（shanghai）、拼音首字母（sh）
 *   - 多音字特例（六安 luan / liuan、重庆 chong qing / zhong qing 等）
 *   - 键盘导航：↑ ↓ 移动、Enter 选中、Esc 收起
 *   - 相关性排序，最多展示 max 条
 *
 * 用法：
 *   import { createCityChooser } from '/lib/ui/city-chooser.mjs';
 *
 *   const chooser = createCityChooser({
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
 */

/* ==================== 数据源：省份 / 城市 / 车牌前缀 ==================== */

export const CITY_DATA = [
    // ===== 直辖市 =====
    { province: '北京市', city: '北京', plate: '京A' },
    { province: '天津市', city: '天津', plate: '津A' },
    { province: '上海市', city: '上海', plate: '沪A' },
    { province: '重庆市', city: '重庆', plate: '渝A' },

    // ===== 河北省 =====
    { province: '河北省', city: '石家庄', plate: '冀A' },
    { province: '河北省', city: '唐山', plate: '冀B' },
    { province: '河北省', city: '秦皇岛', plate: '冀C' },
    { province: '河北省', city: '邯郸', plate: '冀D' },
    { province: '河北省', city: '邢台', plate: '冀E' },
    { province: '河北省', city: '保定', plate: '冀F' },
    { province: '河北省', city: '张家口', plate: '冀G' },
    { province: '河北省', city: '承德', plate: '冀H' },
    { province: '河北省', city: '沧州', plate: '冀J' },
    { province: '河北省', city: '廊坊', plate: '冀R' },
    { province: '河北省', city: '衡水', plate: '冀T' },

    // ===== 山西省 =====
    { province: '山西省', city: '太原', plate: '晋A' },
    { province: '山西省', city: '大同', plate: '晋B' },
    { province: '山西省', city: '阳泉', plate: '晋C' },
    { province: '山西省', city: '长治', plate: '晋D' },
    { province: '山西省', city: '晋城', plate: '晋E' },
    { province: '山西省', city: '朔州', plate: '晋F' },
    { province: '山西省', city: '忻州', plate: '晋H' },
    { province: '山西省', city: '吕梁', plate: '晋J' },
    { province: '山西省', city: '晋中', plate: '晋K' },
    { province: '山西省', city: '临汾', plate: '晋L' },
    { province: '山西省', city: '运城', plate: '晋M' },

    // ===== 内蒙古自治区 =====
    { province: '内蒙古自治区', city: '呼和浩特', plate: '蒙A' },
    { province: '内蒙古自治区', city: '包头', plate: '蒙B' },
    { province: '内蒙古自治区', city: '乌海', plate: '蒙C' },
    { province: '内蒙古自治区', city: '赤峰', plate: '蒙D' },
    { province: '内蒙古自治区', city: '呼伦贝尔', plate: '蒙E' },
    { province: '内蒙古自治区', city: '兴安盟', plate: '蒙F' },
    { province: '内蒙古自治区', city: '通辽', plate: '蒙G' },
    { province: '内蒙古自治区', city: '锡林郭勒盟', plate: '蒙H' },
    { province: '内蒙古自治区', city: '乌兰察布', plate: '蒙J' },
    { province: '内蒙古自治区', city: '鄂尔多斯', plate: '蒙K' },
    { province: '内蒙古自治区', city: '巴彦淖尔', plate: '蒙L' },
    { province: '内蒙古自治区', city: '阿拉善盟', plate: '蒙M' },

    // ===== 辽宁省 =====
    { province: '辽宁省', city: '沈阳', plate: '辽A' },
    { province: '辽宁省', city: '大连', plate: '辽B' },
    { province: '辽宁省', city: '鞍山', plate: '辽C' },
    { province: '辽宁省', city: '抚顺', plate: '辽D' },
    { province: '辽宁省', city: '本溪', plate: '辽E' },
    { province: '辽宁省', city: '丹东', plate: '辽F' },
    { province: '辽宁省', city: '锦州', plate: '辽G' },
    { province: '辽宁省', city: '营口', plate: '辽H' },
    { province: '辽宁省', city: '阜新', plate: '辽J' },
    { province: '辽宁省', city: '辽阳', plate: '辽K' },
    { province: '辽宁省', city: '盘锦', plate: '辽L' },
    { province: '辽宁省', city: '铁岭', plate: '辽M' },
    { province: '辽宁省', city: '朝阳', plate: '辽N' },
    { province: '辽宁省', city: '葫芦岛', plate: '辽P' },

    // ===== 吉林省 =====
    { province: '吉林省', city: '长春', plate: '吉A' },
    { province: '吉林省', city: '吉林', plate: '吉B' },
    { province: '吉林省', city: '四平', plate: '吉C' },
    { province: '吉林省', city: '辽源', plate: '吉D' },
    { province: '吉林省', city: '通化', plate: '吉E' },
    { province: '吉林省', city: '白山', plate: '吉F' },
    { province: '吉林省', city: '白城', plate: '吉G' },
    { province: '吉林省', city: '延边', plate: '吉H' },
    { province: '吉林省', city: '松原', plate: '吉J' },
    { province: '吉林省', city: '长白山保护开发区', plate: '吉K' },

    // ===== 黑龙江省 =====
    { province: '黑龙江省', city: '哈尔滨', plate: '黑A' },
    { province: '黑龙江省', city: '齐齐哈尔', plate: '黑B' },
    { province: '黑龙江省', city: '牡丹江', plate: '黑C' },
    { province: '黑龙江省', city: '佳木斯', plate: '黑D' },
    { province: '黑龙江省', city: '大庆', plate: '黑E' },
    { province: '黑龙江省', city: '伊春', plate: '黑F' },
    { province: '黑龙江省', city: '鸡西', plate: '黑G' },
    { province: '黑龙江省', city: '鹤岗', plate: '黑H' },
    { province: '黑龙江省', city: '双鸭山', plate: '黑J' },
    { province: '黑龙江省', city: '七台河', plate: '黑K' },
    { province: '黑龙江省', city: '绥化', plate: '黑M' },
    { province: '黑龙江省', city: '黑河', plate: '黑N' },
    { province: '黑龙江省', city: '大兴安岭', plate: '黑P' },

    // ===== 江苏省 =====
    { province: '江苏省', city: '南京', plate: '苏A' },
    { province: '江苏省', city: '无锡', plate: '苏B' },
    { province: '江苏省', city: '徐州', plate: '苏C' },
    { province: '江苏省', city: '常州', plate: '苏D' },
    { province: '江苏省', city: '苏州', plate: '苏E' },
    { province: '江苏省', city: '南通', plate: '苏F' },
    { province: '江苏省', city: '连云港', plate: '苏G' },
    { province: '江苏省', city: '淮安', plate: '苏H' },
    { province: '江苏省', city: '盐城', plate: '苏J' },
    { province: '江苏省', city: '扬州', plate: '苏K' },
    { province: '江苏省', city: '镇江', plate: '苏L' },
    { province: '江苏省', city: '泰州', plate: '苏M' },
    { province: '江苏省', city: '宿迁', plate: '苏N' },

    // ===== 浙江省 =====
    { province: '浙江省', city: '杭州', plate: '浙A' },
    { province: '浙江省', city: '宁波', plate: '浙B' },
    { province: '浙江省', city: '温州', plate: '浙C' },
    { province: '浙江省', city: '绍兴', plate: '浙D' },
    { province: '浙江省', city: '湖州', plate: '浙E' },
    { province: '浙江省', city: '嘉兴', plate: '浙F' },
    { province: '浙江省', city: '金华', plate: '浙G' },
    { province: '浙江省', city: '衢州', plate: '浙H' },
    { province: '浙江省', city: '台州', plate: '浙J' },
    { province: '浙江省', city: '丽水', plate: '浙K' },
    { province: '浙江省', city: '舟山', plate: '浙L' },

    // ===== 安徽省 =====
    { province: '安徽省', city: '合肥', plate: '皖A' },
    { province: '安徽省', city: '芜湖', plate: '皖B' },
    { province: '安徽省', city: '蚌埠', plate: '皖C' },
    { province: '安徽省', city: '淮南', plate: '皖D' },
    { province: '安徽省', city: '马鞍山', plate: '皖E' },
    { province: '安徽省', city: '淮北', plate: '皖F' },
    { province: '安徽省', city: '铜陵', plate: '皖G' },
    { province: '安徽省', city: '安庆', plate: '皖H' },
    { province: '安徽省', city: '黄山', plate: '皖J' },
    { province: '安徽省', city: '阜阳', plate: '皖K' },
    { province: '安徽省', city: '宿州', plate: '皖L' },
    { province: '安徽省', city: '滁州', plate: '皖M' },
    { province: '安徽省', city: '六安', plate: '皖N' },
    { province: '安徽省', city: '宣城', plate: '皖P' },
    { province: '安徽省', city: '池州', plate: '皖R' },
    { province: '安徽省', city: '亳州', plate: '皖S' },

    // ===== 福建省 =====
    { province: '福建省', city: '福州', plate: '闽A' },
    { province: '福建省', city: '莆田', plate: '闽B' },
    { province: '福建省', city: '泉州', plate: '闽C' },
    { province: '福建省', city: '厦门', plate: '闽D' },
    { province: '福建省', city: '漳州', plate: '闽E' },
    { province: '福建省', city: '龙岩', plate: '闽F' },
    { province: '福建省', city: '三明', plate: '闽G' },
    { province: '福建省', city: '南平', plate: '闽H' },
    { province: '福建省', city: '宁德', plate: '闽J' },

    // ===== 江西省 =====
    { province: '江西省', city: '南昌', plate: '赣A' },
    { province: '江西省', city: '赣州', plate: '赣B' },
    { province: '江西省', city: '宜春', plate: '赣C' },
    { province: '江西省', city: '吉安', plate: '赣D' },
    { province: '江西省', city: '上饶', plate: '赣E' },
    { province: '江西省', city: '抚州', plate: '赣F' },
    { province: '江西省', city: '九江', plate: '赣G' },
    { province: '江西省', city: '景德镇', plate: '赣H' },
    { province: '江西省', city: '萍乡', plate: '赣J' },
    { province: '江西省', city: '新余', plate: '赣K' },
    { province: '江西省', city: '鹰潭', plate: '赣L' },

    // ===== 山东省 =====
    { province: '山东省', city: '济南', plate: '鲁A' },
    { province: '山东省', city: '青岛', plate: '鲁B' },
    { province: '山东省', city: '淄博', plate: '鲁C' },
    { province: '山东省', city: '枣庄', plate: '鲁D' },
    { province: '山东省', city: '东营', plate: '鲁E' },
    { province: '山东省', city: '烟台', plate: '鲁F' },
    { province: '山东省', city: '潍坊', plate: '鲁G' },
    { province: '山东省', city: '济宁', plate: '鲁H' },
    { province: '山东省', city: '泰安', plate: '鲁J' },
    { province: '山东省', city: '威海', plate: '鲁K' },
    { province: '山东省', city: '日照', plate: '鲁L' },
    { province: '山东省', city: '德州', plate: '鲁N' },
    { province: '山东省', city: '聊城', plate: '鲁P' },
    { province: '山东省', city: '临沂', plate: '鲁Q' },
    { province: '山东省', city: '菏泽', plate: '鲁R' },

    // ===== 河南省 =====
    { province: '河南省', city: '郑州', plate: '豫A' },
    { province: '河南省', city: '开封', plate: '豫B' },
    { province: '河南省', city: '洛阳', plate: '豫C' },
    { province: '河南省', city: '平顶山', plate: '豫D' },
    { province: '河南省', city: '安阳', plate: '豫E' },
    { province: '河南省', city: '鹤壁', plate: '豫F' },
    { province: '河南省', city: '新乡', plate: '豫G' },
    { province: '河南省', city: '焦作', plate: '豫H' },
    { province: '河南省', city: '濮阳', plate: '豫J' },
    { province: '河南省', city: '许昌', plate: '豫K' },
    { province: '河南省', city: '漯河', plate: '豫L' },
    { province: '河南省', city: '三门峡', plate: '豫M' },
    { province: '河南省', city: '商丘', plate: '豫N' },
    { province: '河南省', city: '周口', plate: '豫P' },
    { province: '河南省', city: '驻马店', plate: '豫Q' },
    { province: '河南省', city: '南阳', plate: '豫R' },
    { province: '河南省', city: '信阳', plate: '豫S' },
    { province: '河南省', city: '济源', plate: '豫U' },

    // ===== 湖北省 =====
    { province: '湖北省', city: '武汉', plate: '鄂A' },
    { province: '湖北省', city: '黄石', plate: '鄂B' },
    { province: '湖北省', city: '十堰', plate: '鄂C' },
    { province: '湖北省', city: '荆州', plate: '鄂D' },
    { province: '湖北省', city: '宜昌', plate: '鄂E' },
    { province: '湖北省', city: '襄阳', plate: '鄂F' },
    { province: '湖北省', city: '鄂州', plate: '鄂G' },
    { province: '湖北省', city: '荆门', plate: '鄂H' },
    { province: '湖北省', city: '黄冈', plate: '鄂J' },
    { province: '湖北省', city: '孝感', plate: '鄂K' },
    { province: '湖北省', city: '咸宁', plate: '鄂L' },
    { province: '湖北省', city: '仙桃', plate: '鄂M' },
    { province: '湖北省', city: '潜江', plate: '鄂N' },
    { province: '湖北省', city: '神农架', plate: '鄂P' },
    { province: '湖北省', city: '恩施', plate: '鄂Q' },
    { province: '湖北省', city: '天门', plate: '鄂R' },
    { province: '湖北省', city: '随州', plate: '鄂S' },

    // ===== 湖南省 =====
    { province: '湖南省', city: '长沙', plate: '湘A' },
    { province: '湖南省', city: '株洲', plate: '湘B' },
    { province: '湖南省', city: '湘潭', plate: '湘C' },
    { province: '湖南省', city: '衡阳', plate: '湘D' },
    { province: '湖南省', city: '邵阳', plate: '湘E' },
    { province: '湖南省', city: '岳阳', plate: '湘F' },
    { province: '湖南省', city: '张家界', plate: '湘G' },
    { province: '湖南省', city: '益阳', plate: '湘H' },
    { province: '湖南省', city: '常德', plate: '湘J' },
    { province: '湖南省', city: '娄底', plate: '湘K' },
    { province: '湖南省', city: '郴州', plate: '湘L' },
    { province: '湖南省', city: '永州', plate: '湘M' },
    { province: '湖南省', city: '怀化', plate: '湘N' },
    { province: '湖南省', city: '湘西', plate: '湘U' },

    // ===== 广东省 =====
    { province: '广东省', city: '广州', plate: '粤A' },
    { province: '广东省', city: '深圳', plate: '粤B' },
    { province: '广东省', city: '珠海', plate: '粤C' },
    { province: '广东省', city: '汕头', plate: '粤D' },
    { province: '广东省', city: '佛山', plate: '粤E' },
    { province: '广东省', city: '韶关', plate: '粤F' },
    { province: '广东省', city: '湛江', plate: '粤G' },
    { province: '广东省', city: '肇庆', plate: '粤H' },
    { province: '广东省', city: '江门', plate: '粤J' },
    { province: '广东省', city: '茂名', plate: '粤K' },
    { province: '广东省', city: '惠州', plate: '粤L' },
    { province: '广东省', city: '梅州', plate: '粤M' },
    { province: '广东省', city: '汕尾', plate: '粤N' },
    { province: '广东省', city: '河源', plate: '粤P' },
    { province: '广东省', city: '阳江', plate: '粤Q' },
    { province: '广东省', city: '清远', plate: '粤R' },
    { province: '广东省', city: '东莞', plate: '粤S' },
    { province: '广东省', city: '中山', plate: '粤T' },
    { province: '广东省', city: '潮州', plate: '粤U' },
    { province: '广东省', city: '揭阳', plate: '粤V' },
    { province: '广东省', city: '云浮', plate: '粤W' },

    // ===== 广西壮族自治区 =====
    { province: '广西壮族自治区', city: '南宁', plate: '桂A' },
    { province: '广西壮族自治区', city: '柳州', plate: '桂B' },
    { province: '广西壮族自治区', city: '桂林', plate: '桂C' },
    { province: '广西壮族自治区', city: '梧州', plate: '桂D' },
    { province: '广西壮族自治区', city: '北海', plate: '桂E' },
    { province: '广西壮族自治区', city: '崇左', plate: '桂F' },
    { province: '广西壮族自治区', city: '来宾', plate: '桂G' },
    { province: '广西壮族自治区', city: '贺州', plate: '桂J' },
    { province: '广西壮族自治区', city: '玉林', plate: '桂K' },
    { province: '广西壮族自治区', city: '百色', plate: '桂L' },
    { province: '广西壮族自治区', city: '河池', plate: '桂M' },
    { province: '广西壮族自治区', city: '钦州', plate: '桂N' },
    { province: '广西壮族自治区', city: '防城港', plate: '桂P' },
    { province: '广西壮族自治区', city: '贵港', plate: '桂R' },

    // ===== 海南省 =====
    { province: '海南省', city: '海口', plate: '琼A' },
    { province: '海南省', city: '三亚', plate: '琼B' },
    { province: '海南省', city: '琼海', plate: '琼C' },
    { province: '海南省', city: '五指山', plate: '琼D' },
    { province: '海南省', city: '洋浦开发区', plate: '琼E' },
    { province: '海南省', city: '儋州', plate: '琼F' },

    // ===== 四川省 =====
    { province: '四川省', city: '成都', plate: '川A' },
    { province: '四川省', city: '绵阳', plate: '川B' },
    { province: '四川省', city: '自贡', plate: '川C' },
    { province: '四川省', city: '攀枝花', plate: '川D' },
    { province: '四川省', city: '泸州', plate: '川E' },
    { province: '四川省', city: '德阳', plate: '川F' },
    { province: '四川省', city: '广元', plate: '川H' },
    { province: '四川省', city: '遂宁', plate: '川J' },
    { province: '四川省', city: '内江', plate: '川K' },
    { province: '四川省', city: '乐山', plate: '川L' },
    { province: '四川省', city: '宜宾', plate: '川Q' },
    { province: '四川省', city: '南充', plate: '川R' },
    { province: '四川省', city: '达州', plate: '川S' },
    { province: '四川省', city: '雅安', plate: '川T' },
    { province: '四川省', city: '阿坝', plate: '川U' },
    { province: '四川省', city: '甘孜', plate: '川V' },
    { province: '四川省', city: '凉山', plate: '川W' },
    { province: '四川省', city: '广安', plate: '川X' },
    { province: '四川省', city: '巴中', plate: '川Y' },
    { province: '四川省', city: '眉山', plate: '川Z' },

    // ===== 贵州省 =====
    { province: '贵州省', city: '贵阳', plate: '贵A' },
    { province: '贵州省', city: '六盘水', plate: '贵B' },
    { province: '贵州省', city: '遵义', plate: '贵C' },
    { province: '贵州省', city: '铜仁', plate: '贵D' },
    { province: '贵州省', city: '黔西南', plate: '贵E' },
    { province: '贵州省', city: '毕节', plate: '贵F' },
    { province: '贵州省', city: '安顺', plate: '贵G' },
    { province: '贵州省', city: '黔东南', plate: '贵H' },
    { province: '贵州省', city: '黔南', plate: '贵J' },

    // ===== 云南省 =====
    { province: '云南省', city: '昆明', plate: '云A' },
    { province: '云南省', city: '昭通', plate: '云C' },
    { province: '云南省', city: '曲靖', plate: '云D' },
    { province: '云南省', city: '楚雄', plate: '云E' },
    { province: '云南省', city: '玉溪', plate: '云F' },
    { province: '云南省', city: '红河', plate: '云G' },
    { province: '云南省', city: '文山', plate: '云H' },
    { province: '云南省', city: '普洱', plate: '云J' },
    { province: '云南省', city: '西双版纳', plate: '云K' },
    { province: '云南省', city: '大理', plate: '云L' },
    { province: '云南省', city: '保山', plate: '云M' },
    { province: '云南省', city: '德宏', plate: '云N' },
    { province: '云南省', city: '丽江', plate: '云P' },
    { province: '云南省', city: '怒江', plate: '云Q' },
    { province: '云南省', city: '迪庆', plate: '云R' },
    { province: '云南省', city: '临沧', plate: '云S' },

    // ===== 西藏自治区 =====
    { province: '西藏自治区', city: '拉萨', plate: '藏A' },
    { province: '西藏自治区', city: '昌都', plate: '藏B' },
    { province: '西藏自治区', city: '山南', plate: '藏C' },
    { province: '西藏自治区', city: '日喀则', plate: '藏D' },
    { province: '西藏自治区', city: '那曲', plate: '藏E' },
    { province: '西藏自治区', city: '阿里', plate: '藏F' },
    { province: '西藏自治区', city: '林芝', plate: '藏G' },

    // ===== 陕西省 =====
    { province: '陕西省', city: '西安', plate: '陕A' },
    { province: '陕西省', city: '铜川', plate: '陕B' },
    { province: '陕西省', city: '宝鸡', plate: '陕C' },
    { province: '陕西省', city: '咸阳', plate: '陕D' },
    { province: '陕西省', city: '渭南', plate: '陕E' },
    { province: '陕西省', city: '汉中', plate: '陕F' },
    { province: '陕西省', city: '安康', plate: '陕G' },
    { province: '陕西省', city: '商洛', plate: '陕H' },
    { province: '陕西省', city: '延安', plate: '陕J' },
    { province: '陕西省', city: '榆林', plate: '陕K' },
    { province: '陕西省', city: '杨凌', plate: '陕V' },

    // ===== 甘肃省 =====
    { province: '甘肃省', city: '兰州', plate: '甘A' },
    { province: '甘肃省', city: '嘉峪关', plate: '甘B' },
    { province: '甘肃省', city: '金昌', plate: '甘C' },
    { province: '甘肃省', city: '白银', plate: '甘D' },
    { province: '甘肃省', city: '天水', plate: '甘E' },
    { province: '甘肃省', city: '酒泉', plate: '甘F' },
    { province: '甘肃省', city: '张掖', plate: '甘G' },
    { province: '甘肃省', city: '武威', plate: '甘H' },
    { province: '甘肃省', city: '定西', plate: '甘J' },
    { province: '甘肃省', city: '陇南', plate: '甘K' },
    { province: '甘肃省', city: '平凉', plate: '甘L' },
    { province: '甘肃省', city: '庆阳', plate: '甘M' },
    { province: '甘肃省', city: '临夏', plate: '甘N' },
    { province: '甘肃省', city: '甘南', plate: '甘P' },

    // ===== 青海省 =====
    { province: '青海省', city: '西宁', plate: '青A' },
    { province: '青海省', city: '海东', plate: '青B' },
    { province: '青海省', city: '海北', plate: '青C' },
    { province: '青海省', city: '黄南', plate: '青D' },
    { province: '青海省', city: '海南', plate: '青E' },
    { province: '青海省', city: '果洛', plate: '青F' },
    { province: '青海省', city: '玉树', plate: '青G' },
    { province: '青海省', city: '海西', plate: '青H' },

    // ===== 宁夏回族自治区 =====
    { province: '宁夏回族自治区', city: '银川', plate: '宁A' },
    { province: '宁夏回族自治区', city: '石嘴山', plate: '宁B' },
    { province: '宁夏回族自治区', city: '吴忠', plate: '宁C' },
    { province: '宁夏回族自治区', city: '固原', plate: '宁D' },
    { province: '宁夏回族自治区', city: '中卫', plate: '宁E' },

    // ===== 新疆维吾尔自治区 =====
    { province: '新疆维吾尔自治区', city: '乌鲁木齐', plate: '新A' },
    { province: '新疆维吾尔自治区', city: '昌吉', plate: '新B' },
    { province: '新疆维吾尔自治区', city: '石河子', plate: '新C' },
    { province: '新疆维吾尔自治区', city: '奎屯', plate: '新D' },
    { province: '新疆维吾尔自治区', city: '博尔塔拉', plate: '新E' },
    { province: '新疆维吾尔自治区', city: '伊犁', plate: '新F' },
    { province: '新疆维吾尔自治区', city: '塔城', plate: '新G' },
    { province: '新疆维吾尔自治区', city: '阿勒泰', plate: '新H' },
    { province: '新疆维吾尔自治区', city: '克拉玛依', plate: '新J' },
    { province: '新疆维吾尔自治区', city: '吐鲁番', plate: '新K' },
    { province: '新疆维吾尔自治区', city: '哈密', plate: '新L' },
    { province: '新疆维吾尔自治区', city: '巴音郭楞', plate: '新M' },
    { province: '新疆维吾尔自治区', city: '阿克苏', plate: '新N' },
    { province: '新疆维吾尔自治区', city: '克孜勒苏', plate: '新P' },
    { province: '新疆维吾尔自治区', city: '喀什', plate: '新Q' },
    { province: '新疆维吾尔自治区', city: '和田', plate: '新R' },
];

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
const CITY_ADMIN_SUFFIX = /(维吾尔|壮族|回族|特别行政区|自治区|自治州|省|市|盟|地区)/g;

export function cityNormalize(str) {
    return toHalfWidth(str == null ? "" : String(str))
        .replace(/[\s·・\-—_/\\,，、.。()（）【】「」]/g, "")
        .toLowerCase()
        .replace(CITY_ADMIN_SUFFIX, "");
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

// 汉字 → 拼音（无声调；ü 记作 v）。只收录 CITY_DATA 中实际出现的字，
// 不引入整张拼音表；某个字缺映射时只影响该字，其余匹配仍然正常。
const PINYIN_MAP = {
    七: "qi", 三: "san", 上: "shang", 丘: "qiu", 东: "dong", 中: "zhong", 临: "lin", 丹: "dan", 丽: "li", 义: "yi",
    乌: "wu", 乐: "le", 九: "jiu", 乡: "xiang", 云: "yun", 五: "wu", 亚: "ya", 京: "jing", 亳: "bo", 什: "shi",
    仁: "ren", 仙: "xian", 伊: "yi", 伦: "lun", 余: "yu", 佛: "fo", 作: "zuo", 佳: "jia", 依: "yi", 保: "bao",
    信: "xin", 儋: "dan", 元: "yuan", 充: "chong", 克: "ke", 六: "liu", 兰: "lan", 关: "guan", 兴: "xing", 内: "nei",
    冈: "gang", 农: "nong", 凉: "liang", 凌: "ling", 则: "ze", 勒: "le", 包: "bao", 化: "hua", 北: "bei", 区: "qu",
    十: "shi", 华: "hua", 南: "nan", 博: "bo", 卫: "wei", 原: "yuan", 厦: "xia", 双: "shuang", 发: "fa", 口: "kou",
    古: "gu", 台: "tai", 合: "he", 吉: "ji", 同: "tong", 名: "ming", 吐: "tu", 吕: "lv", 吴: "wu", 吾: "wu",
    周: "zhou", 呼: "hu", 和: "he", 咸: "xian", 哈: "ha", 唐: "tang", 商: "shang", 喀: "ka", 善: "shan", 嘉: "jia",
    嘴: "zui", 四: "si", 回: "hui", 固: "gu", 圳: "zhen", 坊: "fang", 坝: "ba", 城: "cheng", 埠: "bu", 堰: "yan",
    塔: "ta", 壁: "bi", 壮: "zhuang", 夏: "xia", 多: "duo", 大: "da", 天: "tian", 太: "tai", 头: "tou", 奎: "kui",
    威: "wei", 娄: "lou", 子: "zi", 孜: "zi", 孝: "xiao", 宁: "ning", 安: "an", 宏: "hong", 定: "ding", 宜: "yi",
    宝: "bao", 宣: "xuan", 家: "jia", 宾: "bin", 宿: "su", 密: "mi", 察: "cha", 封: "feng", 尔: "er", 尾: "wei",
    屯: "tun", 山: "shan", 岗: "gang", 岛: "dao", 岩: "yan", 岭: "ling", 岳: "yue", 峡: "xia", 峪: "yu", 峰: "feng",
    崇: "chong", 川: "chuan", 州: "zhou", 左: "zuo", 巴: "ba", 市: "shi", 布: "bu", 常: "chang", 平: "ping", 广: "guang",
    庄: "zhuang", 庆: "qing", 底: "di", 店: "dian", 康: "kang", 廊: "lang", 延: "yan", 建: "jian", 开: "kai", 张: "zhang",
    彦: "yan", 徐: "xu", 德: "de", 徽: "hui", 忠: "zhong", 忻: "xin", 怀: "huai", 怒: "nu", 恩: "en", 惠: "hui",
    感: "gan", 成: "cheng", 扬: "yang", 承: "cheng", 抚: "fu", 护: "hu", 拉: "la", 指: "zhi", 掖: "ye", 揭: "jie",
    攀: "pan", 文: "wen", 斯: "si", 新: "xin", 施: "shi", 族: "zu", 无: "wu", 日: "ri", 昆: "kun", 昌: "chang",
    明: "ming", 春: "chun", 昭: "zhao", 晋: "jin", 普: "pu", 景: "jing", 曲: "qu", 朔: "shuo", 朝: "chao", 木: "mu",
    本: "ben", 来: "lai", 杨: "yang", 杭: "hang", 松: "song", 林: "lin", 果: "guo", 枝: "zhi", 枣: "zao", 架: "jia",
    柳: "liu", 树: "shu", 株: "zhu", 桂: "gui", 桃: "tao", 梁: "liang", 梅: "mei", 梧: "wu", 楚: "chu", 楞: "leng",
    榆: "yu", 武: "wu", 毕: "bi", 水: "shui", 永: "yong", 汉: "han", 汕: "shan", 江: "jiang", 池: "chi", 汾: "fen",
    沂: "yi", 沈: "shen", 沙: "sha", 沧: "cang", 河: "he", 治: "zhi", 泉: "quan", 波: "bo", 泰: "tai", 泸: "lu",
    泽: "ze", 洋: "yang", 洛: "luo", 津: "jin", 洱: "er", 洲: "zhou", 济: "ji", 浙: "zhe", 浦: "pu", 浩: "hao",
    浮: "fu", 海: "hai", 淄: "zi", 淖: "nao", 淮: "huai", 深: "shen", 清: "qing", 温: "wen", 渭: "wei", 港: "gang",
    湖: "hu", 湘: "xiang", 湛: "zhan", 源: "yuan", 溪: "xi", 滁: "chu", 滨: "bin", 漯: "luo", 漳: "zhang", 潍: "wei",
    潜: "qian", 潭: "tan", 潮: "chao", 濮: "pu", 烟: "yan", 焦: "jiao", 照: "zhao", 版: "ban", 牡: "mu", 特: "te",
    犁: "li", 玉: "yu", 玛: "ma", 珠: "zhu", 理: "li", 琼: "qiong", 甘: "gan", 田: "tian", 界: "jie", 番: "fan",
    疆: "jiang", 白: "bai", 百: "bai", 皇: "huang", 益: "yi", 盐: "yan", 盘: "pan", 盟: "meng", 省: "sheng", 眉: "mei",
    石: "shi", 神: "shen", 福: "fu", 秦: "qin", 红: "hong", 纳: "na", 绍: "shao", 绥: "sui", 维: "wei", 绵: "mian",
    聊: "liao", 肃: "su", 肇: "zhao", 肥: "fei", 自: "zi", 舟: "zhou", 色: "se", 节: "jie", 芜: "wu", 芝: "zhi",
    芦: "lu", 花: "hua", 苏: "su", 茂: "mao", 荆: "jing", 莆: "pu", 莞: "guan", 菏: "he", 萍: "ping", 营: "ying",
    萨: "sa", 葫: "hu", 蒙: "meng", 藏: "zang", 蚌: "beng", 衡: "heng", 衢: "qu", 襄: "xiang", 西: "xi", 许: "xu",
    贝: "bei", 贡: "gong", 贵: "gui", 贺: "he", 赣: "gan", 赤: "chi", 边: "bian", 辽: "liao", 达: "da", 迁: "qian",
    运: "yun", 远: "yuan", 连: "lian", 迪: "di", 通: "tong", 遂: "sui", 遵: "zun", 邢: "xing", 那: "na", 邯: "han",
    邵: "shao", 郑: "zheng", 郭: "guo", 郴: "chen", 郸: "dan", 都: "du", 鄂: "e", 酒: "jiu", 里: "li", 重: "chong",
    金: "jin", 钦: "qin", 铁: "tie", 铜: "tong", 银: "yin", 锡: "xi", 锦: "jin", 镇: "zhen", 长: "chang", 门: "men",
    阜: "fu", 防: "fang", 阳: "yang", 阿: "a", 陇: "long", 陕: "shan", 陵: "ling", 随: "sui", 雄: "xiong", 雅: "ya",
    青: "qing", 靖: "jing", 鞍: "an", 音: "yin", 韶: "shao", 顶: "ding", 顺: "shun", 饶: "rao", 马: "ma", 驻: "zhu",
    鲁: "lu", 鸡: "ji", 鸭: "ya", 鹤: "he", 鹰: "ying", 黄: "huang", 黑: "hei", 黔: "qian", 齐: "qi", 龙: "long",
};

// 整词多读音特例：每种读音由若干音节组成，任意一种命中即可
// 六安规范读音为 lù'ān（luan），「liuan」是常见输入，一并接受；
// 其余为常见误读（重/蚌/亳/厦/圳），不额外增加数据量
const PINYIN_EXCEPTION = {
    六安: [["lu", "an"], ["liu", "an"]],
    重庆: [["chong", "qing"], ["zhong", "qing"]],
    蚌埠: [["beng", "bu"], ["bang", "bu"]],
    亳州: [["bo", "zhou"], ["hao", "zhou"]],
    厦门: [["xia", "men"], ["sha", "men"]],
    深圳: [["shen", "zhen"], ["shen", "chuang"]],
};

// 换算拼音变体：full 全拼（shanghai）、short 首字母（sh）、alt* 为 ü→u 的兼容写法
// 返回数组：普通字只有一个变体，含多读音词的字符串会有多个变体（其余部分自动拼接）
function pinyinVariantsOf(text) {
    let variants = [{ full: "", short: "" }];

    for (let i = 0; i < text.length; i++) {
        const two = text.slice(i, i + 2);
        let readings;                                // 二维：每种读音 = 若干音节
        if (PINYIN_EXCEPTION[two]) {
            readings = PINYIN_EXCEPTION[two];
            i += 1;                                  // 特例占两个字
        } else {
            const one = PINYIN_MAP[text[i]];
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
function makePinyinResolver() {
    const cache = new WeakMap();
    return function cityPinyin(item) {
        let entry = cache.get(item);
        if (!entry) {
            entry = {
                province: pinyinVariantsOf(item.province),
                city: pinyinVariantsOf(item.city),
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
        const city = cityNormalize(item.city);
        const plate = cityNormalize(item.plate);

        if (city.startsWith(kw)) return 100 - Math.min(city.length, 20);          // 城市前缀命中
        if (city.includes(kw)) return 85 - Math.min(city.indexOf(kw), 20);        // 城市包含
        if (province.startsWith(kw)) return 70 - Math.min(province.length, 20);   // 省份前缀命中
        if (province.includes(kw)) return 60 - Math.min(province.indexOf(kw), 20); // 省份包含

        // 拼音命中：全拼（shanghai）与首字母（sh）都支持
        const py = cityPinyin(item);
        const cityPy = pinyinHit(py.city, kw);
        if (cityPy === 3) return 88;                                             // 城市拼音完全相等
        if (cityPy === 2) return 80;                                             // 城市拼音前缀
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
            const pos = fuzzyIndex(province + city + plate, kw);
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
 * @param {Array}            [options.items] 数据源，默认 CITY_DATA
 * @param {number}           [options.max]   下拉最多展示条数，默认 5
 * @param {Function}         [options.onPick]  选中回调 (item) => void
 * @param {Function}         [options.onInput] 输入回调 (value) => void
 * @param {Function}         [options.onClear] 清空回调 () => void
 */
export function createCityChooser({
    input,
    list,
    hint = null,
    items = CITY_DATA,
    max = 5,
    onPick,
    onInput,
    onClear,
} = {}) {
    if (!input || !list) {
        throw new Error('createCityChooser 需要 input 与 list 元素');
    }

    const listId = list.id || 'city-list';
    const cityPinyin = makePinyinResolver();
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
        const kw = cityNormalize(keyword);

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
                `${item.province} ${item.city}</li>`)
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
    function pick(item) {
        if (!item) return;
        picked = item;
        input.value = `${item.province} ${item.city}`;
        close();
        setHint(`已选择 ${item.province} ${item.city}`, 1);
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

    // 当前应传给接口的城市名：选中项取 city，手动输入取最后一段
    // （选中后输入框显示「上海市 上海」，取最后一段即「上海」，与手输「上海」一致）
    function getCity() {
        if (picked) return picked.city;
        const raw = input.value.replace(/\s+/g, ' ').trim();
        return raw ? raw.split(' ').pop() : '';
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
