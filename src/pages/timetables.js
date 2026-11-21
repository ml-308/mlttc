// src/pages/timetables.js
/**
 * 时刻表查询 / 添加页（timetable.html）—— 站点主要页面
 *
 * 职责：
 *   1. 菜单切换：「查询时刻表」/「添加时刻表」两个面板
 *   2. 查询：城市选择框（/lib/data/city-picker.mjs）+ 关键词 / 12 位 ID 精确查找
 *      → GET /api/timetable-D1，结果按线路号排序后一次性全部渲染
 *   3. 添加：逐字段校验（城市/线路/起点/终点/时刻表/执行时间）→ 确认弹窗
 *      → POST /api/timetable-D1
 *   4. 从详情页返回时，由 sessionStorage 恢复上一次的搜索条件与结果
 *
 * 依赖：/lib/ui/popup.mjs、/lib/data/city-picker.mjs、/lib/ui/message.mjs、
 *       /lib/timetable.mjs
 */
import { showPrompt, showConfirm } from '/lib/ui/popup.mjs';
import { mountCityPicker, attachCityPicker } from '/lib/data/city-picker.mjs';
import { checkCityInput, describeCityInput, normalizeCityInput, formatCityForStorage } from '/lib/ui/city-chooser.mjs';
import { showMessage } from '/lib/ui/message.mjs';
import { createGuard } from '/lib/ui/guard.mjs';
import { createImportPanel } from '/lib/ui/timetable-import.mjs';
import { Complete, timejudge, timeformat, ex_timejudege } from '/lib/timetable.mjs';
import {
    bindAutoSave, loadDraft, saveDraft, clearDraft,
    isUnattended, setUnattended, describeDraftAge, formatClock,
    listSnapshots, saveSnapshot, deleteSnapshot, getSnapshot
} from '/src/pages/timetable-draft.js';
/*
class HcwArticle extends HTMLElement{
    constructor(){
        super();
        this.attactshadow({mode:"open"});
    }

    connectedCallback(){
        this.render();
        this.shadowRoot.addEventListener("click",this._handlerClick);
        this.shadowRoot.addEventListener("input",this._handlerInput);
    }

    _handlerClick=(e)=>{
        const target=e.target.closest("button");
        if(!target){
            return;
        }

        switch(target.id){
            case "add-btn": this.addFrom(); break;
            case "search-btn": this.searchFrom(); break;
            case "back1": this.back1(); break;
            case "cl1": this.cl1(); break;
            case "back2": this.back2(); break;
            case "cl2": this.cl2(); break;
            case "submitAddBtn": this.submitAdd(); break;
            case "resetAddBtn": this.resetAdd(); break;
            default: break;
        }
    }

    _handlerInput=(e)=>{
        const target=e.target.closest("input");
        if(!target){
            return;
        }

        switch(target.id){
            case "city": this.cityChange(); break;
        }
}
}

class HcwBodyHeader extends HTMLElement{
    constructor(){
        super();
        this.attactshadow({mode:"open"});
    }

    connectedCallback(){
        this.render();
        this.shadowRoot.addEventListener("click",this._handlerClick_head);
    } 

    _handlerClick_head=(e)=>{
        const target=e.target.closest("button");
        if(!target){
            return;
        }

        switch(target.id){
            case "back": this.back(); break;
            default: break;
        }
    }
}
*/

let name=null;

//输入补全 / 时间格式判断 / 时间格式转换 / 执行时间检查
// 已抽到 /lib/timetable.mjs（见文件顶部 import）


//提示框 - 使用CSS类替代内联样式
function msgout(input,test,msg,judge){
    console.log("mag:"+msg);
    if(judge==1){
        console.log("msgout--1");
        input.style.borderColor='#1eff01';
        test.style.color='#1eff01';
        test.innerHTML=msg;
        test.style.display="block";
    }
    if(judge==0){
        console.log("msg--0");
        input.style.borderColor='#ff0000';
        test.style.color='#ff0000';
        test.innerHTML=msg;
        test.style.display="block";
    }
    if(judge==2){
        console.log("msg--2");
        input.style.borderColor='#8881';
        test.style.color='var(--text-secondary)';
        test.innerHTML=msg;
        test.style.display="none";
    }
    if(judge==3){
        console.log("msg--3");
        input.style.borderColor='#f3f30e';
        test.style.color='#f3f30e';
        test.innerHTML=msg;
    }
}

//clean - 使用CSS类
function cleaninput(input,inputtest,btn){
    console.log("clean input"+input);
    inputtest.style.display="none";
    input.style.borderColor="#8881";
    input.value="";
    if(btn!=0){
        btn.style.display="none";
    }

}

//show
function show(input){
    input.style.display="flex";
    input.value="";
}

//按钮
const backa=document.getElementById("back");
const add=document.getElementById("add-btn");
const search=document.getElementById("search-btn");
const importBtn=document.getElementById("import-btn");
//const time1b=document.getElementById("back1");
const time1c=document.getElementById("cl1");
//const time2b=document.getElementById("back2");
const time2c=document.getElementById("cl2");
const addconfirm=document.getElementById("submitAddBtn");
const clean=document.getElementById("resetAddBtn");

//输入框
const city_input=document.getElementById("city");
const way_input=document.getElementById("way");
const start_input=document.getElementById("start");
const end_input=document.getElementById("end");
const time1_input=document.getElementById("time1");
const time2_input=document.getElementById("time2");
const bc_input=document.getElementById("bc");
const e_time_input=document.getElementById("exec-time");

//div
const addDiv=document.getElementById("add-form");
const searchDiv=document.getElementById("search-form");
const importDiv=document.getElementById("import-form");
const time1Div=document.getElementById("time1b");
const time2Div=document.getElementById("time2b");

const sc=document.getElementById("sc");

//提示框
const citytest=document.getElementById("citytest");
const waytest=document.getElementById("waytest");
const starttest=document.getElementById("starttest");
const endtest=document.getElementById("endtest");
const time1test=document.getElementById("time1test");
const time2test=document.getElementById("time2test");
const bctest=document.getElementById("bctest");
const e_timetest=document.getElementById("exec-timetest");

