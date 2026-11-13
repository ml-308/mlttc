// src/pages/register.js
/**
 * 注册页（register.html）—— 邀请制注册
 *
 * 流程：
 *   1. 邮箱输入防抖校验：先查注册码（/api/KV），再查邮箱是否已被占用（/api/register-D1?email=）
 *   2. 密码与确认密码一致性校验
 *   3. 勾选同意用户协议/隐私政策（#agreeConsent），未勾选不放行
 *   4. 提交注册（POST /api/register-D1），成功后写入本地同意记录
 *
 * 依赖：/src/consent.js（与 /src/auth-header.js 共用同一模块实例）、
 *       /lib/ui/message.mjs
 */
import { setConsent } from '/src/consent.js';
import { showMessage } from '/lib/ui/message.mjs';
import { createGuard } from '/lib/ui/guard.mjs';
import { TURNSTILE_SITE_KEY } from '/src/config.js';

/** 注册防重复提交：连点会发出多个注册请求，很可能被服务端限流 */
const registerGuard = createGuard('正在注册，请稍候…');

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

//同意勾选
const consentAgree=document.getElementById('agreeConsent');
const consentAgreeBox=document.getElementById('consentAgreeBox');
const agreeMsg=document.getElementById('agreeMsg');

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

//同意勾选：勾选后清除警告提示
consentAgree.addEventListener("change",consentChange);

function consentChange(){
    if(consentAgree.checked){
        consentAgreeBox.classList.remove('invalid','shake');
        agreeMsg.style.display='none';
    }
}

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

// 邮箱输入防抖计时器
let emailDebounceTimer = null;
const EMAIL_DEBOUNCE_DELAY = 300; // 300ms 防抖间隔


