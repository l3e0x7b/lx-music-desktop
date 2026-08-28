import { LIST_IDS } from '@common/constants'
import { ref } from '@common/utils/vueTools'
import { playList } from '@renderer/core/player/action'
import { getListMusics, addListMusics } from '@renderer/store/list/action'
import { assertApiSupport } from '@renderer/store/utils'
import { dialog } from '@renderer/plugins/Dialog'
import { search as searchMbz, matchOnPlay, findCandidate } from '@renderer/store/search/mbz'

export default () => {
  const listRef = ref<any>(null)

  const search = (text: string, sourceId: LX.OnlineSource, page: number) => {
    void searchMbz(text, sourceId, page).then((list: LX.Music.MusicInfo[]) => {
      if (list.length) {
        setTimeout(() => {
          if (listRef.value) listRef.value.scrollToTop()
        })
      }
    })
  }

  /**
   * 占位项（MusicBrainz 候选）即时匹配为平台曲目；非占位项原样返回
   * 曲目行 id 为 mbz__<groupId>__<releaseId>__<mediaIdx>__<recId>，按 id 反查候选（不依赖列表下标，
   * 列表为「组行 + 展开曲目行」动态合成，下标不可信）
   */
  const resolvePlaceholder = async(musicInfo: LX.Music.MusicInfo | undefined): Promise<LX.Music.MusicInfo | null> => {
    if (typeof musicInfo?.id != 'string' || !musicInfo.id.startsWith('mbz__')) {
      // 组行占位（mbz_group__ 前缀）不可解析为平台曲目：Ctrl+A/Shift 范围选择会包含组行，
      // 返回 null 交给批量链路静默跳过，避免 songId 为空的占位数据流入歌单/下载/播放
      return typeof musicInfo?.id == 'string' && musicInfo.id.startsWith('mbz_group__') ? null : musicInfo ?? null
    }
    const candidate = findCandidate(musicInfo.id)
    if (!candidate) return null
    return matchOnPlay(candidate, musicInfo.source as LX.OnlineSource)
  }

  const playSong = (song: LX.Music.MusicInfo) => {
    if (!assertApiSupport(song.source)) return

    void getListMusics(LIST_IDS.DEFAULT).then(async defaultListMusics => {
      await addListMusics(LIST_IDS.DEFAULT, [song])

      const targetIndex = defaultListMusics.findIndex(s => s.id === song.id)
      if (targetIndex > -1) playList(LIST_IDS.DEFAULT, targetIndex)
    })
  }

  const handlePlayList = async(index: number, list: LX.Music.MusicInfo[]) => {
    // 越界防御：列表为「组行 + 展开曲目行」动态合成，重建期间发出的索引可能落在新列表范围外
    if (!list || index < 0 || index >= list.length) return
    const targetSong = await resolvePlaceholder(list[index])
    if (!targetSong) {
      dialog({
        message: window.i18n.t('search__mbz_play_no_match'),
        closeBtn: true,
        showConfirm: false,
      })
      return
    }
    playSong(targetSong)
  }

  return {
    listRef,
    search,
    resolvePlaceholder,
    handlePlayList,
  }
}