//草稿 UI（见 timetable.html 的 .draft-bar / .snap-panel）
const draftSaveBtn=document.getElementById("draft-save-btn");
const draftRestoreBtn=document.getElementById("draft-restore-btn");
const draftStatusEl=document.getElementById("draft-status");
const autoSaveToggle=document.getElementById("draft-autosave");
const snapPanelEl=document.getElementById("snap-panel");
const snapTitleEl=document.getElementById("snap-title");
const snapListEl=document.getElementById("snap-list");

let judge={
    city:0,
    way:0,
    start:0,
    end:0,
    time1:0,
    time2:0,
    bc:1,
    e_time:0,
}


// ─── 草稿：收集 / 状态行 / 恢复 / 自动保存 ─────────
// 存储、过期与敏感字段策略都在 /src/pages/timetable-draft.js 里，本页只管
// 「取哪几个字段、怎么回填、状态行写什么」。新建页没有 ID，草稿键固定为 mlttc-tdraft:create。
const draftPage='create';
let autoSave=null;
/** 恢复过的字段快照：本页 add-form 默认 hidden，点开时 addForm() 里的 show() 会清空输入框，
 *  所以首次打开表单时要把这份内容补回去——否则「恢复了等于没恢复」 */
let restoredSnapshot=null;

/** 页面上哪些字段进草稿（键名即 HTML 里的 name / id，便于排查） */
const DRAFT_INPUTS={
    city:city_input,
    way:way_input,
    start:start_input,
    end:end_input,
    bc:bc_input,
    time1:time1_input,
    time2:time2_input,
    execTime:e_time_input
};

/** 当前表单内容 → 草稿字段 */
function draftFields(){
    const fields={};
    Object.keys(DRAFT_INPUTS).forEach((key)=>{
        fields[key]=DRAFT_INPUTS[key].value;
    });
    return fields;
}

/** 状态行：传空串即清空（.draft-status:empty 会自动隐藏） */
function setDraftStatus(text){
    if(draftStatusEl) draftStatusEl.textContent=text||'';
}

/** 页面既有的整组校验：恢复后必须重跑，否则 judge 与输入框不一致（提交会被判「输入有误」；
 *  时刻表文本尤其要紧——judge.time1 / time2 不对，提交时会被服务端当空值忽略） */
function revalidateAll(){
    cityinput();
    wayinput();
    startinput();
    endinput();
    time1input();
    time2input();
    bcinput();
    e_timeinput();
}

/** 只挑「表单当前为空」的字段：用户已经敲进去的内容绝不能被草稿覆盖 */
function pickRestorable(fields){
    const out={};
    Object.keys(DRAFT_INPUTS).forEach((key)=>{
        const input=DRAFT_INPUTS[key];
        const value=fields?fields[key]:undefined;
        if(typeof value!=='string'||value==='') return;
        if(input.value!=='') return;
        out[key]=value;
    });
    return out;
}

/** 把草稿字段写回表单，再重跑既有校验；同时留下快照供首次打开表单时补填 */
function applyDraftFields(fields){
    Object.keys(fields).forEach((key)=>{
        const input=DRAFT_INPUTS[key];
        if(input) input.value=fields[key];
    });
    revalidateAll();
    restoredSnapshot=fields;
}

/**
 * 恢复草稿（自动恢复：**只填空字段**，绝不覆盖用户已经敲进去的内容）
 *   自动保存开 → 静默恢复，只在状态行留一行字（不打断流程）；
 *   关 → showConfirm 问一次；注意它返回的是**倒序**索引：['恢复草稿','丢弃草稿'] 中
 *        点「恢复草稿」得 1，点「丢弃草稿」/ 点 × / 按 Esc 都得 0。
 */
async function restoreDraft(){
    const draft=loadDraft(draftPage);
    if(!draft) return;

    const fields=pickRestorable(draft.fields);
    if(Object.keys(fields).length===0){
        // 草稿里的字段现在都已经有值，或草稿本身是空的 → 没有可恢复的内容，直接丢弃
        clearDraft(draftPage);
        return;
    }

    const age=describeDraftAge(draft.savedAt);
    const restored=age==='刚刚'?'已恢复刚才填写的草稿':`已恢复 ${age}的草稿`;

    if(isUnattended()){
        applyDraftFields(fields);
        setDraftStatus(restored);
        return;
    }

    const choice=await showConfirm({
        text:`发现未提交的草稿（${age}），要恢复吗？`,
        buttons:['恢复草稿','丢弃草稿'],
        button_style:['variant=success','']
    });
    if(choice===1){
        applyDraftFields(fields);
        setDraftStatus(restored);
        return;
    }
    clearDraft(draftPage);
    setDraftStatus('已丢弃草稿');
}

/** 绑定自动保存：input / change 去抖 800ms，pagehide 与切后台各立即刷一次 */
function bindDraftAutoSave(){
    if(autoSave||!addDiv) return;
    autoSave=bindAutoSave(addDiv,{
        page:draftPage,
        collect:draftFields,
        onSaved(){
            setDraftStatus(`已自动保存 · ${formatClock(Date.now())}`);
        }
    });
}

/** 开关语义：开 = 改动即自动保存；关 = 不自动保存（仍可手动保存快照）。
 *  关掉时要把已有的绑定摘掉，否则它还会继续往单草稿键里写。 */
function applyAutoSaveSwitch(){
    if(isUnattended()){
        bindDraftAutoSave();
        return;
    }
    if(autoSave){
        autoSave.dispose();
        autoSave=null;
    }
}

/** 「清空表单」按钮：连草稿一起删，免得刷新后又把旧内容恢复回来 */
function clearDraftOnReset(){
    clearDraft(draftPage);
    setDraftStatus('');
    restoredSnapshot=null;
}


// ─── 快照：用户手动保存的多份时刻表，按需挑选还原 ─────────────
// 与自动保存的分工：自动保存只维护一份「上次没提交完的现场」（mlttc-tdraft:create），
// 由输入去抖随时覆盖；快照只由「保存快照」按钮产生，可以有 MAX_SNAPSHOTS 份、互不覆盖。

/** 快照标签：优先「城市→线路」，两者都空时退回「快照 N」（N = 现有份数 + 1） */
function snapshotLabel(){
    const city=city_input.value.trim();
    const way=way_input.value.trim();
    if(city&&way) return `${city}→${way}`;
    return city||way||`快照 ${listSnapshots(draftPage).length+1}`;
}

