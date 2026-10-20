import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
let create:ReturnType<typeof vi.fn>,send:ReturnType<typeof vi.fn>;
beforeEach(()=>{vi.resetModules();create=vi.fn().mockResolvedValue(undefined);send=vi.fn().mockResolvedValue({played:true});vi.stubGlobal('chrome',{offscreen:{hasDocument:vi.fn().mockResolvedValue(false),createDocument:create,Reason:{AUDIO_PLAYBACK:'AUDIO_PLAYBACK'}},runtime:{sendMessage:send}});});afterEach(()=>vi.unstubAllGlobals());
describe('offscreen playback orchestration',()=>{
 it('shares concurrent offscreen creation and forwards no secrets',async()=>{const {playLocal,playCached}=await import('../../apps/extension/src/runtime/playback');await Promise.all([playLocal('bank','en-US'),playCached('audio-1')]);expect(create).toHaveBeenCalledTimes(1);expect(create.mock.calls[0]![0]).toMatchObject({url:'offscreen.html',reasons:['AUDIO_PLAYBACK']});expect(send.mock.calls.map(c=>c[0])).toEqual([{target:'offscreen',kind:'local_speech',text:'bank',dialect:'en-US'},{target:'offscreen',kind:'cached_audio',audioId:'audio-1'}]);});
 it('does not forward a request if offscreen creation fails',async()=>{create.mockRejectedValue(new Error('no document'));const {playLocal}=await import('../../apps/extension/src/runtime/playback');await expect(playLocal('bank','en-US')).rejects.toThrow('no document');expect(send).not.toHaveBeenCalled();});
});
