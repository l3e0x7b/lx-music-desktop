import { dialog } from '@renderer/plugins/Dialog'

/**
 * 占位曲目（如 MusicBrainz 候选）解析：在播放/下载/加歌单前即时替换为平台匹配结果
 */
export default ({ props }: { props: { resolvePlaceholder?: (musicInfo: LX.Music.MusicInfo) => Promise<LX.Music.MusicInfo | null> } }) => {
  const resolveTarget = async(musicInfo: LX.Music.MusicInfo): Promise<LX.Music.MusicInfo | null> => {
    if (!props.resolvePlaceholder) return musicInfo
    const resolved = await props.resolvePlaceholder(musicInfo)
    if (!resolved) {
      dialog({
        message: window.i18n.t('search__mbz_play_no_match'),
        closeBtn: true,
        showConfirm: false,
      })
    }
    return resolved
  }

  const resolveList = async(list: LX.Music.MusicInfo[], options?: { silentFail?: boolean }): Promise<LX.Music.MusicInfo[] | null> => {
    const resolvePlaceholder = props.resolvePlaceholder
    if (!resolvePlaceholder) return list
    // 受限并发解析（matchOnPlay 内部已按 key 去重，可安全并发），保持结果顺序与选中顺序一致
    const CONCURRENCY = 4
    const result: Array<LX.Music.MusicInfo | null> = new Array(list.length).fill(null)
    let index = 0
    const worker = async() => {
      while (index < list.length) {
        const i = index++
        result[i] = await resolvePlaceholder(list[i])
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker))
    const resolved = result.filter((item): item is LX.Music.MusicInfo => item != null)
    if (!resolved.length) {
      // 全部失败默认弹窗提示；调用方需要自行裁决反馈时机（如批量播放点击项成功时继续播放）可传 silentFail
      if (!options?.silentFail) {
        dialog({
          message: window.i18n.t('search__mbz_play_no_match'),
          closeBtn: true,
          showConfirm: false,
        })
      }
      return null
    }
    return resolved
  }

  return {
    resolveTarget,
    resolveList,
  }
}