//function
function emailinput(){
    const emailin=email.value;
    const back=validateEmail(emailin);

    // 清除之前的防抖计时器
    if (emailDebounceTimer) {
        clearTimeout(emailDebounceTimer);
    }

    if(back!='邮箱格式正确'){
        judge.email=0;
        msgout(email,emailmsg,0,emailin+back);
    }
    else{
        judge.email=1;
        msgout(email,emailmsg,1,emailin+back);
        // 设置防抖：用户停止输入后才发送请求
        emailDebounceTimer = setTimeout(() => {
            emailp(emailin,back);
        }, EMAIL_DEBOUNCE_DELAY);
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

async function refisterbtnclick(){
    emailinput();
    passinput();
    passwordinput();
    passwordconfirminput();

    // 必须阅读并同意《用户协议》与《隐私政策》
    if(!consentAgree.checked){
        agreeMsg.style.display='block';
        agreeMsg.style.color='var(--danger)';
        agreeMsg.textContent='请先阅读并勾选同意《用户协议》与《隐私政策》';
        consentAgreeBox.classList.add('invalid');
        // 重新触发抖动动画
        consentAgreeBox.classList.remove('shake');
        void consentAgreeBox.offsetWidth;
        consentAgreeBox.classList.add('shake');
        consentAgree.focus();
        return;
    }
    consentAgreeBox.classList.remove('invalid','shake');
    agreeMsg.style.display='none';

    console.log(judge);
    if(judge.email!=1||judge.pass!=1||judge.password!=1||judge.passwordconfirm!=1){
        console.log('error');
        return;
    }

    // 人机验证：site key 留空时整段跳过（不加载脚本、不渲染、不传 turnstileToken）
    let token='';
    if(TURNSTILE_SITE_KEY){
        if(!(await ensureTurnstileWidget())) return;   // 加载失败已在 ensure 里提示
        token=await getTurnstileToken();
        if(!token){
            showMessage('人机验证未通过，请稍后重试',true);
            resetTurnstile();
            return;
        }
    }

    const emaili=email.value;
    const passwordi=password.value;
    registerGuard.run(() => writeD1(emaili, passwordi, token));
}

async function writeD1(email,password,token){
    console.log('writeD1');
    // 记录用户同意（本地保存条款版本与时间）
    const consent=setConsent({ source:'register', email: email });
    const body={
        email: email,
        password: password,
        agree: true,
        policyVersion: consent.version,
        agreedAt: consent.time
    };
    // turnstileToken 只在启用并拿到 token 时带上
    if(token) body.turnstileToken=token;

    const res = await fetch('/api/register-D1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
});
    const data=await res.json();
    console.log(data);
    if(!res.ok){
        // token 是一次性的，失败后必须 reset，否则再点注册会一直失败
        resetTurnstile();
        showMessage(data.message,1);
    }
    else{
        showMessage(data.message,0);
        window.location.href='index.html';
    }
}

/* ==================== 人机验证（Cloudflare Turnstile） ==================== */
/* TURNSTILE_SITE_KEY 留空时：不加载第三方脚本、不渲染组件、提交不带 turnstileToken */

const TURNSTILE_SCRIPT_URL='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** 脚本加载 Promise / 组件实例 id / 最近一次 token / 等待 token 的回调 */
let turnstileScriptPromise=null;
let turnstileWidgetId=null;
let turnstileToken='';
let turnstileWaiters=[];

/** 动态加载 Turnstile 脚本（只加载一次）；失败或超时 reject，由调用方降级提示 */
function loadTurnstileScript(){
    if(window.turnstile) return Promise.resolve(window.turnstile);
    if(turnstileScriptPromise) return turnstileScriptPromise;
    turnstileScriptPromise=new Promise((resolve,reject)=>{
        const script=document.createElement('script');
        script.src=TURNSTILE_SCRIPT_URL;
        script.async=true;
        script.defer=true;
        // 15 秒还没加载出来就降级，避免注册按钮点了没反应
        const timer=setTimeout(()=>reject(new Error('turnstile-script-timeout')),15000);
        script.onload=()=>{ clearTimeout(timer); resolve(window.turnstile); };
        script.onerror=()=>{ clearTimeout(timer); reject(new Error('turnstile-script-error')); };
        document.head.appendChild(script);
    }).catch((err)=>{
        turnstileScriptPromise=null;   // 允许下次重试
        throw err;
    });
    return turnstileScriptPromise;
}

/** 唤醒所有等待 token 的回调 */
function flushTurnstileWaiters(token){
    const waiters=turnstileWaiters;
    turnstileWaiters=[];
    waiters.forEach((fn)=>fn(token));
}

/** 等 widget 回调产出 token，超时返回空串 */
function waitForTurnstileToken(timeout){
    return new Promise((resolve)=>{
        const waiter=(token)=>{
            clearTimeout(timer);
            resolve(typeof token==='string'?token:'');
        };
        const timer=setTimeout(()=>{
            turnstileWaiters=turnstileWaiters.filter((fn)=>fn!==waiter);
            resolve('');
        },timeout);
        turnstileWaiters.push(waiter);
    });
}

/**
 * 确保 Turnstile 已渲染就绪
 * site key 留空时直接返回 true 且什么都不做
 */
async function ensureTurnstileWidget(){
    if(!TURNSTILE_SITE_KEY) return true;
    if(turnstileWidgetId!==null) return true;
    const container=document.getElementById('registerTurnstile');
    if(!container) return false;
    try{
        const turnstile=await loadTurnstileScript();
        if(!turnstile||typeof turnstile.render!=='function') throw new Error('turnstile-unavailable');
        turnstileWidgetId=turnstile.render(container,{
            sitekey:TURNSTILE_SITE_KEY,
            // 验证通过 → 记下 token；过期或出错 → 清空，等待用户重新验证
            callback:(token)=>{ turnstileToken=token; flushTurnstileWaiters(token); },
            'expired-callback':()=>{ turnstileToken=''; },
            'error-callback':()=>{ turnstileToken=''; flushTurnstileWaiters(''); }
        });
        return true;
    }catch{
        // 加载失败要明确告诉用户，不能静默卡住
        showMessage('人机验证加载失败，请检查网络后重试',true);
        return false;
    }
}

/** 取当前有效 token；没有就等回调，最多 8 秒 */
async function getTurnstileToken(){
    if(!TURNSTILE_SITE_KEY) return '';
    if(turnstileToken) return turnstileToken;
    if(window.turnstile&&turnstileWidgetId!==null){
        try{
            const token=window.turnstile.getResponse(turnstileWidgetId);
            if(token){ turnstileToken=token; return token; }
        }catch{
            // 拿不到就走等待回调
        }
    }
    return waitForTurnstileToken(8000);
}

/** 重置 widget：token 是一次性的，失败后不 reset 就会一直失败 */
function resetTurnstile(){
    turnstileToken='';
    turnstileWaiters=[];
    if(window.turnstile&&turnstileWidgetId!==null){
        try{ window.turnstile.reset(turnstileWidgetId); }catch{ /* 忽略 */ }
    }
}

/* ==================== GitHub 注册入口与授权回调 ==================== */

const authParam=new URLSearchParams(window.location.search).get('auth');

/** 后端回调带回来的错误码 → 提示文案 */
const AUTH_CALLBACK_MESSAGE={
    'unconfigured':{ text:'GitHub 注册暂未开通（管理员尚未配置）', error:true },
    'state-error':{ text:'授权校验失败，请重试', error:true }
};

function handleAuthCallback(){
    if(!authParam) return;
    const info=AUTH_CALLBACK_MESSAGE[authParam];
    if(info){
        showMessage(info.text,info.error);
        // 清掉查询参数，刷新页面时不再重复提示
        window.history.replaceState(null,'',window.location.pathname);
        return;
    }
    if(authParam==='github'){
        // 后端已用 GitHub 账号完成注册并种下会话 cookie：提示后直接进首页
        showMessage('GitHub 注册成功，正在进入首页…',false);
        window.history.replaceState(null,'',window.location.pathname);
        setTimeout(()=>{ window.location.href='/index.html'; },1200);
    }
}

const githubRegisterBtn=document.getElementById('githubRegisterBtn');
if(githubRegisterBtn){
    githubRegisterBtn.addEventListener('click',()=>{
        // 交给后端发起 GitHub 授权；from=register 让回调完成后回到注册页
        window.location.href='/api/auth-github?from=register';
    });
}

handleAuthCallback();

/* site key 非空时，进页面就把人机验证渲染出来 */
if(TURNSTILE_SITE_KEY){
    ensureTurnstileWidget();
}

/* ==================== 进入注册页时的提示框 ==================== */
/* 提示内容留空，需要填写时直接写在 register.html 的 #registerNoticeBody 内 */

const noticeModal=document.getElementById('registerNoticeModal');
const noticeCloseBtn=document.getElementById('registerNoticeClose');

function openRegisterNotice(){
    if(noticeModal) noticeModal.style.display='flex';
}

function closeRegisterNotice(){
    if(noticeModal) noticeModal.style.display='none';
}

if(noticeModal){
    // 进入页面即弹出
    openRegisterNotice();

    // 点击右上角 × 关闭
    noticeCloseBtn?.addEventListener('click',closeRegisterNotice);

    // 点击遮罩空白处关闭
    noticeModal.addEventListener('click',(e)=>{
        if(e.target===noticeModal) closeRegisterNotice();
    });

    // 按 Esc 关闭
    document.addEventListener('keydown',(e)=>{
        if(e.key==='Escape' && noticeModal.style.display==='flex') closeRegisterNotice();
    });
}