export type Schema = {type?:'object'|'string'|'number'|'integer'|'boolean'|'null'|'array';properties?:Record<string,Schema>;required?:string[];additionalProperties?:false;items?:Schema;minItems?:number;maxItems?:number;minLength?:number;maxLength?:number;minimum?:number;maximum?:number;enum?:readonly unknown[];anyOf?:Schema[];format?:'uuid'|'url'|'date-time';pattern?:string};
export class ContractValidationError extends Error {readonly code='INVALID_INPUT';constructor(message='Invalid contract value'){super(message);this.name='ContractValidationError';}}
function invalid(path:string):never {throw new ContractValidationError(`Invalid field: ${path}`);}
export function validateSchema(schema:Schema,value:unknown,path='$'):void {
 if(schema.anyOf){if(!schema.anyOf.some(s=>{try{validateSchema(s,value,path);return true;}catch{return false;}}))invalid(path);return;}
 if(schema.enum&&!schema.enum.includes(value))invalid(path);
 if(!schema.type)return;
 if(schema.type==='null'){if(value!==null)invalid(path);return;}
 if(schema.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)invalid(path);
  const record=value as Record<string,unknown>;
  for(const key of schema.required??[])if(!Object.hasOwn(record,key))invalid(`${path}.${key}`);
  for(const key of Object.keys(record)){const field=schema.properties&&Object.hasOwn(schema.properties,key)?schema.properties[key]:undefined;if(!field)invalid(`${path}.${key}`);validateSchema(field,record[key],`${path}.${key}`);}return;
 }
 if((schema.type as string)==='array'){if(!Array.isArray(value))invalid(path);const a=value as unknown[];if(a.length<(schema.minItems??0)||a.length>(schema.maxItems??Infinity))invalid(path);a.forEach((v,i)=>validateSchema(schema.items!,v,`${path}[${i}]`));return;}
 if(schema.type==='string'){
  if(typeof value!=='string')invalid(path);const s=value as string;if(s.length<(schema.minLength??0)||s.length>(schema.maxLength??Infinity)||schema.pattern&&!new RegExp(schema.pattern,'u').test(s))invalid(path);
  if(schema.format==='uuid'&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s))invalid(path);
  if(schema.format==='date-time'&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s)||!Number.isFinite(Date.parse(s))))invalid(path);
  if(schema.format==='url'){let u:URL;try{u=new URL(s);}catch{invalid(path);}if(!['http:','https:'].includes(u!.protocol)||u!.username||u!.password)invalid(path);}return;
 }
 if(schema.type==='boolean'){if(typeof value!=='boolean')invalid(path);return;}
 if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isSafeInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))invalid(path);
}
