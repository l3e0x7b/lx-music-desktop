<template>
  <div :class="$style.container">
    <div v-show="searchState.isSearching" :class="$style.progress">
      <div :class="$style.progressBar">
        <div :class="$style.progressInner" :style="{ width: `${progressWidth}%` }"></div>
      </div>
      <span :class="$style.progressText">{{ progressText }}</span>
    </div>
    <div :class="$style.list">
      <material-online-list
        ref="listRef"
        :page="1"
        :limit="listInfo.limit"
        :total="listInfo.total"
        :list="displayList"
        :no-item="listInfo.noItemLabel"
        :resolve-placeholder="resolvePlaceholder"
        :mbz="true"
        :mbz-expanded="expandedList"
        check-api-source
        @mbz-toggle-expand="handleMbzToggleExpand"
        @mbz-select-release="handleMbzSelectRelease"
        @play-list="handlePlayList"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from '@common/utils/vueTools'
import { searchText } from '@renderer/store/search/state'
import { listInfo, searchState, abortSearch, buildGroupTracks } from '@renderer/store/search/mbz'
import useList from './useList'

interface Props {
  sourceId: LX.OnlineSource
  page: number
}

const props = defineProps<Props>()

const {
  listRef,
  search,
  resolvePlaceholder,
  handlePlayList: handlePlayListBase,
} = useList()

// 展开的作品集（可同时展开多个）；选中版本存于组行 meta.mbzReleaseId（默认官网序第一行）
const expanded = reactive(new Set<string>())

/** 曲目行追加组内序号（从 1 计数），供列表组件序号列展示 */
const appendTracks = (rows: LX.Music.MusicInfo[], groupId: string, releaseId: string) => {
  const tracks = buildGroupTracks(groupId, releaseId)
  for (let i = 0; i < tracks.length; i++) {
    tracks[i].meta.mbzTrackIndex = i + 1
    rows.push(tracks[i])
  }
}

/** 展示列表 = 组行 + 已展开组的曲目行（版本切换时自动重建，行 id 含版本 id）；
 * 所有作品集（含单曲组）统一为组行：展开后展示所选版本曲目行；
 * 孤儿组（release browse 无关联 release，如 Various Artists 合辑）releases 为空：组行照常展示。
 * 列表为显式重建（rebuildList）：切换版本/展开状态时强制重建，不依赖 computed 依赖追踪；
 * 选中版本直接读写组行 meta（markRaw 普通对象），不依赖任何响应式容器 */
const displayList = ref<LX.Music.MusicInfo[]>([])
const rebuildList = () => {
  const rows: LX.Music.MusicInfo[] = []
  for (let gi = 0; gi < listInfo.list.length; gi++) {
    const groupRow = listInfo.list[gi]
    const groupMeta = groupRow.meta?.mbzGroup
    if (!groupMeta) continue
    groupRow.meta.mbzGroupIndex = gi + 1
    rows.push(groupRow)
    const releaseId = groupRow.meta.mbzReleaseId ?? groupMeta.releases[0]?.id
    if (!releaseId) continue
    if (!expanded.has(groupMeta.id)) continue
    appendTracks(rows, groupMeta.id, releaseId)
  }
  displayList.value = rows
}
const expandedList = computed(() => [...expanded])

const handleMbzToggleExpand = (groupId: string) => {
  if (expanded.has(groupId)) expanded.delete(groupId)
  else expanded.add(groupId)
  rebuildList()
}
const handleMbzSelectRelease = ({ groupId, releaseId }: { groupId: string, releaseId: string }) => {
  const groupRow = listInfo.list.find(item => item.meta?.mbzGroup?.id == groupId)
  if (!groupRow) return
  groupRow.meta.mbzReleaseId = releaseId
  rebuildList()
}
const handlePlayList = (index: number) => {
  void handlePlayListBase(index, displayList.value)
}

// 切换页面/取消勾选（组件卸载）时中止进行中的 mbz 拉取：停止请求、结果不入缓存
let searchTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  abortSearch()
})

// 新搜索开始时清空展开/选版状态（listInfo.key 每次搜索都会更新；组行 meta.mbzReleaseId 随列表重建自然重置）
watch(() => listInfo.key, () => {
  expanded.clear()
  rebuildList()
})

// 搜索完成/清空列表时重建展示列表（组行 meta 为 markRaw，深度监听 list 自身变化即可）
watch(() => listInfo.list, rebuildList, { deep: true })

// 源/页/关键词任一变化触发搜索；合并为单一 watch 避免 text 与 source/page 同时变化时的重复 search
watch([() => props.sourceId, () => props.page, searchText], ([sourceId, page, text]) => {
  searchTimer = setTimeout(() => {
    search(text || '', sourceId, page || 1)
  })
}, { immediate: true })

const progressWidth = computed(() => {
  return searchState.progress.total ? Math.min(100, searchState.progress.done / searchState.progress.total * 100) : 0
})

const progressText = computed(() => {
  return window.i18n.t('search__mbz_loading', {
    done: searchState.progress.done,
  })
})
</script>


<style lang="less" module>
.container {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
}

.progress {
  flex: none;
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 10px;
  padding: 4px 15px 0;
  font-size: 12px;
  color: var(--color-font-label);
}

.progressBar {
  flex: auto;
  height: 4px;
  border-radius: 2px;
  background-color: var(--color-300);
  overflow: hidden;
}

.progressInner {
  height: 100%;
  border-radius: 2px;
  background-color: var(--color-primary);
  transition: width 0.3s ease;
}

.progressText {
  flex: none;
  white-space: nowrap;
}

.list {
  flex: auto;
  min-height: 0;
  position: relative;
}
</style>
