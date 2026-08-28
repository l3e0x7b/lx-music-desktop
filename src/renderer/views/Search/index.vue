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
  // 仅页内导航（勾选/回车/翻页）保留 mbz；离开过搜索页或外部进入一律恢复原生搜索
  const keepMbz = from.path == to.path && to.query.mbz == '1'
  const query = { ...to.query }
  // URL 需改写：清除残留的 mbz（F5/从其他页返回等），保证复选框状态与页面行为一致
  let needRewrite = !keepMbz && to.query.mbz != null
  if (needRewrite) delete query.mbz

  if (_source == null || _type == null) {
    const setting = await getSearchSetting()
    _source ??= setting.source
    _type ??= setting.type
    needRewrite = true
  }
  source.value = _source
  searchType.value = _type
  mbz.value = keepMbz

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
