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

//提示框
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
        test.style.color='#000000';
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

//clean
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

//showmsg
function showMessage(msg, isError) {
  const box = document.getElementById('errormsg');
  if (box) {
    box.textContent = msg;
    box.style.display = 'block';
    box.style.color = isError ? 'red' : 'green';
  }
  const popup = document.createElement('div');
  popup.textContent = msg;
  popup.style = 'position:fixed; top:20px; left:50%; padding:10px 20px; border-radius:5px; z-index:9999; color:#fff; font-size:0.85rem; animation: fadeInOut 2s ease forwards;';
  popup.style.backgroundColor = isError ? '#f44336' : '#4CAF50';
  document.body.appendChild(popup);
  setTimeout(() => popup.remove(), 2000);
  
  // 注入动画关键帧（仅一次）
  if (!document.getElementById('showMsgAnimStyles')) {
    const styleSheet = document.createElement('style');
    styleSheet.id = 'showMsgAnimStyles';
    styleSheet.textContent = `
      @keyframes fadeInOut {
        0%   { opacity: 0; transform: translateX(-50%) translateY(-20px); }
        15%  { opacity: 1; transform: translateX(-50%) translateY(0); }
        85%  { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
      }
    `;
    document.head.appendChild(styleSheet);
  }
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
city1.addEventListener("click", com);

function com(){
    city_input.value="无锡市";
    showMessage("线路已自动补全为 无锡市", false);
    cityinput();
    return;
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
    else if(city!="无锡市"){
        judge.city=0;
        msgout(city_input,citytest,"当前仅支持写入无锡地区数据   点击填充",3,input);
    }
    else{
        judge.city=1;
        msgout(city_input,citytest,'"'+city+'"'+" 是合法城市",1);
    }
    console.log(judge.city);
}

function wayinput(){
    console.log("way write")
    const input=way_input.value;
    let way=way_input.value;
    way=Complete(way,"");
    if(way==null){
        judge.way=0;
        msgout(way_input,waytest,"请输入线路",0,input);
    }
    else{
        judge.way=1;
        msgout(way_input,waytest,'"'+way+'"'+" 是合法线路",1);
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
        msgout(start_input,starttest,'"'+start+'"'+" 是合法起点",1);
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
        msgout(end_input,endtest,'"'+end+'"'+" 是合法终点",1);
    }
}

function time1input(){
    console.log("time1 write")
    const input=time1_input.value;
    time1in=input;
    let time=time1_input.value;
    let err="";
    time=time.replace(/\s+/g, ' ').trim();
    let timec=time.split(' ');
    time1Div.style.display="flex";
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
        time1c.style.display="flex";
        msgout(time1_input,time1test,"以下时间不合法："+err,0)
    }
    else if(timec.length==0||time==""||time==" "){
        judge.time1=0;
        msgout(time1_input,time1test,"请输入时刻表",0);
    }
    else{
        judge.time1=1;
        time1c.style.display="flex";
        //time1b.style.display="flex";
        msgout(time1_input,time1test,"时刻表合法",1);
    }
}

function time2input(){     // 将函数名 time1input 改为 time2input
    console.log("time2 write");   // 将 "time1 write" 改为 "time2 write"
    const input=time2_input.value; // 将 time1_input 改为 time2_input
    time2in=input;       // 将 time1in 改为 time2in
    let time=time2_input.value;  // 将 time1_input 改为 time2_input
    let err="";
    time=time.replace(/\s+/g, ' ').trim();
    let timec=time.split(' ');
    time2Div.style.display="flex";
    for(let i=0;i<timec.length;i++){
        if(timejudge(timec[i])){
            console.log("time2judge--1"); // 将 "time1judge--1" 改为 "time2judge--1"
        }
        else if(timec[i]==" "){
            continue;
        }
        else{
            console.log("time2judge--0"); // 将 "time1judge--0" 改为 "time2judge--0"
            err+=timec[i]+" ";          
        }
    }
    if(err.length>0&&err!=" "){
        judge.time2=0;
        time2c.style.display="flex";
        msgout(time2_input,time2test,"以下时间不合法："+err,0); // 将 time1_input 和 time1test 改为 time2_input 和 time2test
    }
    else if(timec.length==0||time==""||time==" "){
        judge.time2=0;
        msgout(time2_input,time2test,"请输入时刻表",0); // 将 time1_input 和 time1test 改为 time2_input 和 time2test
    }
    else{
        judge.time2=1;
        time2c.style.display="flex";
        //time2b.style.display="flex";
        msgout(time2_input,time2test,"时刻表合法",1); // 将 time1_input 和 time1test 改为 time2_input 和 time2test
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
        msgout(e_time_input,e_timetest,e_time+" 是合法时间",1);
    }
    else{
        judge.e_time=0;
        msgout(e_time_input,e_timetest,input+" 不是合法时间",0);
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
            addconfirm.style.backgroundColor="#ff0000";
            return;
        }
    }
    console.log("judgeall--1");
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
    write(2,name);
    cleanall();
    addDiv.classList.add("hidden");
}




