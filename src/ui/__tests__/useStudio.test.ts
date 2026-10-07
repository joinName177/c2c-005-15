import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceMeme } from '../../core/models';
import type { DownloadReport, ShareOutcome } from '../../ports/share.port';

function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => ({ kind: 'shared' }), download: async () => ({ initiated: [], failed: [] }) },
    ...overrides,
  };
}

const meme = (id: string, title: string): VoiceMeme => ({ id, title, emotion: '元气满满', confidence: .8, features: { loudness:.7,dynamics:.5,pitch:.8,zeroCrossing:.6,pauseRatio:.1,tempoVariation:.6 }, audio: new Blob(['a'], { type: 'audio/webm' }), duration: 1, cover: new Blob(['c'], { type: 'image/png' }), coverConfig: coverPresetFor('元气满满'), createdAt: '2026-10-05' });

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause?: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

describe('useStudio', () => {
  it('turns microphone denial into a recoverable error', async () => {
    const studio = useStudio(dependencies({ recorder: { isRecording:false, start:async()=>{throw new DOMException('denied','NotAllowedError')}, stop:async()=>new Blob() } }));
    await studio.startRecording();
    expect(studio.error.value).toContain('麦克风权限');
    expect(studio.stage.value).toBe('record');
  });
  it('moves recording through crop and emotion with manual override', async () => {
    const studio = useStudio(dependencies()); await studio.startRecording(); await studio.stopRecording();
    expect(studio.stage.value).toBe('crop'); await studio.analyze(); expect(studio.emotion.value?.label).toBe('元气满满');
    studio.selectEmotion('温柔姐姐'); expect(studio.cover.value.label).toBe('温柔姐姐'); expect(studio.stage.value).toBe('emotion');
  });
  it('keeps the draft when saving fails and can edit an existing work', async () => {
    const studio = useStudio(dependencies({ repository: { list:async()=>[], save:async()=>{throw new DOMException('full','QuotaExceededError')}, rename:async()=>{}, delete:async()=>{} } }));
    studio.draft.audio = new Blob(['a']); studio.draft.duration = 1; studio.cover.value = coverPresetFor('温柔姐姐'); studio.emotion.value = { label:'温柔姐姐',confidence:.8,explanation:'柔和',scores:{'暴躁老哥':0,'温柔姐姐':1,'阴阳怪气':0,'元气满满':0} };
    studio.features.value = { loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2 };
    await studio.save(); expect(studio.error.value).toContain('保存失败'); expect(studio.draft.audio?.size).toBe(1);
    const existing = { id:'old',title:'旧作品',emotion:'温柔姐姐' as const,confidence:.8,features:{loudness:.2,dynamics:.2,pitch:.4,zeroCrossing:.2,pauseRatio:.3,tempoVariation:.2},audio:new Blob(['a']),duration:1,cover:new Blob(['c']),coverConfig:coverPresetFor('温柔姐姐'),createdAt:'2026-10-05' };
    studio.editMeme(existing); expect(studio.draft.title).toBe('旧作品'); expect(studio.stage.value).toBe('cover');
  });
});

