let username, pass, passin, password_in, yes_password;
let t1 = 0, t2 = 0, t3 = 0, t4 = 0;

const API_BASE = '/api/auth';

// ---------- 邮箱格式与是否已注册检查 ----------
async function emailValidation() {
    username = document.getElementById("username").value.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(username)) {
        document.getElementById("username").style.borderColor = "#ff0000";
        document.getElementById("usernameMsg").style.display = "block";
        document.getElementById("usernameMsg").style.color = "#ff0000";
        document.getElementById("usernameMsg").innerHTML = username + " 不是合法的邮箱";
        t1 = 0;
        return;
    }

    // 检查邮箱是否已被注册
    try {
        const existing = await passget(username);
        if (existing) {
            // 邮箱已存在
            document.getElementById("username").style.borderColor = "#ff0000";
            document.getElementById("usernameMsg").style.display = "block";
            document.getElementById("usernameMsg").style.color = "#ff0000";
            document.getElementById("usernameMsg").innerHTML = username + " 已被注册，请直接登录";
            t1 = 0;
        } else {
            // 邮箱可用
            document.getElementById("username").style.borderColor = "#1eff00";
            document.getElementById("usernameMsg").style.display = "block";
            document.getElementById("usernameMsg").style.color = "#1eff00";
            document.getElementById("usernameMsg").innerHTML = username + " 邮箱格式正确，可以使用";
            t1 = 1;
        }
    } catch (err) {
        // 网络错误或接口不可用
        document.getElementById("username").style.borderColor = "#ff0000";
        document.getElementById("usernameMsg").style.display = "block";
        document.getElementById("usernameMsg").style.color = "#ff0000";
        document.getElementById("usernameMsg").innerHTML = "邮箱验证失败，请稍后再试";
        t1 = 0;
    }
}

// ---------- 调用 API 查询邮箱是否已注册 ----------
async function passget(username) {
    const re = await fetch(`/api/register-get?action=get&key=${encodeURIComponent(username)}`);
    if (!re.ok) {
        // 非 200 响应（如 404 表示未找到，也可能接口不存在）
        return null;
    }
    const data = await re.json();
    // 如果 data.value 存在且不为空，表示已注册
    if (data.value && data.value !== '') {
        return data.value;
    }
    return null;
}

// ---------- 注册码验证（保留，可能需要） ----------
async function passinc() {
    passin = document.getElementById("passc").value;
    try {
        const code = await passget(username);
        if (passin === code) {
            document.getElementById("passc").style.borderColor = "#1eff00";
            document.getElementById("passcMsg").style.display = "block";
            document.getElementById("passcMsg").style.color = "#1eff00";
            document.getElementById("passcMsg").innerHTML = "注册码正确";
            t2 = 1;
        } else {
            document.getElementById("passc").style.borderColor = "#ff0000";
            document.getElementById("passcMsg").style.display = "block";
            document.getElementById("passcMsg").style.color = "#ff0000";
            document.getElementById("passcMsg").innerHTML = "注册码错误";
            t2 = 0;
        }
    } catch (err) {
        document.getElementById("passc").style.borderColor = "#ff0000";
        document.getElementById("passcMsg").style.display = "block";
        document.getElementById("passcMsg").style.color = "#ff0000";
        document.getElementById("passcMsg").innerHTML = "验证失败";
        t2 = 0;
    }
}

// ---------- 密码强度验证 ----------
function passwordin() {
    password_in = document.getElementById("password").value;
    if (password_in.length >= 6 && password_in.length <= 16) {
        document.getElementById("password").style.borderColor = "#1eff00";
        document.getElementById("passwordMsg").style.display = "block";
        document.getElementById("passwordMsg").style.color = "#1eff00";
        document.getElementById("passwordMsg").innerHTML = "密码合法";
        t3 = 1;
    } else {
        document.getElementById("password").style.borderColor = "#ff0000";
        document.getElementById("passwordMsg").style.display = "block";
        document.getElementById("passwordMsg").style.color = "#ff0000";
        document.getElementById("passwordMsg").innerHTML = "密码长度不合法，请输入6-16位密码";
        t3 = 0;
    }
}

// ---------- 确认密码匹配 ----------
function passwordyesc() {
    yes_password = document.getElementById("passwordyes").value;
    if (yes_password === password_in) {
        document.getElementById("passwordyes").style.borderColor = "#1eff00";
        document.getElementById("passwordyesMsg").style.display = "block";
        document.getElementById("passwordyesMsg").style.color = "#1eff00";
        document.getElementById("passwordyesMsg").innerHTML = "确认密码正确";
        t4 = 1;
    } else {
        document.getElementById("passwordyes").style.borderColor = "#ff0000";
        document.getElementById("passwordyesMsg").style.display = "block";
        document.getElementById("passwordyesMsg").style.color = "#ff0000";
        document.getElementById("passwordyesMsg").innerHTML = "两次密码不一致";
        t4 = 0;
    }
}

// ---------- 提交注册（所有验证通过后） ----------
function registerbtn() {
    if (t1 === 1 && t2 === 1 && t3 === 1 && t4 === 1) {
        register();
    } else {
        alert("请先完成所有验证");
    }
}

// ---------- 真正的注册请求 ----------
async function register() {
    const email = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    try {
        const data = await request('/register', 'POST', { email, password });
        showMessage(data.message || '注册成功，请登录', false);
        window.location.href='index.html';
    } catch (err) {
        showMessage(err.message, true);
    }
}

// ---------- 消息显示 ----------
function showMessage(msg, isError = false) {
    const box = document.getElementById('ErrorRegister');
    if (box) {
        box.textContent = msg;
        box.style.color = isError ? 'red' : 'green';
        box.style.display = 'block';
    }
}

// ---------- 通用请求 ----------
async function request(path, method = 'GET', body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(API_BASE + path, options);
    const data = await res.json();

    if (!res.ok) {
        throw new Error(data.error || `请求失败 (${res.status})`);
    }
    return data;
}