const tabConfig = {
    add: {
        formId: 'add-form',
        buttonId: 'add-btn',
        activeClass: 'add-btn-act'
    },
    search: {
        formId: 'search-form',
        buttonId: 'search-btn',
        activeClass: 'search-btn-act'
    },
    delete: {
        formId: 'delete-form',
        buttonId: 'delete-btn',
        activeClass: 'delete-btn-act'
    }
};

function setActiveTab(tabName) {
    Object.keys(tabConfig).forEach((key) => {
        const { formId, buttonId, activeClass } = tabConfig[key];
        const form = document.getElementById(formId);
        const button = document.getElementById(buttonId);
        if (form) {
            form.classList.toggle('hidden', key !== tabName);
        }
        if (button) {
            button.classList.toggle(activeClass, key === tabName);
        }
    });
}

// 显示添加时刻表表单
function addForm() {
    setActiveTab('add');
}

// 显示查询时刻表表单
function searchForm() {
    setActiveTab('search');
}

// 显示删除时刻表表单
function deleteForm() {
    setActiveTab('delete');
}

// 页面加载时默认隐藏所有表单
window.onload = function() {
    Object.keys(tabConfig).forEach((key) => {
        const { formId, buttonId, activeClass } = tabConfig[key];
        const form = document.getElementById(formId);
        const button = document.getElementById(buttonId);
        if (form) {
            form.classList.add('hidden');
        }
        if (button) {
            button.classList.remove(activeClass);
        }
    });
};

let city,way,start,end,bc,time1,time2,exec_time,time1in,time2in;
let timeerror,errorout;
let t1,t2,t3,t4,t5,t6,t7;
let time1c=[],time2c=[];

function timetest(time){//时刻表检查
    timeerror='';
    time=time.replaceAll('\n'," ");
    let timec = time.split(' ');
    for(let i=0;i<timec.length;i++){
        if(timec[i]==" "||timec[i]==""){
            if(i>0){
                continue;
            }
        }
        if(timec[i]>=2400||timec[i]<0||timec[i].length!=4||isNaN(timec[i])||timec[i]%100>=60||timec[i].length!=4||isNaN(timec[i])||timec[i]%100>=60){
            timeerror+=timec[i]+'\t';
        }
        
    }
}

function etimetest(time){//执行时间检查
    let timec = time.split('.');
    if(timec[0].length!=4){
        timec[0]="20"+timec[0];
    }

    if(timec.length!=3||timec[0]<=0||timec[0].length!=4||timec[1]>12||timec[1]<1||timec[2]>31||timec[2]<1||timec[1].length>2||timec[2].length>2){
        return false;
    }
    return true;
}

function strtime(time){
    time=time.replaceAll('\n'," ");
    let timec=time.split(' ');
    time="";
    timec.sort();
    let n=0;
    for(let i=0;i<timec.length;i++){
        let naw=timec[i];
        let next="0000";
        if(i<=timec.length-2){
            next=timec[i+1];
        }
        if(naw==" "||naw==""){
            continue;
        }
        time+=naw.slice(0,2)+':'+naw.slice(2,4)+"\t";
        n+=1;
        if(n==5){
            time+="\n";
            n=0;
        }
    }

    return time;

}

//Add时刻表表单提交start
function pd(){//判断
    if(t1==1&&t2==1&&t3==1&&t4==1&&t5==1&&t6==1&&t7==1){ 
        document.getElementById('submitAddBtn').innerHTML = '点击提交时刻表';
        document.getElementById('submitAddBtn').style.borderColor = '#1eff01';
        document.getElementById('submitAddBtn').style.backgroundColor = '#1eff01';
        return 1;
    }

    else{
        document.getElementById('submitAddBtn').innerHTML = '请输入时刻表';
        document.getElementById('submitAddBtn').style.borderColor = '#ff0000';
        document.getElementById('submitAddBtn').style.backgroundColor = '#ff0000';
        return 0;
    }
}


