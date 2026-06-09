let username,password;
let n=0;
const API_BASE='/api/register-keep';
const TOKEN_COOKIE_NAME='users';
function username_in(){
    username=document.getElementById("username").value;
}
function password_in(){
    password=document.getElementById("password").value;
}
function login_success(){
    document.getElementById("globalLoginModal").style.display="none";
    document.getElementById("globalLoginBtn").style.display="none";
    document.getElementById("globalUserInfo").style.display="block";
    document.getElementById("globalDisplayName").innerHTML=username;
}
async function login_btn2(){
      try {
    const data = await request('/login', 'POST', { username, password });
    setCookie(TOKEN_COOKIE_NAME, data.token);
    showMessage('登录成功！');
    login_success();
  } catch (err) {
    showMessage(err.message, true);
  }
}
function login_out(){
    eraseCookie(TOKEN_COOKIE_NAME);
    document.getElementById("globalUserInfo").style.display="none";
    document.getElementById("globalDisplayName").innerHTML="";
    document.getElementById("globalLoginBtn").style.display="block";
    username="";
    password="";
}

function showMessage(msg, isError = false) {
  const box = document.getElementById('【messageBox】');
  if (box) {
    box.textContent = msg;
    box.style.color = isError ? 'red' : 'green';
  }
}

function register_btn(){
    window.location.href="timetable.html";
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