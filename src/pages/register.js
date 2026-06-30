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

//Msg out
function msgout(input,inputmsg,judge,msg){
    if(judge==1){
        inputmsg.style.color="#1eff01";
        inputmsg.style.display="block";
        inputmsg.innerHTML=msg;
        input.style.borderColor="#1eff01";
    }
    if(judge==0){
        inputmsg.style.color="#ff0000";
        inputmsg.style.display="block";
        inputmsg.innerHTML=msg;
        input.style.borderColor="#ff0000";
    }
    if(judge==2){
        inputmsg.style.color="#ffd20a";
        inputmsg.style.display="block";
        inputmsg.innerHTML=msg;
        input.style.borderColor="#ffd20a";
    }
}

function validateEmail(value) {
  const email = value.trim();
  if (!email) {
    return '邮箱不能为空';
  }
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!regex.test(email)) {
    return '邮箱格式不正确';
  }
  return '邮箱格式正确'; 
}

//btn
const registerbtn=document.getElementById('registerbtn');

//input
const email=document.getElementById('email');
const pass=document.getElementById('pass');
const password=document.getElementById('password');
const passwordconfirm=document.getElementById('passwordconfirm');

//MSG
const emailmsg=document.getElementById('emailMsg');
const passmsg=document.getElementById('passMsg');
const passwordmsg=document.getElementById('passwordMsg');
const passwordconfirmmsg=document.getElementById('passwordconfirmMsg');


//btn click
registerbtn.addEventListener("click",refisterbtnclick);

//input input
email.addEventListener("input",emailinput);
pass.addEventListener("input",passinput);
password.addEventListener("input",passwordinput);
passwordconfirm.addEventListener("input",passwordconfirminput);

let judge={
    email:0,
    pass:0,
    password:0,
    passwordconfirm:0
};

let input={
    email:'',
    password:'',
    passwordconfirm:'',
    key:'',
};


//function
function emailinput(){
    const emailin=email.value;
    const back=validateEmail(emailin);
    if(back!='邮箱格式正确'){
        judge.email=0;
        msgout(email,emailmsg,0,emailin+back);
    }
    else{
        judge.email=1;
        msgout(email,emailmsg,1,emailin+back);
        emailp(emailin,back);
    }

}

async function emailp(email1,back){
    const res=await fetch(`/api/KV?key=${email1}`);
    const data=await res.json();
    const re=await fetch(`/api/register-D1?email=${email1}`);
    const dat=await re.json();
    if(!re.ok){
        msgout(email,emailmsg,0,email1+back+","+dat.message);
    }
    else{
        if(!res.ok){        
        msgout(email,emailmsg,data.way,email1+back+","+data.message);
    }
        else{
            msgout(email,emailmsg,1,email1+back+","+data.message);
            input.key=data.value;
            console.log(data.value);
            console.log(input.key);
    }
}
}

function passinput(){
    const passin=pass.value;
    if(input.key==""){
        judge.pass=0;
        msgout(pass,passmsg,0,'您没有注册权限');
    }
    if(passin==input.key){
        judge.pass=1;
        msgout(pass,passmsg,1,'注册码正确');
    }
    else{
        judge.pass=0;
        msgout(pass,passmsg,0,'注册码错误');
    }
}

function passwordinput(){
    const pass=password.value;
    if(pass.length<6||pass.length>16){
        judge.pass=0;
        msgout(password,passwordmsg,0,'密码长度不能小于6位或大于16位');
    }
    else{
        judge.password=1;
        msgout(password,passwordmsg,1,'密码长度正确');
        input.password=password;
    }
}

function passwordconfirminput(){
    const pass=passwordconfirm.value;
    if(pass!=password.value){
        judge.passwordconfirm=0;
        msgout(passwordconfirm,passwordconfirmmsg,0,'两次密码输入不一致');
    }
    else{
        judge.passwordconfirm=1;
        msgout(passwordconfirm,passwordconfirmmsg,1,'两次密码输入一致');
        input.passwordconfirm=passwordconfirm;
    }
}

function refisterbtnclick(){
    emailinput();
    passinput();
    passwordinput();
    passwordconfirminput();
    console.log(judge);
    if(judge.email!=1||judge.pass!=1||judge.password!=1||judge.passwordconfirm!=1){
        console.log('error');
        return;
    }
    const emaili=email.value;
    const passwordi=password.value;
    writeD1(emaili,passwordi);
}

async function writeD1(email,password){
    console.log('writeD1');
    const res = await fetch('/api/register-D1', {
        method: 'POST',
        heaers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        email: email,
        password: password
  })
});
    const data=await res.json();
    console.log(data);
    if(!res.ok){
        showMessage(data.message,1);
    }
    else{
        showMessage(data.message,0);
        window.location.href='index.html';
    }
}