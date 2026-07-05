import { showConfirm, showPrompt } from '/lib/ui/popup.mjs';
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

let time1in,time2in,name=null;

async function fetchUserInfo() {
  try {
    const res = await fetch('/api/profile', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      name= data.email; 
    }
    else{
        name=null;
    }
  } catch {
    name= null;
  }
}

//输入补全
function Complete(value,word){
    value=value.replace(/\s+/g, ' ').trim()
    if(!value) return null;
    const a=value.indexOf(word);
    if(a<0){
        value=value+word;
    }
    return value;
}

//时间格式判断
function timejudge(time){
    if(time>=2400||time<0||time.length!=4||isNaN(time)||time%100>=60||time.length!=4||isNaN(time)||time%100>=60){
        return false;
    }
    return true;
}

//时间格式转换
function timeformat(time){
    time=time.replace(/\s+/g, ' ').trim();
    let timec=time.split(' ');
    time="";
    timec.sort();
    let n=0;
    //let time="99999";
    for(let i=0;i<timec.length;i++){
        let naw=timec[i];
        if(naw==" "||naw==""){
            continue;
        }
        time+=naw.slice(0,2)+':'+naw.slice(2,4)+"\t";
        n+=1;
        if(n==5){
            time+="\n";
            n=0;
        }
        //next=timec[i];
    }

    return time;


}

//执行时间检查
function ex_timejudege(etime){
    let timec = etime.split('.');
    if(timec[0].length!=4){
        timec[0]="20"+timec[0];
    }

    if(timec.length!=3||timec[0]<=0||timec[0].length!=4||timec[1]>12||timec[1]<1||timec[2]>31||timec[2]<1||timec[1].length>2||timec[2].length>2){
        return false;
    }
    for(let i=0;i<timec.length;i++){
        etime=timec[0]+"-"+timec[1]+"-"+timec[2];
    }
    return etime;
}

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

//showmsg - 使用设计系统样式
function showMessage(msg, isError) {
  const box = document.getElementById('errormsg');
  if (box) {
    box.textContent = msg;
    box.style.display = 'block';
    box.style.color = isError ? 'var(--danger)' : 'var(--success)';
  }
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.className = 'notification-popup' + (isError ? ' notification-error' : ' notification-success');
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 2500);
}


//按钮
const backa=document.getElementById("back");
const add=document.getElementById("add-btn");
const search=document.getElementById("search-btn");
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
const time1Div=document.getElementById("time1b");
const time2Div=document.getElementById("time2b");

const city1=document.getElementById("sp");
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


//btn
backa.addEventListener("click", back);
add.addEventListener("click", addForm);
search.addEventListener("click", searchForm);
time1c.addEventListener("click", time1cl);
time2c.addEventListener("click", time2cl);
addconfirm.addEventListener("click", confirmAdd);
clean.addEventListener("click", cleanall);

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
const tests=[citytest,waytest,starttest,endtest,time1test,time2test,bctest,e_timetest];

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
    for(let i=0;i<inputs.length;i++){
        show(inputs[i]);
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
    console.log('search事件触发');
}


