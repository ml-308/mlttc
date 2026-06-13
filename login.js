let username,password;
let n=0;
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
function login_btn2(){
    for(let i=0;i<test_user.length;i++){
    if(test_user[i]==username && test_password[i]==password){
        login_success();
        n=1;
        break;
    }
}
if(n!=1){
    doucument.getElementsByClassName("error-msg").style.display="block";
}
}
function login_out(){
    document.getElementById("globalUserInfo").style.display="none";
    document.getElementById("globalDisplayName").innerHTML="";
    document.getElementById("globalLoginBtn").style.display="block";
    username="";
    password="";
}

function register_btn(){
    window.location.href="timetable.html";
}

test_user=["SFYLTLHRIL", 'PIJRHGEXGK','IUQBQEZDWK', 
    'DGIUTRQZYL', 'CIIQKBSLMV', 'MHVCWXBWST', 'SAGKKMDXIJ', 
    'NABTDJPMJB', 'GANEKZFYNM', 'JHSUCFHWAD',"1"]

test_password=['OVTXQPATPI', 'DMPHJBGZGW', 'TFRERWEZYS', 'VZEYYNUSYG', 
    'PUFBWSQGSQ', 'JDVNCUREPD', 'GAAFKAFAVH', 'EKVLKKQIUZ', 'QDLKRGXJNL', 
    'ICVYKITDBT',"1"]