/** 快照行的时间：MM-DD HH:MM（列表里要能一眼看出是哪天存的） */
function snapStamp(ms){
    const pad=(n)=>('0'+n).slice(-2);
    const d=new Date(ms);
    return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function closeSnapshotPanel(){
    if(snapPanelEl) snapPanelEl.classList.add("hidden");
}

/** 行内小按钮：用原生 button，样式见 timetable.html <style> 里的 .snap-btn */
function snapshotRowBtn(text,act,snapId,danger){
    const btn=document.createElement("button");
    btn.type="button";
    btn.className=danger?"snap-btn danger":"snap-btn";
    btn.textContent=text;
    btn.dataset.act=act;
    btn.dataset.snap=snapId;
    return btn;
}

/** 重建快照列表：每行「标签 · 时间 [还原][删除]」。没有快照时给一行提示，面板照样展开 */
function renderSnapshotPanel(){
    if(!snapListEl) return;
    const items=listSnapshots(draftPage);
    if(snapTitleEl) snapTitleEl.textContent=`▼ 已保存的时刻表（${items.length}）`;
    snapListEl.textContent="";
    if(items.length===0){
        const empty=document.createElement("p");
        empty.className="snap-empty";
        empty.textContent="还没有保存过时刻表";
        snapListEl.appendChild(empty);
        return;
    }
    items.forEach((item)=>{
        const row=document.createElement("div");
        row.className="snap-row";
        const meta=document.createElement("span");
        meta.className="snap-meta";
        meta.textContent=`${item.label} · ${snapStamp(item.savedAt)}`;
        row.appendChild(meta);
        row.appendChild(snapshotRowBtn("还原","restore",item.snapId,false));
        row.appendChild(snapshotRowBtn("删除","delete",item.snapId,true));
        snapListEl.appendChild(row);
    });
}

/**
 * 还原指定快照
 * 与自动恢复的关键区别：**这里覆盖表单已有值**。restoreDraft() 只往空字段里填，绝不碰用户
 * 已经敲进去的内容；而「还原」是用户明确点名要这一份存档，所以照单全收，写完再重跑整组校验。
 */
function restoreSnapshot(snapId){
    const snap=getSnapshot(draftPage,undefined,snapId);
    if(!snap) return false;
    Object.keys(DRAFT_INPUTS).forEach((key)=>{
        const value=snap.fields[key];
        if(typeof value==='string') DRAFT_INPUTS[key].value=value;
    });
    revalidateAll();
    // addForm() 里的 show() 会清空输入框，把这份内容登记成「待补回」，切走再切回来不会丢
    restoredSnapshot=snap.fields;
    closeSnapshotPanel();
    setDraftStatus(`已还原 · ${formatClock(Date.now())}`);
    return true;
}


//btn
backa.addEventListener("click", back);
add.addEventListener("click", addForm);
search.addEventListener("click", searchForm);
importBtn.addEventListener("click", importForm);
time1c.addEventListener("click", time1cl);
time2c.addEventListener("click", time2cl);
addconfirm.addEventListener("click", confirmAdd);
clean.addEventListener("click", cleanall);
// 「清空表单」按钮要连草稿一起清。只挂在按钮点击上，不能写进 cleanall()：
// cleanall() 在上传成功后的流程里也会被程序调用，在那里删草稿等于「失败也删」
clean.addEventListener("click", clearDraftOnReset);

// 「保存快照」：把当前表单存成一份存档（自动保存不会往快照列表里加，只能由用户点这里）
if(draftSaveBtn){
    draftSaveBtn.addEventListener("click", ()=>{
        const snapId=saveSnapshot(draftPage, undefined, snapshotLabel(), draftFields());
        if(!snapId){
            showMessage('快照保存失败（浏览器可能禁用了本地存储，或内容超过 8KB）', true);
            return;
        }
        if(autoSave) autoSave.flush();   // 顺带把单草稿刷一次，刷新页面仍能续填
        setDraftStatus(`快照已保存 · ${formatClock(Date.now())}`);
        showMessage('快照已保存', false);
        renderSnapshotPanel();           // 面板开着就顺手刷新
    });
}

// 「还原…」：在表单下方展开 / 收起快照列表（内联面板，不用模态弹窗遮挡表单）
if(draftRestoreBtn&&snapPanelEl){
    draftRestoreBtn.addEventListener("click", ()=>{
        if(snapPanelEl.classList.contains("hidden")){
            renderSnapshotPanel();
            snapPanelEl.classList.remove("hidden");
            return;
        }
        closeSnapshotPanel();
    });
}

// 列表内部走事件委托：面板每重建一次不用重新绑定
if(snapListEl){
    snapListEl.addEventListener("click", (e)=>{
        const btn=e.target.closest("button[data-snap]");
        if(!btn) return;
        const snapId=btn.dataset.snap||"";
        if(btn.dataset.act==="restore"){
            if(!restoreSnapshot(snapId)) showMessage('这份快照已不存在', true);
            return;
        }
        deleteSnapshot(draftPage, undefined, snapId);
        renderSnapshotPanel();
        setDraftStatus(`快照已删除 · ${formatClock(Date.now())}`);
    });
}

// 「自动保存」开关：开 = 改动即自动保存、恢复时静默不弹窗；关 = 不自动保存（仍可手动保存快照）、恢复时询问。
// 开关本身存 localStorage，下次进来仍然有效。
if(autoSaveToggle){
    autoSaveToggle.checked=isUnattended();
    autoSaveToggle.addEventListener("change", ()=>{
        const on=autoSaveToggle.checked;
        setUnattended(on);
        applyAutoSaveSwitch();
        showMessage(on?'已开启自动保存：改动随手保存，恢复时不再询问':'已关闭自动保存（仍可手动保存快照）', false);
    });
}

//批量导入面板（解析 / 校验 / 分页预览 / 分批上传都在 /lib/ui/timetable-import.mjs 里）
createImportPanel({ mount: document.getElementById("import-body") });

//input
city_input.addEventListener("input", cityinput);
way_input.addEventListener("input", wayinput);
start_input.addEventListener("input", startinput);
end_input.addEventListener("input", endinput);
time1_input.addEventListener("input", time1input);
time2_input.addEventListener("input", time2input);
bc_input.addEventListener("input", bcinput);
e_time_input.addEventListener("input", e_timeinput);

const inputs=[city_input,way_input,start_input,end_input,time1_input,time2_input,bc_input,e_time_input];

addconfirm.disabled=false;
clean.disabled=false;
time1c.disabled=false;
time2c.disabled=false;
console.log("SUCCSSS")

//special
sc.addEventListener("click", scf);

async function scf(){
    try {
        const res = await fetch('/api/timetable-D1?list=all', { credentials: 'include' });
        if (!res.ok) {
            showMessage('获取线路列表失败', true);
            return;
        }

        const json = await res.json();
        if (!json.success || !json.data || json.data.length === 0) {
            showMessage('暂无已添加的线路', true);
            return;
        }

        // 格式化输出：一行一个 "城市  xxx    线路  xxx"
        const lines = json.data.map((item, i) =>
            `${String(i + 1).padStart(3)}\u3000城市: ${item.CITY}\u3000\u3000线路: ${item.WAY}`
        );
        const msg = lines.join('\n');

        await showPrompt({
            text: '已添加线路',
            buttons: ['确认', '取消'],
            button_style: ['variant=success', ''],
            input_is_area: true,
            input_attrs: { readonly: true, value: msg }
        });
    } catch (e) {
        console.error('sc 请求异常:', e);
        showMessage('服务器错误', true);
    }
}



function back(){
    window.location.href="/index.html";
    console.log('back事件触发');
}

function addForm(){
    addDiv.classList.remove("hidden");
    searchDiv.classList.add("hidden");
    importDiv.classList.add("hidden");
    for(let i=0;i<inputs.length;i++){
        show(inputs[i]);
    }
    // show() 会把输入框清空。若刚才恢复过草稿，这里把恢复的内容补回去（只补这一次）
    if(restoredSnapshot){
        const snapshot=restoredSnapshot;
        restoredSnapshot=null;
        applyDraftFields(snapshot);
    }
    console.log('add事件触发');
    backa.addEventListener("click", back);
    add.addEventListener("click", addForm);
    search.addEventListener("click", searchForm);
    time1c.addEventListener("click", time1cl);
    time2c.addEventListener("click", time2cl);
    addconfirm.addEventListener("click", confirmAdd);
    clean.addEventListener("click", cleanall);
}

function searchForm(){
    addDiv.classList.add("hidden");
    searchDiv.classList.remove("hidden");
    importDiv.classList.add("hidden");
    console.log('search事件触发');
}

function importForm(){
    addDiv.classList.add("hidden");
    searchDiv.classList.add("hidden");
    importDiv.classList.remove("hidden");
    console.log('import事件触发');
}


function cityinput(){
    console.log("city write")
    const input=city_input.value;
    // 规范判断：必须能在城市库里找到
    // 接受「无锡」「无锡市」「江苏省 无锡」「江苏省 无锡市」这几种写法；
    // 合营线路可以写多个城市（最多 6 个，见 city-chooser 的 MAX_CITY_COUNT），用「/」隔开
    const result=checkCityInput(input);
    judge.city=result.ok?1:0;
    if(result.ok){
        // 直接写入入库写法（带「市」；多个城市则「江苏省 无锡市/江苏省 苏州市」）
        // ⚠️ 以「/」结尾时不会走到这里（reason==='incomplete'），
        //    否则会把用户刚打的分隔符抹掉，第二个城市就没法输入了
        city_input.value=result.value;
    }
    msgout(city_input,citytest,describeCityInput(result),judge.city,input);
    console.log(judge.city);
}

function wayinput(){
    console.log("way write")
    const input=way_input.value;
    let way=way_input.value;
    if(!isNaN(way)){
        way=Complete(way,"路");
    }
    if(way==null){
        judge.way=0;
        msgout(way_input,waytest,"请输入线路",0,input);
    }
    else{
        judge.way=1;
        msgout(way_input,waytest,'"'+way+'"'+" 符合格式规范",1);
    }
}

function startinput(){
    console.log("start write")
    const input=start_input.value;
    let start=start_input.value;
    start=Complete(start,"站");
    if(start==null){
        judge.start=0;
        msgout(start_input,starttest,"请输入起点",0,input);
    }
    else{
        judge.start=1;
        msgout(start_input,starttest,'"'+start+'"'+" 符合格式规范",1);
    }
}
function endinput(){
    console.log("end write")
    const input=end_input.value;
    let end=end_input.value;
    end=Complete(end,"站");
    if(end==null){
        judge.end=0;
        msgout(end_input,endtest,"请输入终点",0,input);
    }
    else{
        judge.end=1;
        msgout(end_input,endtest,'"'+end+'"'+" 符合格式规范",1);
    }
}

function time1input(){
    console.log("time1 write")
    const input=time1_input.value;
    if(input==2500){
        msgout(time1_input,time1test,"unknown",1);
        judge.time1=1;
        return;
    }
    else if(input==2501){
        msgout(time1_input,time1test,"Remove",1);
        judge.time1=1;
        return;
    }
    let time=time1_input.value;
    let err="";
    time=time.replace(/\s+/g, ' ').trim();
    let timec=time.split(' ');
    time1Div.classList.remove('hidden');
    for(let i=0;i<timec.length;i++){
        if(timejudge(timec[i])){
            console.log("time1judge--1");
        }
        else if(timec[i]==" "){
            continue;
        }
        else{
            console.log("time1judge--0");
            err+=timec[i]+" ";
    
        }
    }
    if(err.length>0&&err!=" "){
        judge.time1=0;
        time1c.classList.remove('hidden');
        msgout(time1_input,time1test,"以下时间不符合格式规范："+err,0)
    }
    else if(timec.length==0||time==""||time==" "){
        judge.time1=0;
        msgout(time1_input,time1test,"请输入时刻表",0);
    }
    else{
        judge.time1=1;
        time1c.classList.remove('hidden');
        msgout(time1_input,time1test,"时刻表符合格式规范",1);
    }
}

function time2input(){     // 将函数名 time1input 改为 time2input
    console.log("time2 write");   // 将 "time1 write" 改为 "time2 write"
    const input=time2_input.value; // 将 time1_input 改为 time2_input
    if(input==2500){
        msgout(time2_input,time2test,"unknown",1);
        judge.time2=1;
        return;
    }
    else if(input==2501){
        msgout(time2_input,time2test,"Remove",1);
        judge.time2=1;
        return;
    }
    let time=time2_input.value;  // 将 time1_input 改为 time2_input
    let err="";
    time=time.replace(/\s+/g, ' ').trim();
    let timec=time.split(' ');
    time2Div.classList.remove('hidden');
    for(let i=0;i<timec.length;i++){
        if(timejudge(timec[i])){
            console.log("time2judge--1");
        }
        else if(timec[i]==" "){
            continue;
        }
        else{
            console.log("time2judge--0");
            err+=timec[i]+" ";          
        }
    }
    if(err.length>0&&err!=" "){
        judge.time2=0;
        time2c.classList.remove('hidden');
        msgout(time2_input,time2test,"以下时间不符合格式规范："+err,0);
    }
    else if(timec.length==0||time==""||time==" "){
        judge.time2=0;
        msgout(time2_input,time2test,"请输入时刻表",0);
    }
    else{
        judge.time2=1;
        time2c.classList.remove('hidden');
        msgout(time2_input,time2test,"时刻表符合格式规范",1);
    }

}

function bcinput(){
    console.log("bc write")
    const input=bc_input.value;
    let bc=bc_input.value;
    bc=Complete(bc,")");
    if(bc!=null){
        bc="("+bc;
        msgout(bc_input,bctest,'"'+bc+'"'+" ",1);
    }
    else{
        msgout(bc_input,bctest,"",2);
    }
    judge.bc=1;
}

function e_timeinput(){
    console.log("e_time write")
    const input=e_time_input.value;
    let e_time=e_time_input.value;
    if(e_time==""){
        judge.e_time=0;
        msgout(e_time_input,e_timetest,"请输入执行时间",0);
        return;
    }
    e_time=ex_timejudege(e_time);
    if(e_time!=false){
        judge.e_time=1;
        msgout(e_time_input,e_timetest,e_time+" 是符合格式规范时间",1);
    }
    else{
        judge.e_time=0;
        msgout(e_time_input,e_timetest,input+" 不是符合格式规范时间",0);
    }
}

function time1cl(){
    cleaninput(time1_input,time1test,time1Div);
}

function time2cl(){
    cleaninput(time2_input,time2test,time2Div);
}

function cleanall(){
    console.log("clean all");
    judge={
    city:0,
    way:0,
    start:0,
    end:0,
    time1:0,
    time2:0,
    bc:1,
    e_time:0,
}
    cleaninput(city_input,citytest,0);
    cleaninput(way_input,waytest,0);
    cleaninput(start_input,starttest,0);
    cleaninput(end_input,endtest,0);
    cleaninput(bc_input,bctest,0);
    cleaninput(e_time_input,e_timetest,0);
    time1cl();
    time2cl();
}

const addGuard = createGuard('正在提交，请稍候…');

/**
 * 「添加时刻表」按钮的入口（403/567 等多处绑定与解绑都引用这个名字，
 * 所以防重复提交裹在里面，而不是改绑定处）
 */
function confirmAdd(event) {
    return addGuard.run(doConfirmAdd, event?.currentTarget);
}

async function doConfirmAdd() {
    const name = await fetch('/api/profile', { credentials: 'include' })
    .then(r => r.ok ? r.json() : null)
    .then(data => data?.user?.email || data?.email || '')
    .catch(() => '');
    if(!name){
        showMessage("请先登录", true);
        return;
    }
    cityinput();
    wayinput();
    startinput();
    endinput();
    time1input();
    time2input();
    bcinput();
    e_timeinput();
    console.log("confirm add");
    const values=Object.values(judge);
    for(let i=0;i<values.length;i++){
        console.log(i+"--"+values[i]);
    }
    for(let i=0;i<values.length;i++){
        if(values[i]==0){
            console.log("judgeall--0"+values[i]);
            addconfirm.innerHTML="输入有误请修改";
            addconfirm.setAttribute('variant', 'danger');
            return;
        }
    }
    console.log("judgeall--1");
    addconfirm.removeAttribute('variant');
    addconfirm.innerHTML="添加上传";
    addconfirm.removeEventListener("click",confirmAdd);
    time1c.removeEventListener("click", time1cl);
    time2c.removeEventListener("click", time2cl);
    clean.removeEventListener("click", cleanall);
    let msg=write(1,name);
    console.log(msg);
    console.log("msgout--1");
    /*
    const result=await showConfirm({
        text:"确认添加",
        buttons:["确认","取消"],
        button_style:['variant=success',""]
    });
*/
    const inputvalue=await showPrompt({
        text:"确认上传",
        buttons:["确认","取消"],
        button_style:['variant=success',""],
        input_is_area:true,
        input_attrs:{readonly:true,value:msg}
    });
    console.log(inputvalue);
    console.log(msg);
    if(inputvalue!=msg){
        addconfirm.addEventListener("click",confirmAdd);
        time1c.addEventListener("click", time1cl);
        time2c.addEventListener("click", time2cl);
        clean.addEventListener("click", cleanall);
        console.log("cancel or change");
        showMessage("取消或修改", true);
        return;
    }
    console.log("pass");
    showMessage("添加成功", false);
    showAddResult(true, '时刻表已成功添加至数据库');
    // 清除「我的时刻表」页缓存，使其下次加载最新时刻表
    sessionStorage.removeItem('my_timetable_cache');
    write(2,name);
    cleanall();
    addDiv.classList.add("hidden");
}




function write(choose,name){
    // 入库统一成城市库里的写法（校验已保证能命中；真命中不了就退回原输入，不至于传出空值）
    const city=Complete(normalizeCityInput(city_input.value)??city_input.value,"市");
    let way=way_input.value;
    if(!isNaN(way)){
        way=Complete(way,"路");
    }
    const start=Complete(start_input.value,"站");
    const end=Complete(end_input.value,"站");
    let time1, time2;
    if(time1_input.value==2500){
        time1="unknown";
    }
    else if(time1_input.value==2501){
        time1="Remove"
    }
    else{
        time1=timeformat(time1_input.value);
    }
    if(time2_input.value==2500){
        time2="unknown";
    }
    else if(time2_input.value==2501){
        time2="Remove"
    }
    else{
        time2=timeformat(time2_input.value);
    }
    const bc=bc_input.value;
    const e_time=ex_timejudege(e_time_input.value);
    const now = new Date();
    const year = now.getFullYear();
    const month = ('0' + (now.getMonth() + 1)).slice(-2);
    const day = ('0' + now.getDate()).slice(-2);
    const writetime = year +"-"+ month +"-"+ day ;
    console.log(writetime);
    let msg="";
    if(choose==1){
        msg="城市："+city+"\n线路："+way+"\n起点："+start+"\n终点："+end+"\n主站->副站时刻表："+time1+"\n副站->主站时刻表："+time2+"\n执行时间："+e_time+"\n"+"写入时间："+writetime+"\n作者:"+name;
        return msg;
    }
    if(choose==2){
        console.log("data:",city);
        writeD1(city,way,start,end,time1,time2,bc,e_time,writetime,name);
    }
}

async function writeD1(city, way, start, end, time1, time2, bc, etime, writetime, name) {
    // 先把原始输入拷一份：调用方紧接着会 cleanall() 清空表单，若去抖窗口里还剩一次未落盘的
    // 保存，草稿会被写成空的。失败时用这份快照把草稿还原成用户刚填的样子。
    const rawSnapshot = draftFields();
    // 构造数据，不再包含 id，由后端生成
    const data = {
        "city": city,
        "way": way,
        "start": start,
        "end": end,
        "time1": time1,
        "time2": time2,
        "special": bc,
        "etime": etime,
        "writetime": writetime,
        "writer": name
    };

    console.log('提交数据:', data);

    try {
        const response = await fetch('/api/timetable-D1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        const result = await response.json().catch(() => null);

        // 只有「HTTP 成功 且 业务 success」才算上传成功；拿不到 body 也按失败处理，
        // 宁可留着草稿，也不要在结果不明时把它删掉
        if (!response.ok || !result || result.success === false) {
            // 409：重复 或 400：参数错误 等
            const msg = (result && (result.message || result.error)) || '提交失败';
            showMessage(msg, true);
            // 失败路径：草稿一个字都不动（并把原始输入写回，防止被上面那次空落盘盖掉），
            // 删除动作一律在这个 return 之后才可能发生
            saveDraft(draftPage, undefined, rawSnapshot);
            return;
        }

        console.log('添加成功，ID:', result.id);
        showMessage('添加成功', false);
        // 上传成功：草稿已经完成使命。先解绑再删 —— 顺序不能反，
        // 否则随后触发的 pagehide / 切后台会把刚删掉的草稿又写回去。
        if (autoSave) {
            autoSave.dispose();
            autoSave = null;
        }
        clearDraft(draftPage);
        setDraftStatus('');
        restoredSnapshot = null;
        // 可以在这里刷新列表等
    } catch (err) {
        console.error(err);
        showMessage('网络错误', true);
        // 网络异常同样不是成功：草稿保留，并把原始输入写回
        saveDraft(draftPage, undefined, rawSnapshot);
    }
}

// ─── 搜索防抖与流量控制 ─────────────────────────────────────
let searchAbortController = null; // 用于取消上一次未完成的请求
let isSearching = false;          // 防止并发搜索

// ─── 搜索 ─────────────────────────────────────────────
//btn
const searchbtn = document.getElementById("submitSearchBtn");
const searchclean = document.getElementById("clearSearchBtn");

//input
const searchKeyword = document.getElementById("search-keyword");
const searchid = document.getElementById("search-id");

// 城市选择框：DOM（输入框 / 箭头 / 下拉 / 提示行）由 mountCityPicker 生成，
// 数据取自 lib/data/cities.json（带缓存）。样式见 style/main.css 的「城市选择器」区块。
// 说明：提示行现在有独立 id，不会再和新增表单的 #citytest 撞车（原来撞了，
//       导致查询框的提示被写进隐藏的新增表单里，用户根本看不到）。
const cityChooser = await mountCityPicker('#city-picker');
const cityInput = cityChooser.input;

// 新增表单的城市框：在页面已有的 <input id="city"> 外面套上同样的下拉
// （输入框连 id / name 一起保留，所以本文件原有取值、校验代码都不用改）
//   hint: false   —— 该框的提示由既有的 citytest 校验逻辑负责，别让两者互相覆盖
//   formatPicked  —— 选中就直接写库里的入库写法「江苏省 无锡市」（带市）
const cityWritePicker = await attachCityPicker('#city', {
    hint: false,
    formatPicked: (item) => formatCityForStorage(item),
    onPick() { cityinput(); }   // 选中后立刻跑一次既有校验，让提示同步
});

// 结果区域元素
const searchResult = document.getElementById("search-result");
const resultCount = document.getElementById("result-count");
const resultList = document.getElementById("result-list");

// 搜索结果数据
let searchResultsData = [];

//btn k
searchbtn.addEventListener("click", searchbtnClick);
searchclean.addEventListener("click", searchcleanClick);

// 回车直接搜索
// 城市下拉展开且已高亮选项时，Enter 会被选择器消费（defaultPrevented），不会误触发搜索
[cityInput, searchKeyword, searchid].forEach((el) => {
    el.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" || e.isComposing || e.defaultPrevented) return;
        e.preventDefault();
        searchbtnClick();
    });
});

