import type { VoiceMeme } from '../core/models';

/**
 * 原生分享的四种结局，必须区分开，不能合并成同一句提示：
 * - shared：系统分享面板完成交付。
 * - cancelled：用户主动取消面板（AbortError）。不下载、不报成功。
 * - unavailable：浏览器确实不支持文件分享，可以回退为下载。
 * - failed：真实错误（如 InvalidStateError / NotAllowedError），保留原因交给用户决定。
 */
export type ShareOutcome =
  | { kind: 'shared' }
  | { kind: 'cancelled' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; reason: string };

/**
 * 逐文件汇报下载发起结果。initiated 只表示“已发起”，
 * 浏览器是否真正落盘无法得知，文案不得声称已保存。
 */
export interface DownloadReport {
  initiated: string[];
  failed: { name: string; reason: string }[];
}

export interface SharePort {
  share(meme: VoiceMeme): Promise<ShareOutcome>;
  /** 逐文件发起下载；only 传入文件名子集时只重试这些文件。 */
  download(meme: VoiceMeme, only?: readonly string[]): Promise<DownloadReport>;
}
