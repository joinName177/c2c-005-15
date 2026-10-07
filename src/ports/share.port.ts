import type { VoiceMeme } from '../core/models';
export type ShareFileKind = 'audio' | 'cover';
/** 单份文件的下载发起结果：started 只表示“已发起”，不代表已落盘。 */
export interface DownloadAttempt { file: ShareFileKind; name: string; started: boolean; error?: string }
export type ShareOutcome =
  | { kind: 'shared' }                                  // 系统分享面板完成
  | { kind: 'cancelled' }                               // 用户取消：不下载、不算成功
  | { kind: 'unavailable'; downloads: DownloadAttempt[] } // 浏览器确实不支持：兜底下载
  | { kind: 'failed'; reason: string };                 // 真实失败：保留原因，由用户决定下一步
export interface SharePort {
  share(meme: VoiceMeme): Promise<ShareOutcome>;
  /** 逐份发起下载；可用 only 只重试指定文件，互不影响。 */
  downloadFiles(meme: VoiceMeme, only?: ShareFileKind[]): DownloadAttempt[];
}