function searchcleanClick() {
    console.log("search clean");
    searchKeyword.value = "";
    searchid.value = "";
    cityChooser.clear();
    sessionStorage.removeItem('timetable_search_state');
    closeResults();
}

function closeResults() {
    searchResult.classList.add("hidden");
    searchResultsData = [];
    sessionStorage.removeItem('timetable_search_state');
}

function setSearchLoading(loading) {
    isSearching = loading;
    searchbtn.disabled = loading;
    searchbtn.textContent = loading ? '查询中...' : '查询时刻表';
}

function parseKeyword(keyword) {
    // 从关键词中智能提取城市和线路
    let city = '';
    let way = '';
    const trimmed = keyword.replace(/\s+/g, ' ').trim();
    
    if (!trimmed) return { city: '', way: '' };

    // 城市指示后缀
    const citySuffixes = ['市', '省', '区', '县'];
    const hasCitySuffix = (s) => citySuffixes.some(suf => s.includes(suf));

    const parts = trimmed.split(' ');

    if (parts.length >= 2) {
        // 多段输入：第一段优先作为城市，其余作为线路
        city = Complete(parts[0], '市');
        way = Complete(parts.slice(1).join(' '), '路');
    } else {
        // 单段输入
        const word = parts[0];
        if (hasCitySuffix(word)) {
            // 明确含城市后缀 → 城市
            city = Complete(word, '市');
        } else if (/路$/.test(word) || /^\d{1,3}$/.test(word) || /^[A-Za-z]/.test(word) || /\d/.test(word) || /线/.test(word) || /区间/.test(word) || /微巴/.test(word)) {
            // 以"路"结尾 / 纯数字(1-3位) / 字母开头 / 含数字 / 含"线"/"专线"/"支线" / 含"区间" / 含"微巴" → 视为线路
            if(!isNaN(word)){
                way = Complete(word, '路');
            }
            else{
                way=word;
            }
        } else {
            // 默认作为城市名（即使不带"市"也能匹配）
            city = Complete(word, '市');
        }
    }

    return { city, way };
}

