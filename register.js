let username,pass,passin,password_in,yes_password;
let t1=0,t2=0,t3=0,t4=0;



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

async function handleRegister() {
  // 1. 获取用户输入（假设你的 HTML 中有 id 为 username 和 password 的输入框）
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const passwordConfirm = document.getElementById('passc').value;




  // 3. 禁用提交按钮，防止重复点击
  const btn = document.getElementById('registerBtn');
  btn.disabled = true;
  btn.textContent = '注册中...';

  try {
    const response = await fetch('/api/register-keep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await response.json();

    if (response.ok && data.success) {
      showMessage('注册成功！即将跳转到登录页...', 'success');
      // 可选：自动跳转到登录页
      setTimeout(() => { window.location.href = '/login.html'; }, 1500);
    } else {
      // 显示后端返回的具体错误（如“用户名已存在”）
      showMessage(data.error || '注册失败，请稍后再试', 'error');
    }
  } catch (err) {
    // 网络错误或 JSON 解析失败
    showMessage('网络错误，请检查连接后重试', 'error');
    console.error('注册请求失败:', err);
  } finally {
    // 4. 恢复按钮状态
    btn.disabled = false;
    btn.textContent = '注册';
  }
}

// 简易消息提示函数（可用你自己的 UI 库替代）
function showMessage(msg, type) {
  const box = document.getElementById('messageBox');
  box.textContent = msg;
  box.className = type;  // 通过 CSS 控制颜色
  box.style.display = 'block';
}