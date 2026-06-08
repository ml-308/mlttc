let username,pass,passin,password_in,yes_password;

function emailValidation(){
    username = document.getElementById("username").value;
    let t = username.indexOf("@");
    let e = username.lastIndexOf(".");

    if (t > 0 && e > 0 && t < e) {
        passget(username);
        if(pass!=null){
        document.getElementById("username").style.borderColor = "#1eff00";
        document.getElementById("usernameMsg").style.display = "block";
        document.getElementById("usernameMsg").style.color = "#1eff00";
        //document.getElementById("usernameMsg").innerHTML = username+"邮箱格式正确";
        }
        else{
        document.getElementById("username").style.borderColor = "#ffd20a";
        document.getElementById("usernameMsg").style.display = "block";
        document.getElementById("usernameMsg").style.color = "#ffd20a";
        //document.getElementById("usernameMsg").innerHTML = username+"邮箱合法，但您没有注册权限";
    }
    } 

    else {
        document.getElementById("username").style.borderColor = "#ff0000";
        document.getElementById("usernameMsg").style.display = "block";
        document.getElementById("usernameMsg").style.color = "#ff0000";
        document.getElementById("usernameMsg").innerHTML = username+"不是合法的邮箱";
    }
}


async function passget(username){
    const re=await fetch('/api/register-get?action=get&key='+encodeURIComponent(username)); // Use template literals to include the username in the URL
    const data=await re.json();
    if(re.ok){
      pass=data.value;
      document.getElementById('usernameMsg').innerHTML = pass;
    }
    else{
      pass=null;
      document.getElementById('usernameMsg').innerHTML = username+"邮箱没有注册";
    }
}