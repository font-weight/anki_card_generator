import {validateGrammarDraft} from '../../contracts/src/grammar.ts';
import type {GrammarAddPayload,GrammarDraft} from '../../contracts/src/grammar.ts';
import type {ReaderStorage} from '../../storage/src/index.ts';
import {canonicalJson,sha256} from '../../note-templates/src/index.ts';
import {grammarSemanticKeys} from '../../note-templates/src/grammar.ts';
import type {GrammarModelName} from '../../note-templates/src/grammar.ts';
import {AnkiError} from './anki.ts';
import {ServiceError} from './errors.ts';

type Result={operationId:string;status:'added'|'already_added';noteId:number};
type Record={version:1;fingerprint:string;state:'pending'|'retryable'|'added';noteId:number|null};
type Keys={lexemeKey:string;contentKey:string};
export interface GrammarAnkiAdapter {
 assertGrammarReady(draft:GrammarDraft):Promise<GrammarModelName>;
 findGrammarOperation(operationId:string,keys:Keys):Promise<number|null>;
 addGrammarNote(operationId:string,draft:GrammarDraft,keys:Keys,modelName:GrammarModelName):Promise<number>;
}
/** Grammar has no automatic queue or retries. A persisted intent prevents an
 * uncertain add from being blindly repeated after popup or worker recreation. */
export class GrammarSaveCoordinator {
 #storage:Pick<ReaderStorage,'getMetadata'|'setMetadata'>;
 #anki:()=>GrammarAnkiAdapter;
 #tail:Promise<unknown>=Promise.resolve();
 constructor(storage:Pick<ReaderStorage,'getMetadata'|'setMetadata'>,anki:()=>GrammarAnkiAdapter){this.#storage=storage;this.#anki=anki;}
 add(payload:GrammarAddPayload):Promise<Result>{
  const snapshot=structuredClone(payload);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshot.operationId))return Promise.reject(new ServiceError('INVALID_INPUT'));
  validateGrammarDraft(snapshot.draft);
  const work=this.#tail.then(()=>this.#execute(snapshot));this.#tail=work.catch(()=>{});return work;
 }
 async #execute({operationId,draft}:GrammarAddPayload):Promise<Result>{
  const fingerprint=await sha256(canonicalJson(draft)),name=`grammar-operation:${operationId}`;
  const previous=await this.#storage.getMetadata<Record>(name);
  if(previous&&(!['pending','retryable','added'].includes(previous.state)||previous.version!==1||previous.fingerprint!==fingerprint||previous.state==='added'&&(!Number.isSafeInteger(previous.noteId)||previous.noteId!<=0)))throw new ServiceError('OPERATION_CONFLICT');
  if(previous?.state==='added')return {operationId,status:'already_added',noteId:previous.noteId!};
  const client=this.#anki(),keys=await grammarSemanticKeys(draft);
  const existing=await client.findGrammarOperation(operationId,keys);
  if(existing!==null){await this.#storage.setMetadata(name,{version:1,fingerprint,state:'added',noteId:existing} satisfies Record);return {operationId,status:'already_added',noteId:existing};}
  if(previous?.state==='pending')throw new ServiceError('OPERATION_CONFLICT','Предыдущее добавление грамматики не подтверждено. Проверьте Anki; автоматическая повторная отправка отключена.');
  const modelName=await client.assertGrammarReady(draft);
  await this.#storage.setMetadata(name,{version:1,fingerprint,state:'pending',noteId:null} satisfies Record);
  let noteId:number;
  try{noteId=await client.addGrammarNote(operationId,draft,keys,modelName);}
  catch(error){
   if(error instanceof AnkiError&&!error.uncertain)await this.#storage.setMetadata(name,{version:1,fingerprint,state:'retryable',noteId:null} satisfies Record);
   throw error;
  }
  await this.#storage.setMetadata(name,{version:1,fingerprint,state:'added',noteId} satisfies Record);
  return {operationId,status:'added',noteId};
 }
}
