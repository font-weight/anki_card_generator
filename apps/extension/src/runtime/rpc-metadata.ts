/** Keep transport warnings out of enumerable application data and request payloads. */
const warningsKey=Symbol('english-reader-rpc-warnings');
export function attachRpcWarnings<T extends object>(data:T,warnings:readonly string[]):T{
 Object.defineProperty(data,warningsKey,{value:Object.freeze(warnings.filter(v=>typeof v==='string')),enumerable:false,configurable:false});return data;
}
export function getRpcWarnings(data:unknown):readonly string[]{
 if(!data||typeof data!=='object')return [];
 return (data as {[warningsKey]?:readonly string[]})[warningsKey]??[];
}
