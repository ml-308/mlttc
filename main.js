// 显示提示信息
function showPopup(message, duration) {
    const popup = document.createElement('div');
    popup.style.position = 'fixed';
    popup.style.top = '20px';
    popup.style.left = '50%';
    popup.style.transform = 'translateX(-50%)';
    popup.style.backgroundColor = '#4CAF50';
    popup.style.color = 'white';
    popup.style.padding = '10px 20px';
    popup.style.borderRadius = '5px';
    popup.style.zIndex = '1000';
    popup.style.boxShadow = '0 2px 10px rgba(0,0,0,0.2)';
    popup.textContent = message;
    document.body.appendChild(popup);

    setTimeout(() => {
        popup.remove();
    }, duration);
}



function login_btn(){         // 登录按钮点击事件
    document.getElementById('globalLoginModal').style.display = 'block';
}
function close_login_modal(){    // 关闭登录弹窗
    document.getElementById('globalLoginModal').style.display = 'none';
}
let username,password;
let n=0;
function username_in(){         // 用户名输入框输入事件
    username=document.getElementById("username").value;
}
function password_in(){         // 密码输入框输入事件
    password=document.getElementById("password").value;
}
function login_success(){        // 登录成功事件
    document.getElementById("globalLoginModal").style.display="none";
    document.getElementById("globalLoginBtn").style.display="none";
    document.getElementById("globalUserInfo").style.display="block";
    document.getElementById("globalDisplayName").innerHTML=username;
    localStorage.setItem('loggedInUser', username);
    showPopup('登录成功', 2000);

}
function login_btn2(){          // 登录按钮点击事件
    n=0;
    for(let i=0;i<test_user.length;i++){
        if(test_user[i]==username && test_password[i]==password){
        login_success();
        n=1;
        break;
    }
}
if(n!=1){
    document.getElementById("ErrorLogin").style.display="block";
}
}
function login_out(){            // 退出登录事件
    document.getElementById("globalUserInfo").style.display="none";
    document.getElementById("globalDisplayName").innerHTML="";
    document.getElementById("globalLoginBtn").style.display="block";
    username="";
    password="";
    localStorage.removeItem('loggedInUser');
    document.getElementById("username").value="";
    document.getElementById("password").value="";
    showPopup('退出成功', 2000);
}

function back(){                 // 返回index.html按钮点击事件
    window.location.href = "index.html";
    if(username!=""){
        document.getElementById("globalLoginModal").style.display="none";
        document.getElementById("globalLoginBtn").style.display="none";
        document.getElementById("globalUserInfo").style.display="block";
        document.getElementById("globalDisplayName").innerHTML=username;
    }
    else{
        document.getElementById("globalUserInfo").style.display="none";
        document.getElementById("globalDisplayName").innerHTML="";
        document.getElementById("globalLoginBtn").style.display="block";
    }
}

function timetable(){
    window.location.href="timetable.html"
    if(username!=""){
        document.getElementById("globalLoginModal").style.display="none";
        document.getElementById("globalLoginBtn").style.display="none";
        document.getElementById("globalUserInfo").style.display="block";
        document.getElementById("globalDisplayName").innerHTML=username;
    }
    else{
        document.getElementById("globalUserInfo").style.display="none";
        document.getElementById("globalDisplayName").innerHTML="";
        document.getElementById("globalLoginBtn").style.display="block";
    }
}

// 页面加载时检查登录状态
window.onload = function() {
    const loggedInUser = localStorage.getItem('loggedInUser');
    if(loggedInUser) {
        username = loggedInUser;
        document.getElementById("globalLoginModal").style.display="none";
        document.getElementById("globalLoginBtn").style.display="none";
        document.getElementById("globalUserInfo").style.display="block";
        document.getElementById("globalDisplayName").innerHTML=username;
    }
}

function register_btn(){
    window.location.href="register.html";

}


