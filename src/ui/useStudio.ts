import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { DownloadAttempt, ShareFileKind, SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { draft.audio = await deps.recorder.stop(); const info = await deps.cropper.inspect(draft.audio); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { draft.audio = blob; const info = await deps.cropper.inspect(blob); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; }
  async function analyze() { if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; } const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd }); draft.audio = cropped.blob; draft.duration = cropped.duration; const result = await deps.analyzer.analyze(cropped.blob); features.value = result.features; emotion.value = classifyEmotion(result.features); cover.value = coverPresetFor(emotion.value.label); stage.value = 'emotion'; }
  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) { if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; } try { const coverBlob = await deps.renderer.render(cover.value, target); const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() }; await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地'; } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; } }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration }); features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); await loadCollection(); }
  // 分享并发策略：系统分享同一时间只能进行一次（浏览器规范亦如此）。
  // 进行中再点【同一件】= 同次意图的重试 → 合并（忽略，不再开第二个面板）；
  // 点【另一件】= 新的分享意图 → 明确拒绝并提示，不排队（排队会丢失用户手势激活，必然失败）、不静默吞掉。
  const sharing = ref<{ id: string; title: string } | null>(null); let shareTicket = 0;
  const failedDownload = ref<{ meme: VoiceMeme; files: ShareFileKind[] } | null>(null); // 发起失败的文件，可单独重试
  const shareFallback = ref<VoiceMeme | null>(null); // 分享真实失败的作品，用户可决定改为下载
  function applyDownloads(meme: VoiceMeme, attempts: DownloadAttempt[], prefix: string) {
    const failed = attempts.filter(a => !a.started); const started = attempts.filter(a => a.started);
    failedDownload.value = failed.length ? { meme, files: failed.map(f => f.file) } : null;
    const parts = [`《${meme.title}》`];
    if (started.length) parts.push(`${started.map(a => a.name).join('、')}已开始下载（下载已发起，是否落盘以浏览器为准）`);
    if (failed.length) parts.push(`${failed.map(a => `${a.name}（${a.error}）`).join('、')}未能发起下载，可重试`);
    notice.value = `${prefix}${parts.join('：')}`;
  }
  async function shareMeme(meme: VoiceMeme) {
    if (sharing.value) { notice.value = sharing.value.id === meme.id ? `正在分享《${sharing.value.title}》，请稍候` : `正在分享《${sharing.value.title}》，完成后再分享《${meme.title}》`; return; }
    const ticket = ++shareTicket; sharing.value = { id: meme.id, title: meme.title };
    error.value = ''; failedDownload.value = null; shareFallback.value = null;
    try {
      const outcome = await deps.share.share(meme);
      if (ticket !== shareTicket) return; // 旧结果晚到：已有更新的分享意图，丢弃，避免提示/文件串到另一件作品
      if (outcome.kind === 'shared') notice.value = `已打开系统分享《${meme.title}》`;
      else if (outcome.kind === 'cancelled') notice.value = `已取消分享《${meme.title}》，未下载任何文件`;
      else if (outcome.kind === 'unavailable') applyDownloads(meme, outcome.downloads, '浏览器不支持系统文件分享，已改为下载');
      else { shareFallback.value = meme; error.value = `分享《${meme.title}》失败：${outcome.reason}。可重试分享，或改为下载音频和封面。`; }
    } catch (cause) { if (ticket === shareTicket) { shareFallback.value = meme; error.value = `分享《${meme.title}》失败：${cause instanceof Error && cause.message ? cause.message : '未知原因'}。可重试分享，或改为下载音频和封面。`; } }
    finally { if (ticket === shareTicket) sharing.value = null; }
  }
  function retryFailedDownload() { const pending = failedDownload.value; if (!pending) return; applyDownloads(pending.meme, deps.share.downloadFiles(pending.meme, pending.files), '已重试下载'); }
  function downloadInstead() { const meme = shareFallback.value; if (!meme) return; shareFallback.value = null; error.value = ''; applyDownloads(meme, deps.share.downloadFiles(meme), '已改为下载'); }
  function newRecording() { draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; emotion.value = undefined; features.value = undefined; stage.value = 'record'; error.value = ''; }
  return { stage,error,notice,level,draft,emotion,features,cover,collection,sharing,failedDownload,shareFallback,startRecording,stopRecording,importAudio,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,retryFailedDownload,downloadInstead,newRecording };
}