function searchbtnClick() {
    if (isSearching) {
        console.log("已有搜索进行中，忽略本次点击");
        showMessage("已有搜索进行中，请稍候", true);
        return;
    }

    if (searchAbortController) {
        searchAbortController.abort();
    }
    searchAbortController = new AbortController();

    // 新搜索清除之前保存的状态
    sessionStorage.removeItem('timetable_search_state');

    console.log("search btn");
    const keyword = searchKeyword.value.trim();
    const id = searchid.value.trim();
    const city = cityChooser.getCity();

    if (id) {
        if (id.length === 12) {
            searchById();
        } else {
            showMessage("ID格式错误，需为12位数字", true);
        }
    } else if (city || keyword) {
        // 只选城市不填关键词 → 列出该城市下的全部线路
        searchByKeyword();
    } else {
        showMessage("请选择城市或输入搜索关键词", true);
    }
}

async function searchById() {
    console.log("search by id");
    const id = searchid.value.trim();

    setSearchLoading(true);
    try {
        const res = await fetch(`/api/timetable-D1?id=${encodeURIComponent(id)}`, {
            signal: searchAbortController.signal
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({ message: '请求失败' }));
            showMessage(errData.message || errData.error || '请求失败', true);
            return;
        }

        const data = await res.json();
        if (!data.success || !data.data) {
            showMessage(data.message || '找不到数据', true);
            return;
        }

        const item = data.data;
        showMessage("搜索成功", false);
        // ID查询结果作为单条结果展示
        renderResults([item]);

    } catch (e) {
        if (e.name === 'AbortError') {
            console.log("搜索请求已被取消");
            return;
        }
        console.error("请求异常:", e);
        showMessage("服务器错误", true);
    } finally {
        setSearchLoading(false);
        searchAbortController = null;
    }
}