function write(choose,name){
    const city=Complete(city_input.value,"市");
    const way=Complete(way_input.value,"路");
    const start=Complete(start_input.value,"站");
    const end=Complete(end_input.value,"站");
    const time1=timeformat(time1_input.value);
    const time2=timeformat(time2_input.value);
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

//search
//btn
const searchbtn=document.getElementById("submitSearchBtn");
const searchclean=document.getElementById("clearSearchBtn");

//input
const searchcity=document.getElementById("search-city");
const searchway=document.getElementById("search-way");
const searchid=document.getElementById("search-id");

/*
const searchDiv=document.getElementById("search-form");
const searchDiv2=document.getElementById("search-form2");
*/
/*
searchcity.addEventListener("input", searchcityinput);
searchway.addEventListener("input", searchwayinput);
searchid.addEventListener("input", searchidinput);
*/
//btn k
searchbtn.addEventListener("click", searchbtnClick);
searchclean.addEventListener("click", searchcleanClick);

function searchcleanClick(){
    console.log("search clean");
    searchcity.value="";
    searchway.value="";
    searchid.value="";
}

function searchbtnClick(){
    console.log("search btn");
    const city=searchcity.value;
    const way=searchway.value;
    const id=searchid.value;
    if(id){
        searchById();
    }
    else if(city&&way){
        searchByCityWay();
    }
    else{
        showMessage("请输入搜索条件", true);
    }
}

async function searchById() {
    console.log("search by id");
    const id = searchid.value.trim();
    if (id.length !== 12) {
        showMessage("ID错误", true);
        return;
    }

    try {
        const res = await fetch(`/api/timetable-D1?id=${encodeURIComponent(id)}`);

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

        const msg = `城市：${item.CITY}\n` +
                    `线路：${item.WAY}\n` +
                    `起点：${item.START}\n` +
                    `终点：${item.END}\n` +
                    `备注：${item.SPECIAL || '无'}\n` +
                    `主站→副站：${item.TIMEONE}\n` +
                    `副站→主站：${item.TIMETWO}\n` +
                    `执行时间：${item.STARTTIME}\n` +
                    `写入时间：${item.WRITETIME}\n` +
                    `作者：${item.WRITER}`;

        console.log("查询成功:", msg);
        showMessage("搜索成功", false);

        await showPrompt({
            text: "查询数据",
            buttons: ["关闭"],
            button_style: ['variant=success'],
            input_is_area: true,
            input_attrs: { readonly: true, value: msg }
        });

    } catch (e) {
        console.error("请求异常:", e);
        showMessage("服务器错误", true);
    }
}


async function searchByCityWay() {
    console.log("search by city way");
    const city = Complete(searchcity.value, "市");
    const way = Complete(searchway.value, "路");
    console.log("city:", city, "way:", way);

    try {
        const res = await fetch(`/api/timetable-D1?city=${encodeURIComponent(city)}&way=${encodeURIComponent(way)}`);
        if (!res.ok) {
            const errData = await res.json().catch(() => ({ message: '请求失败' }));
            showMessage(errData.message || errData.error || '请求失败', true);
            return;
        }

        const json = await res.json();
        if (!json.success || !json.data || json.data.length === 0) {
            showMessage(json.message || '找不到数据', true);
            return;
        }

        const item = json.data[0];   

        const msg = `城市：${item.CITY}\n` +
                    `线路：${item.WAY}\n` +
                    `起点：${item.START}\n` +
                    `终点：${item.END}\n` +
                    `备注：${item.SPECIAL || '无'}\n` +
                    `主站→副站：${item.TIMEONE}\n` +
                    `副站→主站：${item.TIMETWO}\n` +
                    `执行时间：${item.STARTTIME}\n` +
                    `写入时间：${item.WRITETIME}\n` +
                    `作者：${item.WRITER}`;

        console.log("查询成功:", msg);
        showMessage("搜索成功", false);

        await showPrompt({
            text: "查询数据",
            buttons: ["关闭"],
            button_style: ['variant=success'],
            input_is_area: true,
            input_attrs: { readonly: true, value: msg }
        });

    } catch (e) {
        console.error("请求异常:", e);
        showMessage("服务器错误", true);
    }
}