
let stat = true;
let value = 5;
let userinfo = "prasanth";
let Gender = "male";

if(stat){
    console.log("stat is true");
    if(value != 5){
        console.log("value is greater than 5");
        if(userinfo !== "prasanth"){
            console.log("userinfo is prasanth");
            if(Gender === "male"){
                console.log("Gender is male");
            }
            else{

            }
        }
        else{
            console.log("userinfo is not prasanth");
        }
    }
    else{
        console.log("value is not greater than 5");
    }
}

