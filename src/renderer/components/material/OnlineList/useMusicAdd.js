import { ref, nextTick } from '@common/utils/vueTools'
import useResolvePlaceholder from './useResolvePlaceholder'

export default ({ selectedList, props }) => {
  const isShowListAdd = ref(false)
  const isShowListAddMultiple = ref(false)
  const selectedAddMusicInfo = ref(null)
  const addMultipleList = ref([])
  const { resolveTarget, resolveList } = useResolvePlaceholder({ props })

  const handleShowMusicAddModal = async(index, single) => {
    if (selectedList.value.length && !single) {
      const list = await resolveList(selectedList.value)
      if (!list) return
      addMultipleList.value = list
      isShowListAddMultiple.value = true
    } else {
      const targetSong = await resolveTarget(props.list[index])
      if (!targetSong) return
      selectedAddMusicInfo.value = targetSong
      nextTick(() => {
        isShowListAdd.value = true
      })
    }
  }

  return {
    isShowListAdd,
    isShowListAddMultiple,
    addMultipleList,
    selectedAddMusicInfo,
    handleShowMusicAddModal,
  }
}