describe('useStudio 分享流程', () => {
  it('取消系统分享：不下载、不报成功', async () => {
    let downloads = 0;
    const studio = useStudio(dependencies({ share: { share: async (): Promise<ShareOutcome> => ({ kind: 'cancelled' }), download: async () => { downloads += 1; return { initiated: [], failed: [] }; } } }));
    await studio.shareMeme(meme('m1', '笑声'));
    expect(studio.notice.value).toBe('已取消《笑声》的分享');
    expect(studio.error.value).toBe('');
    expect(downloads).toBe(0);
    expect(studio.sharing.value).toBe(false);
  });
  it('确实不支持时才回退下载，且只声称已发起而非已落盘', async () => {
    const studio = useStudio(dependencies({ share: { share: async (): Promise<ShareOutcome> => ({ kind: 'unavailable' }), download: async (): Promise<DownloadReport> => ({ initiated: ['笑声.webm', '笑声.png'], failed: [] }) } }));
    await studio.shareMeme(meme('m1', '笑声'));
    expect(studio.notice.value).toContain('不支持文件分享');
    expect(studio.notice.value).toContain('已发起下载');
    expect(studio.notice.value).not.toContain('已保存');
    expect(studio.error.value).toBe('');
  });
  it('真实失败保留原因、不自动下载，由用户决定改为下载', async () => {
    const calls: { meme: VoiceMeme; only?: readonly string[] }[] = [];
    const studio = useStudio(dependencies({ share: {
      share: async (): Promise<ShareOutcome> => ({ kind: 'failed', reason: 'share already in progress' }),
      download: async (m, only) => { calls.push({ meme: m, only }); return { initiated: ['笑声.webm', '笑声.png'], failed: [] }; },
    } }));
    const work = meme('m1', '笑声');
    await studio.shareMeme(work);
    expect(studio.error.value).toContain('share already in progress');
    expect(studio.error.value).toContain('《笑声》');
    expect(calls).toHaveLength(0); // 失败不自动下载
    expect(studio.shareFallback.value?.meme.id).toBe('m1');
    await studio.downloadFallback();
    expect(calls).toEqual([{ meme: work, only: undefined }]);
    expect(studio.error.value).toBe('');
    expect(studio.notice.value).toContain('已发起下载');
    expect(studio.shareFallback.value).toBeUndefined();
  });
  it('两份文件分别发起，某份失败只重试该份', async () => {
    const retries: (readonly string[] | undefined)[] = [];
    const report: DownloadReport = { initiated: ['笑声.webm'], failed: [{ name: '笑声.png', reason: 'popup blocked' }] };
    const studio = useStudio(dependencies({ share: {
      share: async (): Promise<ShareOutcome> => ({ kind: 'unavailable' }),
      download: async (_m, only) => { if (only) { retries.push(only); return { initiated: [...only], failed: [] }; } return report; },
    } }));
    await studio.shareMeme(meme('m1', '笑声'));
    expect(studio.error.value).toContain('笑声.png');
    expect(studio.error.value).toContain('popup blocked');
    expect(studio.error.value).toContain('笑声.webm 已发起下载');
    expect(studio.shareFallback.value?.failedFiles).toEqual(['笑声.png']);
    await studio.downloadFallback();
    expect(retries).toEqual([['笑声.png']]); // 只重试失败的那份
    expect(studio.error.value).toBe('');
    expect(studio.shareFallback.value).toBeUndefined();
  });
  it('分享在途时连点同一件作品：视为同次重试，只调起一次', async () => {
    const gate = deferred<ShareOutcome>(); let shares = 0;
    const studio = useStudio(dependencies({ share: { share: async () => { shares += 1; return gate.promise; }, download: async () => ({ initiated: [], failed: [] }) } }));
    const work = meme('m1', '笑声');
    const first = studio.shareMeme(work); void studio.shareMeme(work); void studio.shareMeme(work);
    expect(shares).toBe(1);
    gate.resolve({ kind: 'shared' }); await first;
    expect(studio.notice.value).toBe('《笑声》分享成功');
  });
  it('分享在途时点击其他作品：拒绝并说明，不排队不合并', async () => {
    const gate = deferred<ShareOutcome>(); let shares = 0;
    const studio = useStudio(dependencies({ share: { share: async () => { shares += 1; return gate.promise; }, download: async () => ({ initiated: [], failed: [] }) } }));
    const first = studio.shareMeme(meme('m1', '笑声'));
    await studio.shareMeme(meme('m2', '哭声'));
    expect(shares).toBe(1);
    expect(studio.notice.value).toBe('正在分享《笑声》，完成后再分享《哭声》');
    gate.resolve({ kind: 'shared' }); await first;
    expect(studio.notice.value).toBe('《笑声》分享成功');
    await studio.shareMeme(meme('m2', '哭声')); // 在途结束后，新的分享不被误吞
    expect(shares).toBe(2);
    expect(studio.notice.value).toBe('《哭声》分享成功');
  });
  it('取消后重新分享：新的分享正常发起', async () => {
    const outcomes: ShareOutcome[] = [{ kind: 'cancelled' }, { kind: 'shared' }]; let shares = 0;
    const studio = useStudio(dependencies({ share: { share: async () => outcomes[shares++], download: async () => ({ initiated: [], failed: [] }) } }));
    const work = meme('m1', '笑声');
    await studio.shareMeme(work);
    expect(studio.notice.value).toBe('已取消《笑声》的分享');
    await studio.shareMeme(work);
    expect(shares).toBe(2);
    expect(studio.notice.value).toBe('《笑声》分享成功');
  });
  it('旧结果晚到不覆盖新意图，文件与提示不串到另一件作品', async () => {
    const gate = deferred<ShareOutcome>();
    const downloaded: VoiceMeme[] = [];
    const studio = useStudio(dependencies({ share: {
      share: async () => gate.promise,
      download: async (m) => { downloaded.push(m); return { initiated: [`${m.title}.webm`, `${m.title}.png`], failed: [] }; },
    } }));
    const first = studio.shareMeme(meme('m1', '笑声'));
    await studio.shareMeme(meme('m2', '哭声')); // 被拒绝，不产生新意图
    gate.resolve({ kind: 'cancelled' }); await first; // 旧结果晚到：只影响它自己的提示
    expect(studio.notice.value).toBe('已取消《笑声》的分享');
    expect(downloaded).toHaveLength(0); // 取消不触发下载
    const second = deferred<ShareOutcome>();
    let calls = 0;
    const studio2 = useStudio(dependencies({ share: {
      share: async () => { calls += 1; return calls === 1 ? { kind: 'failed', reason: 'denied' } : second.promise; },
      download: async (m) => { downloaded.push(m); return { initiated: [`${m.title}.webm`], failed: [] }; },
    } }));
    await studio2.shareMeme(meme('m1', '笑声')); // 失败，留下 m1 的待决下载
    expect(studio2.shareFallback.value?.meme.title).toBe('笑声');
    const pending = studio2.shareMeme(meme('m2', '哭声')); // 新意图生效，作废 m1 的待决下载
    second.resolve({ kind: 'unavailable' }); await pending;
    expect(studio2.shareFallback.value).toBeUndefined();
    expect(downloaded.pop()?.title).toBe('哭声'); // 下载的是哭声的文件，没有串到笑声
    expect(studio2.notice.value).toContain('已发起下载：哭声.webm');
  });
});
