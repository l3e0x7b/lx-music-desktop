<template>
  <div :class="$style.container">
    <div :class="$style.header">
      <base-tab v-model="source" :list="sources" @change="handleSourceChange" />
      <div :class="$style.headerRight">
        <base-tab v-model="searchType" :list="searchTypes" @change="handleTypeChange" />
      </div>
    </div>
    <div :class="$style.main">
      <song-list-list v-if="searchType == 'songlist'" v-show="searchText" :page="page" :source-id="source" />
      <music-list-mbz v-else-if="mbz && source != 'all'" v-show="searchText" :page="page" :source-id="source" />
      <music-list v-else v-show="searchText" :page="page" :source-id="source" />
      <blank-view :visible="!searchText" :source="source" />
    </div>
  </div>
</template>

<script>
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { searchText } from '@renderer/store/search/state'
import { getSearchSetting, setSearchSetting } from '@renderer/utils/data'
import { sources as _sources } from '@renderer/store/search/music'
import { abortSearch } from '@renderer/store/search/mbz'

import MusicList from './MusicList/index.vue'
import MusicListMbz from './MusicListMbz/index.vue'
import SongListList from './SongListList/index.vue'
import BlankView from './components/BlankView.vue'
import { computed, ref } from '@common/utils/vueTools'
import { sourceNames } from '@renderer/store'

const source = ref('kw')
const searchType = ref(null)
const page = ref(1)
const mbz = ref(false)

const verifyQueryParams = async(to, from, next) => {
  let _source = to.query.source
  let _type = to.query.type
  let _page = to.query.page
  // 应用内导航（from.matched 非空）；首次进入/F5/外部/deeplink 时 from.matched 为空
  const isInApp = from.matched.length > 0
  // 「裸」导航：URL 未携带任何搜索相关参数（侧栏点击「搜索」从其他页返回搜索页）
  const isBareSearch = _source == null && _type == null && to.query.text == null && to.query.mbz == null
  // mbz 保留：URL 明确带 mbz=1；或应用内裸导航且上次勾选态仍在（沿用常驻内存的 mbz.value）。
  // 用户主动取消勾选/切源到 all/切类型时会显式携带 source/type/text，不命中裸导航分支，故不会被误恢复
  const keepMbz = isInApp && (to.query.mbz == '1' || (isBareSearch && mbz.value))
  const query = { ...to.query }
  // 保留勾选但 URL 缺 mbz（裸回搜）→ 写回，保证复选框（镜像 route.query.mbz）保持勾选；
  // 不保留但 URL 残留 mbz（首次进入）→ 清除
  if (keepMbz && to.query.mbz == null) query.mbz = '1'
  else if (!keepMbz && to.query.mbz != null) delete query.mbz
  let needRewrite = query.mbz !== to.query.mbz

  if (_source == null || _type == null) {
    const setting = await getSearchSetting()
    _source ??= setting.source
    _type ??= setting.type
    needRewrite = true
  }
  source.value = _source
  searchType.value = _type
  const prevMbz = mbz.value
  mbz.value = keepMbz
  // mbz 模式结束（取消勾选/切源到全部/切类型）→ 中止进行中的 mbz 拉取；
  // 切页（导航离开）不经过此处，故不中断（保留后台拉取与结果）
  if (prevMbz && !keepMbz) abortSearch()

  if (_page) page.value = parseInt(_page)

  if (to.query.text != null) {
    searchText.value = to.query.text
    if (!_page) page.value = 1
  }
  if (needRewrite) {
    // 仅在 URL 确实需要改写时重定向（vue-router 守卫重定向链中 currentRoute 尚未更新，
    // 目标与传入 URL 相同时仍会触发重复导航，必须避免无限重定向）
    next({
      path: to.path,
      query: { ...query, source: _source, type: _type, page: _page },
    })
    return
  }
  next()
  void setSearchSetting({ source: _source, type: _type })
}

export default {
  components: {
    MusicList,
    MusicListMbz,
    SongListList,
    BlankView,
  },
  beforeRouteEnter: verifyQueryParams,
  beforeRouteUpdate: verifyQueryParams,
  setup() {
    const route = useRoute()
    const router = useRouter()

    const sources = _sources.map(id => {
      return {
        id,
        label: sourceNames.value[id],
      }
    })
    const handleSourceChange = (id) => {
      const query = { ...route.query }
      if (id == 'all') delete query.mbz
      void router.replace({
        path: route.path,
        query: {
          ...query,
          source: id,
          page: 1,
        },
      })
    }

    const searchTypes = computed(() => {
      return [
        { label: window.i18n.t('search__type_music'), id: 'music' },
        { label: window.i18n.t('search__type_songlist'), id: 'songlist' },
      ]
    })
    const handleTypeChange = (type) => {
      const query = { ...route.query }
      delete query.mbz
      void router.replace({
        path: route.path,
        query: {
          ...query,
          type,
          page: 1,
        },
      })
    }


    return {
      sources,
      source,
      handleSourceChange,
      searchTypes,
      searchType,
      handleTypeChange,
      mbz,
      page,
      searchText,
    }
  },
}


</script>

<style lang="less" module>
.container {
  display: flex;
  flex-flow: column nowrap;
}

.header {
  // padding: 5px 0;
  flex: none;
  display: flex;
  flex-flow: row nowrap;
  justify-content: space-between;
}

.headerRight {
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  font-size: 12px;
}

.main {
  position: relative;
  flex: auto;
  // min-height: 0;
}
</style>