async function searchByKeyword() {
    const rawKeyword = searchKeyword.value.trim();
    const chosenCity = cityChooser.getCity();   // 城市选择框中的城市（选中项 / 手输文本）

    let city = '';
    let way = '';

    if (chosenCity) {
        // 城市已由专属选择框确定，不再从关键词里猜城市
        city = chosenCity;
        // 关键词仍按线路解析（纯数字会补「路」）；解析不出线路时靠 q 跳字段兜底
        if (rawKeyword) way = parseKeyword(rawKeyword).way || '';
    } else {
        // 未填城市 → 沿用原有的「从关键词里猜城市 / 线路」逻辑
        ({ city, way } = parseKeyword(rawKeyword));
    }

    console.log("搜索条件:", { raw: rawKeyword, city, way });

    if (!city && !way) {
        showMessage("请输入有效的搜索关键词", true);
        return;
    }

    // 构建查询参数：同时传入原始关键词 q 实现跨字段模糊匹配
    let params = [];
    if (city) params.push(`city=${encodeURIComponent(city)}`);
    if (way) params.push(`way=${encodeURIComponent(way)}`);
    if (rawKeyword) params.push(`q=${encodeURIComponent(rawKeyword)}`);
    const queryString = params.join('&');

    setSearchLoading(true);
    try {
        const res = await fetch(`/api/timetable-D1?${queryString}`, {
            signal: searchAbortController.signal
        });

        if (!res.ok) {
            if (res.status === 404) {
                showMessage("未找到符合条件的时刻表", true);
                return;
            }
            const errData = await res.json().catch(() => ({ message: '请求失败' }));
            showMessage(errData.message || errData.error || '请求失败', true);
            return;
        }

        const json = await res.json();
        if (!json.success || !json.data || json.data.length === 0) {
            showMessage(json.message || '找不到数据', true);
            return;
        }

        showMessage(`找到 ${json.data.length} 条结果`, false);
        renderResults(json.data);

    } catch (e) {
        if (e.name === 'AbortError') {
            console.log("搜索请求已被取消");
            return;
        }
        console.error("请求异常:", e);
        showMessage("服务器错误", true);
    } finally {
        setSearchLoading(false);
        searchAbortController = null;
    }
}

