import { describe, expect, it } from 'vitest';
import { useStudio, type StudioDependencies } from '../useStudio';
import { coverPresetFor } from '../../core/cover-presets';
import type { VoiceMeme } from '../../core/models';
import type { DownloadAttempt, ShareFileKind, ShareOutcome } from '../../ports/share.port';

function dependencies(overrides: Partial<StudioDependencies> = {}): StudioDependencies {
  const saved: VoiceMeme[] = [];
  return {
    recorder: { isRecording: false, start: async () => {}, stop: async () => new Blob(['voice'], { type: 'audio/webm' }) },
    analyzer: { analyze: async () => ({ duration: 2, features: { loudness:.75,dynamics:.55,pitch:.8,zeroCrossing:.62,pauseRatio:.12,tempoVariation:.6 } }) },
    cropper: { inspect: async () => ({duration:2,needsCrop:false}), crop: async (blob, range) => ({blob,duration:range.end-range.start}) },
    renderer: { render: async () => new Blob(['cover'], { type: 'image/png' }) },
    repository: { list: async()=>saved, save: async(m)=>{saved.push(m)}, rename:async()=>{}, delete:async()=>{} },
    share: { share: async () => ({ kind: 'shared' }), downloadFiles: () => [] },
    ...overrides,
  };
}

const meme = (id: string, title: string): VoiceMeme => ({ id, title, emotion: '元气满满', confidence: .8, features: { loudness:.7,dynamics:.5,pitch:.8,zeroCrossing:.6,pauseRatio:.1,tempoVariation:.6 }, audio: new Blob(['a'], { type: 'audio/webm' }), duration: 1, cover: new Blob(['p'], { type: 'image/png' }), coverConfig: coverPresetFor('元气满满'), createdAt: '2026-10-05' });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

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

describe('useStudio 分享', () => {
  it('取消不下载也不报成功，之后可重新分享', async () => {
    const outcomes: ShareOutcome[] = [{ kind: 'cancelled' }, { kind: 'shared' }];
    const downloads: unknown[] = [];
    const studio = useStudio(dependencies({ share: { share: async () => outcomes.shift()!, downloadFiles: () => { downloads.push(1); return []; } } }));
    await studio.shareMeme(meme('a', '第一件'));
    expect(studio.notice.value).toContain('已取消分享'); expect(studio.notice.value).not.toContain('已打开');
    expect(studio.error.value).toBe(''); expect(downloads).toEqual([]); expect(studio.sharing.value).toBeNull();
    await studio.shareMeme(meme('a', '第一件')); // 取消后的重新分享是新意图，不能被吞
    expect(studio.notice.value).toContain('已打开系统分享《第一件》');
  });
  it('分享进行中重复点击同一件会合并，只发起一次系统分享', async () => {
    const pending = deferred<ShareOutcome>(); let calls = 0;
    const studio = useStudio(dependencies({ share: { share: async () => { calls++; return pending.promise; }, downloadFiles: () => [] } }));
    const first = studio.shareMeme(meme('a', '第一件'));
    await studio.shareMeme(meme('a', '第一件'));
    expect(calls).toBe(1); expect(studio.notice.value).toContain('正在分享《第一件》');
    pending.resolve({ kind: 'shared' }); await first;
    expect(studio.notice.value).toContain('已打开系统分享《第一件》'); expect(studio.sharing.value).toBeNull();
  });
  it('分享进行中点击另一件会被明确拒绝，旧结果晚到也不串件', async () => {
    const pending = deferred<ShareOutcome>(); const shared: string[] = []; const downloads: string[] = [];
    const studio = useStudio(dependencies({ share: {
      share: async (m) => { shared.push(m.id); return pending.promise; },
      downloadFiles: (m) => { downloads.push(m.id); return []; },
    } }));
    const first = studio.shareMeme(meme('a', '第一件'));
    await studio.shareMeme(meme('b', '第二件')); // 新意图：拒绝而不是排队或静默吞掉
    expect(shared).toEqual(['a']); expect(studio.notice.value).toContain('完成后再分享《第二件》');
    pending.resolve({ kind: 'unavailable', downloads: [{ file: 'audio', name: '第一件.webm', started: true }, { file: 'cover', name: '第一件.png', started: true }] });
    await first; // 旧结果晚到：提示与下载仍属于第一件，不串到第二件
    expect(studio.notice.value).toContain('《第一件》'); expect(studio.notice.value).not.toContain('《第二件》');
    expect(shared).toEqual(['a']); expect(downloads).toEqual([]);
  });
  it('真实失败保留原因，由用户决定改为下载', async () => {
    const downloaded: { id: string; only?: ShareFileKind[] }[] = [];
    const studio = useStudio(dependencies({ share: {
      share: async () => ({ kind: 'failed', reason: '网络中断' }),
      downloadFiles: (m, only) => { downloaded.push({ id: m.id, only }); return [{ file: 'audio', name: 'x.webm', started: true }, { file: 'cover', name: 'x.png', started: true }]; },
    } }));
    await studio.shareMeme(meme('a', '第一件'));
    expect(studio.error.value).toContain('网络中断'); expect(studio.error.value).not.toContain('不支持');
    expect(downloaded).toEqual([]); expect(studio.shareFallback.value?.id).toBe('a');
    studio.downloadInstead();
    expect(downloaded).toEqual([{ id: 'a', only: undefined }]); expect(studio.error.value).toBe('');
    expect(studio.notice.value).toContain('已开始下载'); expect(studio.notice.value).not.toContain('已保存');
  });
  it('不可用兜底时单份发起失败只重试该份，已发起不称已落盘', async () => {
    const attempts: DownloadAttempt[] = [{ file: 'audio', name: '第一件.webm', started: true }, { file: 'cover', name: '第一件.png', started: false, error: '弹窗被拦截' }];
    const retries: { id: string; only?: ShareFileKind[] }[] = [];
    const studio = useStudio(dependencies({ share: {
      share: async () => ({ kind: 'unavailable', downloads: attempts }),
      downloadFiles: (m, only) => { retries.push({ id: m.id, only }); return [{ file: 'cover', name: '第一件.png', started: true }]; },
    } }));
    await studio.shareMeme(meme('a', '第一件'));
    expect(studio.notice.value).toContain('已开始下载'); expect(studio.notice.value).not.toContain('已保存');
    expect(studio.notice.value).toContain('弹窗被拦截'); expect(studio.failedDownload.value).toEqual({ meme: expect.objectContaining({ id: 'a' }), files: ['cover'] });
    studio.retryFailedDownload();
    expect(retries).toEqual([{ id: 'a', only: ['cover'] }]); // 只重试封面，不重复发起音频
    expect(studio.failedDownload.value).toBeNull(); expect(studio.notice.value).toContain('第一件.png');
  });
});