function citychange(){  //城市
    document.getElementById('city').style.borderColor = '#ffd20a';
    city = document.getElementById('city').value;
    if(city.length>0&&city!=" "){
        let u=city.indexOf('市');
        if(u<0){
            city+='市';
            document.getElementById('city').value = city;
        }
        t1=1;
        document.getElementById('city').style.borderColor = '#1eff01';
        document.getElementById('citytest').innerHTML = "'"+city+"'" + ' 是一个合法地点';
        document.getElementById('citytest').style.color = '#1eff01';


    }
    else{
        t1=0;
        document.getElementById('city').style.borderColor = '#ff0000';
        document.getElementById('citytest').innerHTML = '请输入城市';
        document.getElementById('citytest').style.color = '#ff0000';
    }
            pd();
}

function waychange(){
    document.getElementById('way').style.borderColor = '#ffd20a';
    way = document.getElementById('way').value;
    if(way.length>0&&way!=" "){
        document.getElementById('way').style.borderColor = '#1eff01';
        document.getElementById('waytest').innerHTML = '"'+ way+'" 是一个合法线路';
        document.getElementById('waytest').style.color = '#1eff01';

        t2=1;

    }
    else{
        t2=0;
        document.getElementById('way').style.borderColor = '#ff0000';
        document.getElementById('waytest').innerHTML = '请输入线路';
        document.getElementById('waytest').style.color = '#ff0000';
    }
            pd();
}

function startchange(){
    document.getElementById('start').style.borderColor = '#ffd20a';
    start = document.getElementById('start').value;
    if(start.length>0&&start!=" "){
        let u=start.indexOf('站');
        t3=1;

        if(u<0){
            start+='站';
            document.getElementById('start').value = start;}
        document.getElementById('start').style.borderColor = '#1eff01';
        document.getElementById('starttest').innerHTML = '"'+ start+'" 是一个合法起点';
        document.getElementById('starttest').style.color = '#1eff01';
    }
    else{
        t3=0;
        document.getElementById('start').style.borderColor = '#ff0000';
        document.getElementById('starttest').innerHTML = '请输入起点';
        document.getElementById('starttest').style.color = '#ff0000';
    }
            pd();
}

function endchange(){
    document.getElementById('end').style.borderColor = '#ffd20a';
    end = document.getElementById('end').value;
    if(end.length>0&&end!=" "){
        let u=end.indexOf('站');
        t4=1;

        if(u<0){
            end+='站';
            document.getElementById('end').value = end;}
        document.getElementById('end').style.borderColor = '#1eff01';
        document.getElementById('endtest').innerHTML ='"'+ end+'" 是一个合法终点';
        document.getElementById('endtest').style.color = '#1eff01';
    }
    else{
        t4=0;
        document.getElementById('end').style.borderColor = '#912c2c';
        document.getElementById('endtest').innerHTML = '请输入终点';
        document.getElementById('endtest').style.color = '#ffffff';
    }
            pd();
}

function bcchange(){
    document.getElementById('bc').style.borderColor = '#ffd20a';
    bc = document.getElementById('bc').value;
    bc="("+bc+")";
    document.getElementById('bc').style.borderColor = '#1eff01';
    document.getElementById('bc').value=bc;
    document.getElementById('bctest').innerHTML = '"'+bc+'" 是一个合法备注';
    document.getElementById('bctest').style.color = '#1eff01';


}



function time1change(){
    document.getElementById('time1').style.borderColor = '#ffd20a';
    document.getElementById('time1b').style.display = 'flex';
    document.getElementById('cl1').style.display='flex';
    time1 = document.getElementById('time1').value;
    time1in=time1;
    timetest(time1);
    errorout='';
    for(let i=0;i<timeerror.split('\t').length;i++){
        errorout+=timeerror.split('\t')[i]+'\t';
    }
    if(timeerror.length==0){
        t5=1;
        time1=strtime(time1);
        document.getElementById('time1').readOnly = true;
        document.getElementById('time1').value=time1;
        document.getElementById('time1').style.borderColor = '#1eff01';
        document.getElementById('time1test').innerHTML = ' 这是一个合法时刻表';
        document.getElementById('time1test').style.color = '#1eff01';
        document.getElementById('back1').style.display = 'flex';
    }
    else{
        t5=0;
        document.getElementById('time1').style.borderColor = '#ff0000';
        document.getElementById('time1test').innerHTML = '以下时刻不合法: '+errorout;
        document.getElementById('time1test').style.color = '#ff0000';
    }
            pd();
}

