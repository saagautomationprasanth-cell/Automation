
//let,var and const are used to declare variables in TypeScript, but they have different characteristics and use cases:

//1. let: 
//   - It is used to declare block-scoped variables.
//   - Variables declared with let can be reassigned new values.
//   - It is not hoisted to the top of the block, meaning you cannot access it before its declaration.  

//2. var:
//   - It is used to declare function-scoped variables.
//   - Variables declared with var can be reassigned new values.
//   It is hoisted to the top of the function, meaning you can access it before its declaration, but it will be undefined until the declaration is reached.


//3. const:
//   - It is used to declare block-scoped constants.


var street = "prasanth";
var street = "prasanth B";

console.log(street);

const city = "Bangalore";
//city = "Mumbai"; // This will result in an error because city is declared as a constant and cannot be reassigned.
const browser = "chrome";
console.log(city);