function cityinput(){
    console.log("city write")
    const input=city_input.value;
    let city=city_input.value;
    city=Complete(city,"市");
    if(city==null){
        judge.city=0;
        msgout(city_input,citytest,"请输入城市",0,input);
    }
    else{
        judge.city=1;
        msgout(city_input,citytest,'"'+city+'"'+" 符合格式规范",1);
    }
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
    time1in=input;
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
    time2in=input;       // 将 time1in 改为 time2in
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

async function confirmAdd() {
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
    // 清除个人主页缓存，使其下次加载最新时刻表
    sessionStorage.removeItem('account_tt_cache');
    write(2,name);
    cleanall();
    addDiv.classList.add("hidden");
}




function write(choose,name){
    const city=Complete(city_input.value,"市");
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

        const result = await response.json();

        if (!response.ok) {
            // 409：重复 或 400：参数错误 等
            const msg = result.message || result.error || '提交失败';
            showMessage(msg, true);
            return;
        }

        console.log('添加成功，ID:', result.id);
        showMessage('添加成功', false);
        // 可以在这里刷新列表等
    } catch (err) {
        console.error(err);
        showMessage('网络错误', true);
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

// 结果区域元素
const searchResult = document.getElementById("search-result");
const resultCount = document.getElementById("result-count");
const resultList = document.getElementById("result-list");
const resultPageInfo = document.getElementById("result-page-info");
const resultPrevBtn = document.getElementById("result-prev-btn");
const resultNextBtn = document.getElementById("result-next-btn");
const resultCloseBtn = document.getElementById("result-close-btn");

// 搜索结果分页状态
let searchResultsData = [];
let currentPage = 0;
const PAGE_SIZE = 2;

//btn k
searchbtn.addEventListener("click", searchbtnClick);
searchclean.addEventListener("click", searchcleanClick);
resultPrevBtn.addEventListener("click", () => changePage(-1));
resultNextBtn.addEventListener("click", () => changePage(1));
resultCloseBtn.addEventListener("click", closeResults);

function searchcleanClick() {
    console.log("search clean");
    searchKeyword.value = "";
    searchid.value = "";
    sessionStorage.removeItem('timetable_search_state');
    closeResults();
}

function closeResults() {
    searchResult.classList.add("hidden");
    searchResultsData = [];
    currentPage = 0;
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
    const keyword = searchKeyword.value;
    const id = searchid.value.trim();

    if (id) {
        if (id.length === 12) {
            searchById();
        } else {
            showMessage("ID格式错误，需为12位数字", true);
        }
    } else if (keyword) {
        searchByKeyword();
    } else {
        showMessage("请输入搜索关键词或ID", true);
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
    const rawKeyword = searchKeyword.value;
    const { city, way } = parseKeyword(rawKeyword);
    console.log("关键词解析:", { raw: rawKeyword, city, way });

    if (!city && !way) {
        showMessage("请输入有效的搜索关键词", true);
        return;
    }

    // 构建查询参数：同时传入原始关键词 q 实现跨字段模糊匹配
    let params = [];
    if (city) params.push(`city=${encodeURIComponent(city)}`);
    if (way) params.push(`way=${encodeURIComponent(way)}`);
    if (rawKeyword.trim()) params.push(`q=${encodeURIComponent(rawKeyword.trim())}`);
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
    currentPage = 0;
    
    if (data.length === 0) {
        searchResult.classList.add("hidden");
        return;
    }

    searchResult.classList.remove("hidden");
    resultCount.textContent = `共 ${data.length} 条结果`;
    renderPage();
}

function renderPage() {
    const start = currentPage * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, searchResultsData.length);
    const pageData = searchResultsData.slice(start, end);
    const totalPages = Math.ceil(searchResultsData.length / PAGE_SIZE);

    // 更新分页信息
    resultPageInfo.textContent = `${currentPage + 1}/${totalPages}`;
    resultPrevBtn.disabled = currentPage === 0;
    resultNextBtn.disabled = currentPage >= totalPages - 1;

    // 渲染当前页
    resultList.innerHTML = '';
    pageData.forEach((item, idx) => {
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
                    <span class="station-label">起点</span>
                    <span class="station-name">${item.START}</span>
                    <span class="station-arrow">→</span>
                    <span class="station-label">终点</span>
                    <span class="station-name">${item.END}</span>
                </div>
                ${item.SPECIAL && item.SPECIAL !== '无' ? `<div class="result-item-note">${item.SPECIAL}</div>` : ''}
                <div class="result-item-meta">
                    <span>执行: ${(!item.STARTTIME || item.STARTTIME === '1000-1-1') ? '未知执行时间' : item.STARTTIME}</span>
                    <span>作者: ${item.WRITER_NAME || item.WRITER || '未知'}</span>
                </div>
            </div>
        `;

        // 点击整张卡片跳转详情
        card.addEventListener('click', () => showDetail(item));

        resultList.appendChild(card);
    });

    // 滚动到结果区域
    searchResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function changePage(delta) {
    const totalPages = Math.ceil(searchResultsData.length / PAGE_SIZE);
    const newPage = currentPage + delta;
    if (newPage < 0 || newPage >= totalPages) return;
    currentPage = newPage;
    renderPage();
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
        results: searchResultsData,
        page: currentPage
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
        searchForm();

        // 恢复搜索结果
        searchResultsData = state.results;
        currentPage = state.page || 0;
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