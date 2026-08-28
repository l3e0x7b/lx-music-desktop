// import { useCommit } from '@common/utils/vueTools'
import { defaultList } from '@renderer/store/list/state'
import { getListMusics, addListMusics } from '@renderer/store/list/action'
import { addTempPlayList } from '@renderer/store/player/action'
import { appSetting } from '@renderer/store/setting'
import { type Ref } from '@common/utils/vueTools'
import { playList } from '@renderer/core/player'
import { LIST_IDS } from '@common/constants'
import { dialog } from '@renderer/plugins/Dialog'
import useResolvePlaceholder from './useResolvePlaceholder'

export default ({ selectedList, props, removeAllSelect, emit }: {
  selectedList: Ref<LX.Music.MusicInfoOnline[]>
  props: {
    list: LX.Music.MusicInfoOnline[]
    resolvePlaceholder?: (musicInfo: LX.Music.MusicInfo) => Promise<LX.Music.MusicInfo | null>
  }
  removeAllSelect: () => void
  emit: (event: 'show-menu' | 'play-list' | 'togglePage', ...args: any[]) => void
}) => {
  const { resolveTarget, resolveList } = useResolvePlaceholder({ props })
  let clickTime = 0
  let clickIndex = -1

  const handlePlayMusic = async(index: number, single: boolean) => {
    const defaultListMusics = await getListMusics(defaultList.id)
    let playTarget: LX.Music.MusicInfo | null = null
    if (selectedList.value.length && !single) {
      // 点击项与选中项统一解析：点击项无匹配时不中止整次播放、不弹提示，
      // 回退播放首个已匹配的选中项；全部无匹配且点击项也无匹配时才提示
      const clicked = props.resolvePlaceholder
        ? await props.resolvePlaceholder(props.list[index])
        : props.list[index]
      let list = await resolveList(selectedList.value, { silentFail: true })
      if (!list && !clicked) {
        dialog({
          message: window.i18n.t('search__mbz_play_no_match'),
          closeBtn: true,
          showConfirm: false,
        })
        return
      }
      list ??= []
      if (clicked && !list.some(s => s.id == clicked.id)) list = [clicked, ...list]
      await addListMusics(defaultList.id, [...list])
      removeAllSelect()
      playTarget = clicked ?? list[0] ?? null
    } else {
      playTarget = await resolveTarget(props.list[index])
      if (!playTarget) return
      await addListMusics(defaultList.id, [playTarget])
    }
    if (!playTarget) return
    const targetIndex = defaultListMusics.findIndex(s => s.id === playTarget.id)
    if (targetIndex > -1) {
      playList(defaultList.id, targetIndex)
    }
  }

  const handlePlayMusicLater = async(index: number, single: boolean) => {
    if (selectedList.value.length && !single) {
      const list = await resolveList(selectedList.value)
      if (!list) return
      addTempPlayList(list.map(s => ({ listId: LIST_IDS.PLAY_LATER, musicInfo: s })))
      removeAllSelect()
    } else {
      const targetSong = await resolveTarget(props.list[index])
      if (!targetSong) return
      addTempPlayList([{ listId: LIST_IDS.PLAY_LATER, musicInfo: targetSong }])
    }
  }

  const doubleClickPlay = (index: number) => {
    if (
      window.performance.now() - clickTime > 400 ||
      clickIndex !== index
    ) {
      clickTime = window.performance.now()
      clickIndex = index
      return
    }
    if (appSetting['list.isClickPlayList']) {
      emit('play-list', index)
    } else {
      void handlePlayMusic(index, true)
    }
    clickTime = 0
    clickIndex = -1
  }

  return {
    handlePlayMusic,
    handlePlayMusicLater,
    doubleClickPlay,
  }
}
