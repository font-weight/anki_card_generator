// @vitest-environment node
import{afterEach,beforeEach,describe,expect,it,vi}from'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn(),pdfDestroy:vi.fn(),terminate:vi.fn(),construct:vi.fn()}));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs',()=>({PDFWorker:{create:mocks.create}}));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url',()=>({default:'/assets/pdf.worker.min-local.mjs'}));
import{createLocalPdfWorker,disposePdfLoading}from'../../apps/extension/src/readers/pdf-worker';
beforeEach(()=>{vi.clearAllMocks();mocks.pdfDestroy.mockReset();mocks.create.mockImplementation(()=>({destroy:mocks.pdfDestroy}));class NativeWorker{terminate=mocks.terminate;constructor(...args:unknown[]){mocks.construct(...args);}}vi.stubGlobal('Worker',NativeWorker);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('MV3 local PDF worker ownership',()=>{
 it('does not create native workers during module import',()=>expect(mocks.construct).not.toHaveBeenCalled());
 it('passes a local module worker port, avoiding automatic PDF.js blob wrappers',()=>{const owned=createLocalPdfWorker();expect(mocks.construct).toHaveBeenCalledWith('/assets/pdf.worker.min-local.mjs',{type:'module',name:'english-reader-pdf'});expect(mocks.create).toHaveBeenCalledWith({port:owned.port});owned.destroy();owned.destroy();expect(mocks.pdfDestroy).toHaveBeenCalledTimes(1);expect(mocks.terminate).toHaveBeenCalledTimes(1);});
 it('terminates native port if PDFWorker initialization throws',()=>{mocks.create.mockImplementation(()=>{throw new Error('failed');});expect(()=>createLocalPdfWorker()).toThrow('failed');expect(mocks.terminate).toHaveBeenCalledTimes(1);});
 it('terminates the native worker even if PDF.js destruction throws',()=>{mocks.pdfDestroy.mockImplementation(()=>{throw new Error('broken teardown');});const owned=createLocalPdfWorker();expect(()=>owned.destroy()).not.toThrow();expect(mocks.terminate).toHaveBeenCalledTimes(1);});
 it('cleans up PDF task before disposing owned worker',async()=>{const owned=createLocalPdfWorker();const destroy=vi.fn(async()=>{});disposePdfLoading({destroy},owned);await vi.waitFor(()=>expect(mocks.terminate).toHaveBeenCalledTimes(1));expect(destroy).toHaveBeenCalledTimes(1);});
 it('bounds cleanup even when a failed worker never acknowledges transport destruction',async()=>{vi.useFakeTimers();const owned=createLocalPdfWorker();disposePdfLoading({destroy:()=>new Promise<void>(()=>{})},owned);await vi.advanceTimersByTimeAsync(1000);expect(mocks.terminate).toHaveBeenCalledTimes(1);});
});
