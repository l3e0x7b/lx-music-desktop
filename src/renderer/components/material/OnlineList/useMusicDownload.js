import { ref, nextTick } from '@common/utils/vueTools'
import useResolvePlaceholder from './useResolvePlaceholder'

export default ({ selectedList, props }) => {
  const isShowDownload = ref(false)
  const isShowDownloadMultiple = ref(false)
  const musicInfo = ref(null)
  const downloadMultipleList = ref([])
  const { resolveTarget, resolveList } = useResolvePlaceholder({ props })

  const handleShowDownloadModal = async(index, single) => {
    if (selectedList.value.length && !single) {
      const list = await resolveList(selectedList.value)
      if (!list) return
      downloadMultipleList.value = list
      isShowDownloadMultiple.value = true
    } else {
      const targetSong = await resolveTarget(props.list[index])
      if (!targetSong) return
      musicInfo.value = targetSong
      nextTick(() => {
        isShowDownload.value = true
      })
    }
  }

  return {
    isShowDownload,
    isShowDownloadMultiple,
    downloadMultipleList,
    selectedDownloadMusicInfo: musicInfo,
    handleShowDownloadModal,
  }
}