function clt1(){
    document.getElementById('cl1').style.display = 'none';
    document.getElementById('back1').style.display='none';
    document.getElementById('time1').style.borderColor = '#ffffff';
    document.getElementById('time1').value="";
    document.getElementById('time1').style.borderColor = '#ffffff';
    document.getElementById('time1test').innerHTML = '';
    document.getElementById('time1').readOnly = false;
    t5=0;
    time1="";
    pd();
}

function backone(){
    document.getElementById('time1').readOnly = false;
    document.getElementById('time1').value=time1in;
    document.getElementById('back1').style.display='none';
    t5=0;
    pd();
    document.getElementById('time1').style.borderColor = '#ff0000';
    document.getElementById('time1test').innerHTML = "请修改时刻表";
    document.getElementById('time1test').style.color = '#ff0000';
}

function time2change(){
    document.getElementById('time2').style.borderColor = '#ffd20a';
    document.getElementById('time2b').style.display = 'flex';
    document.getElementById('cl2').style.display='flex';
    time2 = document.getElementById('time2').value;
    timetest(time2);
    errorout='';
    for(let i=0;i<timeerror.split('\t').length;i++){
        errorout+=timeerror.split('\t')[i]+'\t';
    }
    if(timeerror.length==0){
        t6=1;
        time2in=time2;
        time2=strtime(time2);
        document.getElementById('time2').readOnly = true;
        document.getElementById('time2').value=time2;
        document.getElementById('time2').style.borderColor = '#1eff01';
        document.getElementById('time2test').innerHTML = ' 这是一个合法时刻表';
        document.getElementById('time2test').style.color = '#1eff01';
        document.getElementById('back2').style.display = 'flex';
    }
    else{
        t6=0;
        document.getElementById('time2').style.borderColor = '#ff0000';
        document.getElementById('time2test').innerHTML = '以下时刻不合法: '+errorout;
        document.getElementById('time2test').style.color = '#ff0000';
    }
            pd();
}

function clt2(){
    document.getElementById('cl2').style.display = 'none';
    document.getElementById('back2').style.display='none';
    document.getElementById('time2').style.borderColor = '#ffffff';
    document.getElementById('time2').value="";
    document.getElementById('time2').style.borderColor = '#ffffff';
    document.getElementById('time2test').innerHTML = '';
    document.getElementById('time2').readOnly = false;
    t6=0;
    time2="";
    pd();
}

function backtwo(){
    document.getElementById('time2').value=time2in;
    document.getElementById('time2').readOnly = false;
    document.getElementById('back2').style.display='none';
    t6=0;
    pd();
    document.getElementById('time2').style.borderColor = '#ff0000';
    document.getElementById('time2test').innerHTML = "请修改时刻表";
    document.getElementById('time2test').style.color = '#ff0000';
}

function exec_timechange(){
    document.getElementById('exec-time').style.borderColor = '#ffd20a';
    exec_time = document.getElementById('exec-time').value;
    if(exec_time.length>0){
    if(etimetest(exec_time)){
        let timec = exec_time.split('.');
        if(timec[0].length!=4){
            exec_time="20"+exec_time;
        }
        t7=1;

        document.getElementById('exec-time').style.borderColor = '#1eff01';
        document.getElementById('exec-time').value=exec_time;
        document.getElementById('exec-timetest').innerHTML = '"'+exec_time+'" 是一个合法执行时间';
        document.getElementById('exec-timetest').style.color = '#1eff01';
    }
    else{
        t7=0;
        document.getElementById('exec-time').style.borderColor = '#ff0000';
        document.getElementById('exec-timetest').innerHTML = '"'+exec_time+'" 不是一个合法的执行时间';
        document.getElementById('exec-timetest').style.color = '#ff0000';
    }
}
    else{
        t7=0;
            document.getElementById('exec-time').style.borderColor = '#ff0000';
            document.getElementById('exec-timetest').innerHTML = '请输入执行时间';
            document.getElementById('exec-timetest').style.color = '#ff0000';
        }
                pd();
}