// ─── 结果渲染与分页 ─────────────────────────────────
function renderResults(data) {
    // 对结果按线路号排序：数字开头按数值升序，非数字开头按首字拼音/字母排在最后
    data.sort((a, b) => {
        const wayA = a.WAY || '';
        const wayB = b.WAY || '';
        const numA = parseInt(wayA.match(/^(\d+)/)?.[1], 10);
        const numB = parseInt(wayB.match(/^(\d+)/)?.[1], 10);
        const isNumA = !isNaN(numA);
        const isNumB = !isNaN(numB);

        if (isNumA && isNumB) {
            return numA - numB;
        }
        if (isNumA && !isNumB) {
            return -1;
        }
        if (!isNumA && isNumB) {
            return 1;
        }
        // 都非数字开头，按首字 localeCompare 排序
        return wayA.localeCompare(wayB, 'zh-CN');
    });

    searchResultsData = data;

    if (data.length === 0) {
        searchResult.classList.add("hidden");
        return;
    }

    searchResult.classList.remove("hidden");
    resultCount.textContent = `共 ${data.length} 条结果`;
    renderPage();
}

function renderPage() {
    // 一次性渲染全部结果
    resultList.innerHTML = '';
    searchResultsData.forEach((item, idx) => {
        const card = document.createElement('div');
        card.className = 'result-item';
        card.style.animationDelay = `${idx * 0.05}s`;
        
        // 格式化时间显示
        const time1Display = formatTimeDisplay(item.TIMEONE);
        const time2Display = formatTimeDisplay(item.TIMETWO);

        card.innerHTML = `
            <div class="result-item-header">
                <span class="result-item-id">#${item.ID}</span>
                <span class="result-item-route">${item.CITY} · ${item.WAY}</span>
            </div>
            <div class="result-item-body">
                <div class="result-item-stations">
                    <span class="station-name">${item.START}</span>
                    <span class="station-arrow">↔</span>
                    <span class="station-name">${item.END}</span>
                </div>
                ${item.SPECIAL && item.SPECIAL !== '无' ? `<div class="result-item-note">${item.SPECIAL}</div>` : ''}
            </div>
        `;

        // 点击整张卡片跳转详情
        card.addEventListener('click', () => showDetail(item));

        resultList.appendChild(card);
    });

    // 滚动到结果区域
    searchResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function formatTimeDisplay(timeStr) {
    if (!timeStr || timeStr === 'unknown') return '未知';
    // 时间格式通常是 "06:00 06:30 07:00" 带制表符
    const parts = timeStr.split(/[\t\n\r]+/).filter(t => t.trim());
    if (parts.length <= 6) {
        return parts.join(' ');
    }
    return parts.slice(0, 6).join(' ') + ` ... (+${parts.length - 6}个)`;
}

async function showDetail(item) {
    // 跳转前保存搜索状态到 sessionStorage
    sessionStorage.setItem('timetable_search_state', JSON.stringify({
        keyword: searchKeyword.value,
        city: cityChooser.getPicked(),
        results: searchResultsData
    }));
    // 跳转到新的详情页面
    const id = item.ID;
    window.location.href = `/timetable-detail.html?id=${encodeURIComponent(id)}`;
}

// ─── 添加结果展示 ─────────────────────────────────
function showAddResult(success, message) {
    const resultDiv = document.getElementById('add-result');
    if (!resultDiv) return;
    
    resultDiv.classList.remove('hidden', 'success', 'error');
    resultDiv.classList.add(success ? 'success' : 'error');
    resultDiv.textContent = message;
    
    // 3秒后自动隐藏
    setTimeout(() => {
        resultDiv.classList.add('hidden');
    }, 5000);
}

// ─── 从详情页返回时恢复搜索状态 ─────────────────────
function restoreSearchState() {
    const saved = sessionStorage.getItem('timetable_search_state');
    if (!saved) return;

    try {
        const state = JSON.parse(saved);
        if (!state.results || state.results.length === 0) {
            sessionStorage.removeItem('timetable_search_state');
            return;
        }

        // 清除已保存的状态，避免重复恢复
        sessionStorage.removeItem('timetable_search_state');

        // 填充关键词并切换到搜索面板
        if (state.keyword) {
            searchKeyword.value = state.keyword;
        }
        cityChooser.setPicked(state.city || null);
        searchForm();

        // 恢复搜索结果
        searchResultsData = state.results;
        searchResult.classList.remove("hidden");
        resultCount.textContent = `共 ${searchResultsData.length} 条结果`;
        renderPage();

        showMessage(`已恢复搜索结果，共 ${searchResultsData.length} 条`, false);
    } catch (e) {
        console.error('恢复搜索状态失败:', e);
        sessionStorage.removeItem('timetable_search_state');
    }
}

// 页面加载时自动恢复
restoreSearchState();

// ─── 草稿：按开关绑定自动保存 + 尝试恢复 ─────────────
// 放在初始化末尾：此时 add-form 已在 DOM 里、城市选择器也挂好了，用户一动手就有人接盘。
// 绑在容器上而不是逐字段绑，所以恢复写 input.value（不触发 input 事件）不会被当成用户改动。
// 开关为「关」时不绑定，页面就不会自动往单草稿键里写；快照与恢复提示仍然可用。
applyAutoSaveSwitch();
setTimeout(() => {
    restoreDraft().catch((e) => console.warn('[timetables] 恢复草稿失败，已忽略', e));
}, 150);

/*
// ─── 删除功能 ─────────────────────────────────────
const deleteBtn = document.getElementById('submitDeleteBtn');
const deleteIdInput = document.getElementById('delete-id');
const deleteResultDiv = document.getElementById('delete-result');
let deleteConfirmPending = false;

if (deleteBtn) {
    deleteBtn.addEventListener('click', handleDelete);
}

async function handleDelete() {
    const id = deleteIdInput.value.trim();
    
    if (!id) {
        showDeleteResult(false, '请输入时刻表ID');
        return;
    }
    
    if (id.length !== 12) {
        showDeleteResult(false, 'ID格式错误，需为12位字符');
        return;
    }
    
    // 二次确认
    if (!deleteConfirmPending) {
        deleteConfirmPending = true;
        deleteBtn.innerHTML = '确认删除？';
        deleteBtn.setAttribute('variant', 'danger');
        deleteBtn.setAttribute('confirming', '');
        setTimeout(() => {
            deleteConfirmPending = false;
            deleteBtn.innerHTML = '永久删除';
            deleteBtn.removeAttribute('confirming');
        }, 3000);
        return;
    }
    
    // 执行删除
    deleteConfirmPending = false;
    deleteBtn.innerHTML = '删除中...';
    deleteBtn.disabled = true;
    
    try {
        const res = await fetch('/api/timetable-D1', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        
        const data = await res.json().catch(() => ({}));
        
        if (res.ok) {
            showDeleteResult(true, `时刻表 ${id} 已成功删除`);
            deleteIdInput.value = '';
            showMessage('删除成功', false);
        } else {
            showDeleteResult(false, data.message || data.error || '删除失败');
            showMessage(data.message || '删除失败', true);
        }
    } catch (e) {
        console.error(e);
        showDeleteResult(false, '网络错误，请稍后重试');
        showMessage('网络错误', true);
    } finally {
        deleteBtn.innerHTML = '永久删除';
        deleteBtn.disabled = false;
        deleteBtn.removeAttribute('confirming');
    }
}

function showDeleteResult(success, message) {
    if (!deleteResultDiv) return;
    
    deleteResultDiv.classList.remove('hidden', 'success', 'error');
    deleteResultDiv.classList.add(success ? 'success' : 'error');
    deleteResultDiv.innerHTML = `<p><strong>${success ? '✓' : '✗'} ${message}</strong></p>`;
    
    setTimeout(() => {
        deleteResultDiv.classList.add('hidden');
    }, 6000);
}
    */