let username,pass,passin,password_in,yes_password;
let t1=0,t2=0,t3=0,t4=0;

const API_BASE='/api/register-keep';
const TOKEN_COOKIE_NAME='users';

async function emailValidation(){
    username="";
    username = document.getElementById("username").value;
    let t = username.indexOf("@");
    let e = username.lastIndexOf(".");

    if (t > 0 && e > 0 && t < e) {
        pass="";
        pass=await passget(username);
        document.getElementById('passwordMsg').innerHTML=pass;
        document.getElementById('passwordMsg').style.display = "block";
        if(pass!=""&&pass!=null&&pass!=undefined&&pass!="null"&&pass!="undefined"){
        document.getElementById("username").style.borderColor = "#1eff00";
        document.getElementById("usernameMsg").style.display = "block";
        document.getElementById("usernameMsg").style.color = "#1eff00";
        document.getElementById("usernameMsg").innerHTML = username+"邮箱格式正确，且有注册权限";
        t1=1;
        }
   
    } 

    else {
        document.getElementById("username").style.borderColor = "#ff0000";
        document.getElementById("usernameMsg").style.display = "block";
        document.getElementById("usernameMsg").style.color = "#ff0000";
        document.getElementById("usernameMsg").innerHTML = username+"不是合法的邮箱";
        t1=0;
    }
}


async function passget(username) {
  const re = await fetch('/api/register-get?action=get&key=' + encodeURIComponent(username));
  const data = await re.json();
  console.log(data);
  if (re.ok&&re!=undefined) {
    return data.value;
  } else {
    document.getElementById("username").style.borderColor = "#ffd20a";
    document.getElementById("usernameMsg").style.display = "block";
    document.getElementById("usernameMsg").style.color = "#ffd20a";
    document.getElementById("usernameMsg").innerHTML = username+"邮箱合法，但您没有注册权限";
    t1=0;  // 让调用方捕获
    throw new Error(data.error || '获取失败');
  }
}

async function passinc(){
    passin=document.getElementById("passc").value;
    pass=await passget(username);
    if(passin==pass){
        document.getElementById("passc").style.borderColor = "#1eff00";
        document.getElementById("passcMsg").style.display = "block";
        document.getElementById("passcMsg").style.color = "#1eff00";
        document.getElementById("passcMsg").innerHTML = "注册码正确";   
        t2=1;  
    }
    else{
        document.getElementById("passc").style.borderColor = "#ff0000";
        document.getElementById("passcMsg").style.display = "block";
        document.getElementById("passcMsg").style.color = "#ff0000";
        document.getElementById("passcMsg").innerHTML = "注册码错误";  
        t2=0;      
    }
}

function passwordin(){
    password_in=document.getElementById("password").value;
    if(password_in.length>=6&&password_in.length<=16){
    document.getElementById("password").style.borderColor = "#1eff00";
    document.getElementById("passwordMsg").style.display = "block";
    document.getElementById("passwordMsg").style.color = "#1eff00";
    document.getElementById("passwordMsg").innerHTML = "密码合法";  
    t3=1;  
    }
    else{
        document.getElementById("password").style.borderColor = "#ff0000";
        document.getElementById("passwordMsg").style.display = "block";
        document.getElementById("passwordMsg").style.color = "#ff0000";
        document.getElementById("passwordMsg").innerHTML = "密码长度不合法，请输入6-16位的密码"; 
        t3=0; 
    }
   
}

function passwordyesc(){

    yes_password=document.getElementById("passwordyes").value;
    if(yes_password==password_in){
        document.getElementById("passwordyes").style.borderColor = "#1eff00";
        document.getElementById("passwordyesMsg").style.display = "block";
        document.getElementById("passwordyesMsg").style.color = "#1eff00";
        document.getElementById("passwordyesMsg").innerHTML = "确认密码正确";  
        t4=1;  
    }
    else{
        document.getElementById("passwordyes").style.borderColor = "#ff0000";
        document.getElementById("passwordyesMsg").style.display = "block";
        document.getElementById("passwordyesMsg").style.color = "#ff0000";
        document.getElementById("passwordyesMsg").innerHTML = "密码两次不相同"; 
        t4=0; 
    }
}

function register(){
    if(t1==1&&t2==1&&t3==1&&t4==1){
        handleRegister();
    }
    else{
        alert("请先完成所有验证");
    }
}

function setCookie(name, value, days=30){
    const expeires=new Date(Date.now()+days*864e5).toUTCString();
    document.cookie=`${endcodeURIComponent(name)}=${encodeURIComponent(value)};expires=${expeires};path=/;SameSite=Lax`;
} 

function getcookie(name){
    const cookies=document.cookie.split(';');
    for(const cookie of cookies){
        const [key,value]=cookie.split('=');
        if(decodeURIComponent(key)==name){
            return decodeURIComponent(value);
        }
    }
    return null;
}

function erasecookie(name){
    document.cookie=`${encodeURIComponent(name)}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
}

async function request(path, method = 'GET', body = null, needAuth = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (needAuth) {
    const token = getCookie(TOKEN_COOKIE_NAME);
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
  }

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(API_BASE + path, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `请求失败 (${res.status})`);
  }
  return data;
}

async function handleRegister() {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  try {
    const data = await request('/register', 'POST', { username, password });
    showMessage(data.message || '注册成功，请登录');
  } catch (err) {
    showMessage(err.message, true);
  }
}
