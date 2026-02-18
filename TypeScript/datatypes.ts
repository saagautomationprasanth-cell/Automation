
//array -> used to store multiple values in a single variable of same data type.

//keyword: variableName: dataType[] = [values];
let arr1: number[] = [1, 2, 3, 4, 5];

let array2:string[] = ["apple", "banana", "orange"];


//tuple -> used to store multiple values in a single variable of different data types.

//keyword: variableName: [dataType1,datatype2,...] = [values];
let user:[string, number] = ["",0];

//string,string,number,boolean

let user1:[string, string, number, boolean] = ["Prasanth", "Kumar", 10, true];

//any -> used to store any type of value. It is a way to opt-out of type checking for a variable.

let productprice: any = 19.99;

productprice = "Prasanth"; //no error
productprice = true; //no error
productprice = [1, 2, 3]; //no error


//void -> used to indicate that a function does not return a value. It is used for functions that perform an action but do not produce a result.




//enum -> used to define a set of named constants. It is a way to give more friendly names to sets of numeric values.


