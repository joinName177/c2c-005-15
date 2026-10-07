import type { VoiceMeme } from '../core/models';
import type { DownloadReport, ShareOutcome, SharePort } from '../ports/share.port';

interface Dependencies { canShare(data: ShareData): boolean; share(data: ShareData): Promise<void>; download(blob: Blob, name: string): void }

const extension = (type: string, fallback: string) => type.includes('wav') ? 'wav' : type.includes('mpeg') ? 'mp3' : fallback;

/** 用户取消系统分享面板时浏览器抛出 AbortError，这只是取消，不是失败。 */
const isCancellation = (cause: unknown) => nameOf(cause) === 'AbortError';

const nameOf = (cause: unknown) => (typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : undefined);

const reasonOf = (cause: unknown) => {
  if (cause instanceof Error) return cause.message || cause.name;
  // 部分环境（如 jsdom）的 DOMException 不是 Error 实例，按结构读取，避免丢失原因
  if (typeof cause === 'object' && cause !== null) {
    const { name, message } = cause as { name?: string; message?: string };
    if (message) return message;
    if (name) return name;
  }
  return String(cause);
};

const defaults = (): Dependencies => ({
  canShare: (data) => Boolean(navigator.canShare?.(data)),
  share: (data) => navigator.share(data),
  download: (blob, name) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click();
    // 点击只是“发起”下载；延迟回收，避免浏览器还没来得及落盘 URL 就失效。
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },
});

export class BrowserShareAdapter implements SharePort {
  constructor(private readonly deps: Dependencies = defaults()) {}

  private filesOf(meme: VoiceMeme) {
    return [
      { blob: meme.audio, name: `${meme.title}.${extension(meme.audio.type, 'webm')}`, type: meme.audio.type },
      { blob: meme.cover, name: `${meme.title}.png`, type: 'image/png' },
    ];
  }

  async share(meme: VoiceMeme): Promise<ShareOutcome> {
    const files = this.filesOf(meme).map((file) => new File([file.blob], file.name, { type: file.type }));
    let supported = false;
    try { supported = this.deps.canShare({ files }); } catch { supported = false; }
    if (!supported) return { kind: 'unavailable' };
    try {
      await this.deps.share({ title: meme.title, text: `声音表情包 · ${meme.emotion}`, files });
      return { kind: 'shared' };
    } catch (cause) {
      if (isCancellation(cause)) return { kind: 'cancelled' };
      return { kind: 'failed', reason: reasonOf(cause) };
    }
  }

  async download(meme: VoiceMeme, only?: readonly string[]): Promise<DownloadReport> {
    const report: DownloadReport = { initiated: [], failed: [] };
    for (const file of this.filesOf(meme)) {
      if (only && !only.includes(file.name)) continue;
      // 每份文件独立发起：一份失败不影响另一份，重试也只需带上失败的那份。
      try { this.deps.download(file.blob, file.name); report.initiated.push(file.name); }
      catch (cause) { report.failed.push({ name: file.name, reason: reasonOf(cause) }); }
    }
    return report;
  }
}
