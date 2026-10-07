import { reactive, ref } from 'vue';
import { classifyEmotion } from '../core/emotion-engine';
import { coverPresetFor } from '../core/cover-presets';
import type { AudioFeatures, CoverConfig, EmotionLabel, EmotionResult, StudioStage, VoiceMeme } from '../core/models';
import type { RecorderPort } from '../ports/recorder.port';
import type { AudioAnalyzerPort } from '../ports/audio-analyzer.port';
import type { AudioCropperPort } from '../ports/audio-cropper.port';
import type { CoverRendererPort } from '../ports/cover-renderer.port';
import type { MemeRepository } from '../ports/meme-repository.port';
import type { SharePort } from '../ports/share.port';

export interface StudioDependencies { recorder: RecorderPort; analyzer: AudioAnalyzerPort; cropper: AudioCropperPort; renderer: CoverRendererPort; repository: MemeRepository; share: SharePort }
export function useStudio(deps: StudioDependencies) {
  const stage = ref<StudioStage>('record'); const error = ref(''); const notice = ref(''); const level = ref(0);
  const draft = reactive<{ id?: string; title: string; audio?: Blob; duration: number; cropStart: number; cropEnd: number }>({ title: '我的声音表情', duration: 0, cropStart: 0, cropEnd: 0 });
  const emotion = ref<EmotionResult>(); const features = ref<AudioFeatures>(); const cover = ref<CoverConfig>(coverPresetFor('元气满满')); const collection = ref<VoiceMeme[]>([]);

  // 分享流程状态：sharing/shareTarget 是在途闸门，shareTicket 识别晚到的旧结果，
  // shareFallback 记录“真实失败后待用户决定”或“部分文件下载失败待重试”的作品。
  const sharing = ref(false); const shareTarget = ref<{ id: string; title: string }>();
  const shareFallback = ref<{ meme: VoiceMeme; failedFiles?: string[] }>();
  let shareTicket = 0;

  async function startRecording() { error.value = ''; try { await deps.recorder.start((value) => { level.value = value; }); notice.value = '正在录音，最长 10 秒'; } catch { error.value = '无法使用麦克风权限，请在浏览器设置中允许访问或导入音频。'; } }
  async function stopRecording() { try { draft.audio = await deps.recorder.stop(); const info = await deps.cropper.inspect(draft.audio); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; notice.value = info.needsCrop ? '音频超过 10 秒，请选择保留片段' : '录音完成，可以试听并分析'; } catch (cause) { error.value = cause instanceof Error ? cause.message : '录音结束失败'; } }
  async function importAudio(blob: Blob) { draft.audio = blob; const info = await deps.cropper.inspect(blob); draft.duration = info.duration; draft.cropStart = 0; draft.cropEnd = Math.min(10, info.duration); stage.value = 'crop'; }
  async function analyze() { if (!draft.audio) { error.value = '请先录制或导入一段声音'; return; } const cropped = await deps.cropper.crop(draft.audio, { start: draft.cropStart, end: draft.cropEnd }); draft.audio = cropped.blob; draft.duration = cropped.duration; const result = await deps.analyzer.analyze(cropped.blob); features.value = result.features; emotion.value = classifyEmotion(result.features); cover.value = coverPresetFor(emotion.value.label); stage.value = 'emotion'; }
  function selectEmotion(label: EmotionLabel) { const current = emotion.value ?? classifyEmotion({ loudness:0,dynamics:0,pitch:0,zeroCrossing:0,pauseRatio:1,tempoVariation:0 }); emotion.value = { ...current, label, explanation: `已手动选择「${label}」标签。` }; cover.value = { ...coverPresetFor(label), title: cover.value.title || label }; }
  function goCover() { stage.value = 'cover'; }
  async function save(target?: HTMLCanvasElement) { if (!draft.audio || !emotion.value || !features.value) { error.value = '作品信息尚未完整，请先完成声音分析'; return; } try { const coverBlob = await deps.renderer.render(cover.value, target); const meme: VoiceMeme = { id: draft.id ?? `meme-${Date.now()}`, title: draft.title.trim() || '未命名声音', emotion: emotion.value.label, confidence: emotion.value.confidence, features: features.value, audio: draft.audio, duration: draft.duration, cover: coverBlob, coverConfig: { ...cover.value }, createdAt: new Date().toISOString() }; await deps.repository.save(meme); await loadCollection(); stage.value = 'collection'; notice.value = '作品已保存到本地'; } catch { error.value = '保存失败，本次编辑内容仍保留，请检查浏览器存储空间。'; } }
  async function loadCollection() { collection.value = (await deps.repository.list()).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  function editMeme(meme: VoiceMeme) { Object.assign(draft, { id:meme.id,title:meme.title,audio:meme.audio,duration:meme.duration,cropStart:0,cropEnd:meme.duration }); features.value = meme.features; emotion.value = { label:meme.emotion,confidence:meme.confidence,explanation:'编辑已保存作品',scores:{'暴躁老哥':0,'温柔姐姐':0,'阴阳怪气':0,'元气满满':0} }; cover.value = { ...meme.coverConfig }; stage.value = 'cover'; }
  async function deleteMeme(id: string) { await deps.repository.delete(id); if (shareFallback.value?.meme.id === id) shareFallback.value = undefined; await loadCollection(); }

  function beginShare(meme: VoiceMeme): number | undefined {
    // 同一件作品的在途分享：视为同一次操作的重复点击（连点/重试），直接忽略，不重复调起系统面板。
    if (sharing.value && shareTarget.value?.id === meme.id) return undefined;
    // 另一件作品的在途分享：这是新的分享意图。选择“拒绝”而非排队或合并——系统分享面板
    // 同时只能有一个，排队会让面板脱离用户操作上下文弹出，合并会把两件作品的文件混在一起。
    if (sharing.value) { notice.value = `正在分享《${shareTarget.value?.title}》，完成后再分享《${meme.title}》`; return undefined; }
    const ticket = ++shareTicket;
    sharing.value = true; shareTarget.value = { id: meme.id, title: meme.title };
    shareFallback.value = undefined; // 新意图生效，作废旧作品遗留的待决下载，避免文件串到另一件作品
    error.value = ''; notice.value = '';
    return ticket;
  }
  function endShare(ticket: number) { if (ticket === shareTicket) { sharing.value = false; shareTarget.value = undefined; } }
  const isCurrent = (ticket: number) => ticket === shareTicket; // 旧结果晚到：已有更新的分享意图，丢弃它

  async function runDownload(meme: VoiceMeme, ticket: number, prefix: string, only?: string[]) {
    const report = await deps.share.download(meme, only);
    if (!isCurrent(ticket)) return; // 晚到的下载结果不覆盖新意图的提示
    const describe = (files: { name: string; reason: string }[]) => files.map((f) => `${f.name}（${f.reason}）`).join('、');
    if (!report.failed.length) {
      notice.value = `${prefix}已发起下载：${report.initiated.join('、')}。是否保存成功请以浏览器下载记录为准。`;
      error.value = ''; shareFallback.value = undefined;
    } else {
      // 只把发起失败的文件交给用户重试；已发起的不得宣称已落盘
      const done = report.initiated.length ? `；${report.initiated.join('、')} 已发起下载` : '';
      error.value = `${prefix}${describe(report.failed)} 下载发起失败${done}。`;
      notice.value = ''; shareFallback.value = { meme, failedFiles: report.failed.map((f) => f.name) };
    }
  }

  async function shareMeme(meme: VoiceMeme) {
    const ticket = beginShare(meme);
    if (ticket === undefined) return;
    try {
      const outcome = await deps.share.share(meme);
      if (!isCurrent(ticket)) return;
      if (outcome.kind === 'shared') { notice.value = `《${meme.title}》分享成功`; return; }
      if (outcome.kind === 'cancelled') { notice.value = `已取消《${meme.title}》的分享`; return; } // 取消：不下载、不报成功
      if (outcome.kind === 'unavailable') { await runDownload(meme, ticket, `当前浏览器不支持文件分享，`); return; } // 确实不可用：回退下载
      error.value = `《${meme.title}》分享失败：${outcome.reason}`; // 真实失败：保留原因，不自动下载
      shareFallback.value = { meme }; // 由用户决定下一步（重试分享或改为下载）
    } finally { endShare(ticket); }
  }

  async function downloadFallback() {
    const pending = shareFallback.value;
    if (!pending || sharing.value) return;
    const ticket = ++shareTicket;
    sharing.value = true; shareTarget.value = { id: pending.meme.id, title: pending.meme.title };
    error.value = ''; notice.value = '';
    try { await runDownload(pending.meme, ticket, '', pending.failedFiles); } // 只重试失败的文件；未指定则两份都下载
    finally { endShare(ticket); }
  }

  function newRecording() { draft.id = undefined; draft.title = '我的声音表情'; draft.audio = undefined; emotion.value = undefined; features.value = undefined; stage.value = 'record'; error.value = ''; shareFallback.value = undefined; }
  return { stage,error,notice,level,draft,emotion,features,cover,collection,sharing,shareFallback,startRecording,stopRecording,importAudio,analyze,selectEmotion,goCover,save,loadCollection,editMeme,deleteMeme,shareMeme,downloadFallback,newRecording };
}