function cleanAddForm(){
    // 清空表单字段值
    document.getElementById('city').value = '';
    document.getElementById('way').value = '';
    document.getElementById('start').value = '';
    document.getElementById('end').value = '';
    document.getElementById('time1').value = '';
    document.getElementById('time2').value = '';
    document.getElementById('exec-time').value = '';
    document.getElementById('bc').value = '';

    // 重置字段样式
    const fields = ['city', 'way', 'start', 'end', 'time1', 'time2', 'exec-time', 'bc'];
    fields.forEach(field => {
        document.getElementById(field).style.borderColor = '';
    });

    // 清空验证提示信息
    const testElements = ['citytest', 'waytest', 'starttest', 'endtest', 'time1test', 'time2test', 'exec-timetest', 'bctest'];
    testElements.forEach(el => {
        document.getElementById(el).innerHTML = '';
    });

    document.getElementById('cl1').style.display = 'none';
    document.getElementById('time1').style.borderColor = '#ffffff';
    document.getElementById('time1').value="";
    document.getElementById('time1').style.borderColor = '#ffffff';
    document.getElementById('time1test').innerHTML = '';
    document.getElementById('time1').readOnly = false;
    document.getElementById('cl2').style.display = 'none';
    document.getElementById('time2').style.borderColor = '#ffffff';
    document.getElementById('time2').value="";
    document.getElementById('time2').style.borderColor = '#ffffff';
    document.getElementById('time2test').innerHTML = '';
    document.getElementById('time2').readOnly = false;
    document.getElementById('back1').style.display='none';
    document.getElementById('back2').style.display='none';


    // 重置状态变量
    city = '';
    way = '';
    start = '';
    end = '';
    time1 = '';
    time2 = '';
    exec_time = '';
    bc = '';
    t1=0;
    t2=0;
    t3=0;
    t4=0;
    t5=0;
    t6=0;
    t7=0;
    pd();
}

//Add时刻表表单提交end

//Search时刻表表单提交start

let searchcity,searchway;

function search_city(){  //城市
    document.getElementById('search-city').style.borderColor = '#ffd20a';
    searchcity = document.getElementById('search-city').value;
    if(searchcity.length>0&&searchcity!=" "){
        let u=searchcity.indexOf('市');
        if(u<0){
            searchcity+='市';
            document.getElementById('search-city').value = searchcity;
        }
        document.getElementById('search-city').style.borderColor = '#1eff01';
        document.getElementById('search-citytest').innerHTML = "'"+searchcity+"'" + ' 是一个合法地点';
        document.getElementById('search-citytest').style.color = '#1eff01';


    }
    else{
        document.getElementById('search-city').style.borderColor = '#ff0000';
        document.getElementById('search-citytest').innerHTML = '请输入城市';
        document.getElementById('search-citytest').style.color = '#ff0000';
    }
}

function search_way(){
    document.getElementById('search-way').style.borderColor = '#ffd20a';
    searchway = document.getElementById('search-way').value;
    if(searchway.length>0&&searchway!=" "){
        document.getElementById('search-way').style.borderColor = '#1eff01';
        document.getElementById('search-waytest').innerHTML = '"'+ searchway+'" 是一个合法线路';
        document.getElementById('search-waytest').style.color = '#1eff01';


    }
    else{
        document.getElementById('search-way').style.borderColor = '#ff0000';
        document.getElementById('search-waytest').innerHTML = '请输入线路';
        document.getElementById('search-waytest').style.color = '#ff0000';
    }
}
