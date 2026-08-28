import { computed, watch, ref, onBeforeUnmount, type Ref } from '@common/utils/vueTools'
import { isFullscreen } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { getFontSizeWithScreen } from '@renderer/utils'

const useKeyEvent = ({ handleSelectAllData, listRef }: {
  handleSelectAllData: () => void
  listRef: Ref<any>
}) => {
  const keyEvent = {
    isShiftDown: false,
    isModDown: false,
  }

  const handle_key_shift_down = () => {
    keyEvent.isShiftDown ||= true
  }
  const handle_key_shift_up = () => {
    keyEvent.isShiftDown &&= false
  }
  const handle_key_mod_down = () => {
    keyEvent.isModDown ||= true
  }
  const handle_key_mod_up = () => {
    keyEvent.isModDown &&= false
  }
  const handle_key_mod_a_down = ({ event }: LX.KeyDownEevent) => {
    if (!event || (event.target as HTMLElement).tagName == 'INPUT' || document.activeElement != listRef.value?.$el) return
    event.preventDefault()
    if (event.repeat) return
    keyEvent.isModDown = false
    handleSelectAllData()
  }

  onBeforeUnmount(() => {
    window.key_event.off('key_shift_down', handle_key_shift_down)
    window.key_event.off('key_shift_up', handle_key_shift_up)
    window.key_event.off('key_mod_down', handle_key_mod_down)
    window.key_event.off('key_mod_up', handle_key_mod_up)
    window.key_event.off('key_mod+a_down', handle_key_mod_a_down)
  })
  window.key_event.on('key_shift_down', handle_key_shift_down)
  window.key_event.on('key_shift_up', handle_key_shift_up)
  window.key_event.on('key_mod_down', handle_key_mod_down)
  window.key_event.on('key_mod_up', handle_key_mod_up)
  window.key_event.on('key_mod+a_down', handle_key_mod_a_down)

  return keyEvent
}


export default ({ props, listRef }: {
  props: {
    list: LX.Music.MusicInfoOnline[]
    mbz?: boolean
    mbzExpanded?: string[]
  }
  listRef: Ref<any>
}) => {
  const selectedList = ref<LX.Music.MusicInfoOnline[]>([])
  let lastSelectIndex = -1
  const listItemHeight = computed(() => {
    return Math.ceil((isFullscreen.value ? getFontSizeWithScreen() : appSetting['common.fontSize']) * 2.3)
  })

  // mbz 批量选择范围（Shift 范围/Ctrl+A）：存在展开组时 = 所有已展开组内曲目行的并集
  // （排除组行）；无展开组时无可批量选中项；组行恒不可批量选中；非 mbz 列表恒可选
  const isMbzBatchSelectable = (item: LX.Music.MusicInfoOnline) => {
    if (!props.mbz) return true
    const expanded = props.mbzExpanded ?? []
    if (expanded.length) return item.meta?.mbzGroup == null && expanded.includes(item.meta?.mbzGroupId ?? '')
    return false
  }

  const removeAllSelect = () => {
    selectedList.value = []
  }
  const handleSelectAllData = () => {
    removeAllSelect()
    selectedList.value = props.list.filter(item => isMbzBatchSelectable(item))
  }
  const keyEvent = useKeyEvent({ handleSelectAllData, listRef })

  const handleSelectData = (clickIndex: number) => {
    if (keyEvent.isShiftDown) {
      if (selectedList.value.length) {
        removeAllSelect()
        if (lastSelectIndex != clickIndex) {
          let isNeedReverse = false
          let _lastSelectIndex = lastSelectIndex
          if (clickIndex < _lastSelectIndex) {
            let temp = _lastSelectIndex
            _lastSelectIndex = clickIndex
            clickIndex = temp
            isNeedReverse = true
          }
          selectedList.value = props.list.slice(_lastSelectIndex, clickIndex + 1).filter(item => isMbzBatchSelectable(item))
          if (isNeedReverse) selectedList.value.reverse()
        }
      } else {
        const clickedItem = props.list[clickIndex]
        if (isMbzBatchSelectable(clickedItem)) selectedList.value.push(clickedItem)
        lastSelectIndex = clickIndex
      }
    } else if (keyEvent.isModDown) {
      lastSelectIndex = clickIndex
      let item = props.list[clickIndex]
      let index = selectedList.value.indexOf(item)
      if (index < 0) {
        selectedList.value.push(item)
      } else {
        selectedList.value.splice(index, 1)
      }
    } else if (selectedList.value.length) {
      removeAllSelect()
    }
  }

  watch(() => props.list, removeAllSelect)

  return {
    selectedList,
    listItemHeight,
    removeAllSelect,
    handleSelectData,
  }
}
