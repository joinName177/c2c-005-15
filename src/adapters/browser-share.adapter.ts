import type { VoiceMeme } from '../core/models';
import type { DownloadAttempt, ShareFileKind, ShareOutcome, SharePort } from '../ports/share.port';
interface Dependencies { canShare(data: ShareData): boolean; share(data: ShareData): Promise<void>; download(blob: Blob, name: string): void }
const extension = (type: string, fallback: string) => type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : fallback;
const defaults = (): Dependencies => ({
  canShare: (data) => Boolean(navigator.canShare?.(data)), share: (data) => navigator.share(data),
  download: (blob, name) => { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url); },
});
const filesFor = (meme: VoiceMeme): { kind: ShareFileKind; file: File }[] => [
  { kind: 'audio', file: new File([meme.audio], `${meme.title}.${extension(meme.audio.type, 'webm')}`, { type: meme.audio.type }) },
  { kind: 'cover', file: new File([meme.cover], `${meme.title}.png`, { type: 'image/png' }) },
];
const isCancel = (cause: unknown) => (cause instanceof DOMException && cause.name === 'AbortError') || (typeof cause === 'object' && cause !== null && (cause as { name?: string }).name === 'AbortError');
const reason = (cause: unknown) => cause instanceof Error && cause.message ? cause.message : String(cause ?? '未知原因');
export class BrowserShareAdapter implements SharePort {
  constructor(private readonly deps: Dependencies = defaults()) {}
  async share(meme: VoiceMeme): Promise<ShareOutcome> {
    const files = filesFor(meme).map(({ file }) => file);
    let supported = false;
    try { supported = this.deps.canShare({ files }); } catch { supported = false; }
    if (!supported) return { kind: 'unavailable', downloads: this.downloadFiles(meme) };
    try { await this.deps.share({ title: meme.title, text: `声音表情包 · ${meme.emotion}`, files }); return { kind: 'shared' }; }
    catch (cause) {
      if (isCancel(cause)) return { kind: 'cancelled' }; // 取消：不下载、不上报成功
      return { kind: 'failed', reason: reason(cause) };  // 真实失败：保留原因，不擅自下载
    }
  }
  downloadFiles(meme: VoiceMeme, only?: ShareFileKind[]): DownloadAttempt[] {
    return filesFor(meme).filter(({ kind }) => !only || only.includes(kind)).map(({ kind, file }) => {
      try { this.deps.download(file, file.name); return { file: kind, name: file.name, started: true }; }
      catch (cause) { return { file: kind, name: file.name, started: false, error: reason(cause) }; }
    });
  }
}
