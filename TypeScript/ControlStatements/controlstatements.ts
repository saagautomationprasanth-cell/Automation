

//3 types of control statements in TypeScript
//decision making statements -> if, if else, nested if, switch
//looping statements -> for, while, do while
//jumping statements -> break, continue, return


let condition = false;
let number = 10;
let username = "prasanth";
let gender = "male";

console.log("with one condition");
if(condition){
    console.log("condition is true");
    console.log("username is " + username);
    console.log("number is " + number);
}
else{
    console.log("condition is false");
}

console.log("with one condition");

username = "Tharun";
console.log("updated username is " + username);

if(username === "prasanth" ||  gender === "male"){
    console.log("gender is male");
}
console.log("with and condition");
username = "prasanth";
if(username === "prasanth" &&  gender === "male"){
    console.log("gender is male");
}

/**
 *   condition1 AND   condition2   result
 *     true        true         true
 *     true        false        false
 *     false       true         false
 *     false       false        false
 */