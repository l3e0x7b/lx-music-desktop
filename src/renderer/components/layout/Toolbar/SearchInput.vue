<template>
  <div :class="$style.wrap">
    <material-search-input v-model="searchText" :style="{ '--lx-search-input-width': '100%', 'flex': 'none' }" :placeholder="inputPlaceholder" :list="tipList" :visible-list="visibleList" @event="handleEvent" />
    <div :class="$style.mbzArea">
      <base-checkbox v-show="showMbzCheckbox" id="toolbar_search_mbz_checkbox" v-model="mbz" :class="$style.mbzCheckbox" :label="$t('search__mbz_checkbox')" @change="handleMbzChange" />
      <span v-show="showMbzSummary" :class="$style.mbzSummary">{{ mbzSummaryText }}<span v-show="mbzSearchState.partialFailed" :class="$style.mbzPartial" :aria-label="$t('search__mbz_partial_failed')">!</span></span>
    </div>
    <material-modal :show="artistChoiceState.visible" :bg-close="true" @close="handleArtistChoiceCancel">
      <main :class="$style.artistChoice">
        <select v-model="selectedArtistId" :class="$style.artistChoiceSelect" @change="handleArtistChoiceSelect">
          <option value="" disabled>{{ $t('search__mbz_artist_choose_placeholder') }}</option>
          <option v-for="artist in artistChoiceState.candidates" :key="artist.id" :value="artist.id">{{ artistOptionText(artist) }}</option>
        </select>
      </main>
    </material-modal>
  </div>
</template>

<script>
import music from '@renderer/utils/musicSdk'
import { debounce } from '@common/utils'
import {
  ref,
  computed,
  watch,
  nextTick,
} from '@common/utils/vueTools'
import { useRouter, useRoute } from '@common/utils/vueRouter'
import { appSetting } from '@renderer/store/setting'
import { searchText as _searchText } from '@renderer/store/search/state'
import { searchState as mbzSearchState, artistChoiceState, resolveArtistChoice } from '@renderer/store/search/mbz'
import { setSearchText } from '@renderer/store/search/action'
import { getSearchSetting } from '@renderer/utils/data'

export default {
  setup() {
    const searchText = ref('')
    const visibleList = ref(false)
    const tipList = ref([])
    const selectedArtistId = ref('')
    let isFocused = false
    let prevTempSearchSource = ''

    const route = useRoute()
    const router = useRouter()

    const mbz = ref(route.query.mbz == '1')
    watch(() => route.query.mbz, (value) => {
      mbz.value = value == '1'
    })
    const showMbzCheckbox = computed(() => {
      return route.name == 'Search' && (route.query.type ?? 'music') == 'music' && route.query.source != 'all'
    })
    const handleMbzChange = (checked) => {
      const query = { ...route.query }
      delete query.mbz
      if (checked) {
        query.mbz = '1'
      }
      void router.replace({
        path: route.path,
        query: { ...query, page: 1 },
      })
    }

    const showMbzSummary = computed(() => {
      return showMbzCheckbox.value && mbz.value && mbzSearchState.groupTotal != null
    })
    const mbzSummaryText = computed(() => {
      return window.i18n.t('search__mbz_summary', {
        group: mbzSearchState.groupTotal ?? 0,
        official: window.i18n.t('tag__mbz_official'),
      })
    })
    const inputPlaceholder = computed(() => {
      return showMbzCheckbox.value && mbz.value ? window.i18n.t('search__mbz_input_placeholder') : undefined
    })

    /** 艺术家候选下拉选项文本：Name · Sort name · Type · Gender · Area · Begin（空字段省略，与官网搜索列一致） */
    const artistOptionText = (artist) => {
      return [artist.name, artist.sortName, artist.type, artist.gender, artist.area, artist.begin]
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
        .join(' · ')
    }
    // 弹窗打开时下拉回到占位项（未选择状态）
    watch(() => artistChoiceState.visible, (visible) => {
      if (visible) selectedArtistId.value = ''
    })
    /** 下拉 change 即结算：以当前选中项确定艺术家 */
    const handleArtistChoiceSelect = () => {
      const artist = artistChoiceState.candidates.find(item => item.id == selectedArtistId.value) ?? null
      resolveArtistChoice(artist)
    }
    /** 关闭（右上角 × / 背景点击）：视为取消 */
    const handleArtistChoiceCancel = () => {
      resolveArtistChoice(null)
      // 同步 URL：清除 text 参数，使 URL 与 store 保持一致——否则取消后残留 text=旧词，
      // 再次输入同词回车/搜索时 vue-router 判定重复导航被 .catch 吞掉，导致搜索无响应
      void router.replace({
        path: route.path,
        query: { ...route.query, text: '', page: 1 },
      }).catch(_ => _)
    }

    watch(() => route.name, (newValue, oldValue) => {
      if (oldValue == 'Search' && newValue != 'SongListDetail') {
        setTimeout(() => {
          if (appSetting['odc.isAutoClearSearchInput'] && searchText.value) searchText.value = ''
          if (appSetting['odc.isAutoClearSearchList']) setSearchText('')
        })
      }
    })

    watch(_searchText, (newValue, oldValue) => {
      searchText.value = newValue
    })
    watch(searchText, () => {
      handleTipSearch()
    })


    const tipSearch = debounce(async() => {
      if (searchText.value === '' && prevTempSearchSource) {
        tipList.value = []
        music[prevTempSearchSource].tipSearch.cancelTipSearch()
        return
      }
      const { temp_source } = await getSearchSetting()
      prevTempSearchSource ||= temp_source
      music[prevTempSearchSource].tipSearch.search(searchText.value).then(list => {
        tipList.value = list
      }).catch(() => {})
    }, 50)

    const handleTipSearch = () => {
      if (!visibleList.value && isFocused) visibleList.value = true
      tipSearch()
    }

    const handleSearch = () => {
      visibleList.value &&= false
      if (!searchText.value && route.path != '/search') {
        setSearchText('')
        return
      }
      setTimeout(() => {
        if (route.name == 'Search') {
          // 已在搜索页：保留 source/type/mbz 等参数，仅更新关键词（勾选=mbz 搜索，不勾=原生搜索）
          void router.replace({
            path: route.path,
            query: {
              ...route.query,
              text: searchText.value,
              page: 1,
            },
          }).catch(_ => _)
        } else {
          router.push({
            path: '/search',
            query: {
              text: searchText.value,
            },
          }).catch(_ => _)
        }
      }, searchText.value ? 200 : 0)
    }

    const handleEvent = ({ action, data }) => {
      switch (action) {
        case 'focus':
          isFocused = true
          visibleList.value ||= true
          if (searchText.value) handleTipSearch()
          break
        case 'blur':
          isFocused = false
          setTimeout(() => {
            visibleList.value &&= false
          }, 50)
          break
        case 'submit':
          handleSearch()
          break
        case 'listClick':
          searchText.value = tipList.value[data]
          void nextTick(handleSearch)
      }
    }

    return {
      searchText,
      visibleList,
      tipList,
      handleEvent,
      mbz,
      showMbzCheckbox,
      showMbzSummary,
      mbzSummaryText,
      mbzSearchState,
      inputPlaceholder,
      handleMbzChange,
      artistChoiceState,
      selectedArtistId,
      artistOptionText,
      handleArtistChoiceSelect,
      handleArtistChoiceCancel,
    }
  },
}

</script>

<style lang="less" module>
@import '@renderer/assets/styles/layout.less';
.wrap {
  position: relative;
  flex: none;
  width: 35%;
  display: flex;
  align-items: center;
  font-size: 0.75rem;
  -webkit-app-region: no-drag;
}

.mbzArea {
  position: absolute;
  left: calc(100% + 0.5rem);
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  gap: 0.5rem;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}

.mbzCheckbox {
  flex: none;
  white-space: nowrap;
}

.mbzSummary {
  flex: none;
  white-space: nowrap;
  color: var(--color-font-label);
  -webkit-app-region: no-drag;
}

.mbzPartial {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1em;
  height: 1em;
  margin-left: 0.4em;
  font-size: 0.7rem;
  line-height: 1;
  color: var(--color-primary);
  border: 1px solid var(--color-primary);
  border-radius: 50%;
  -webkit-app-region: no-drag;
}

.artistChoice {
  padding: 15px;
  max-width: 420px;
  min-width: 280px;
  display: flex;
  flex-flow: column nowrap;
  h2 {
    font-size: 13px;
    color: var(--color-font);
    line-height: 1.3;
    text-align: center;
    margin-bottom: 15px;
  }
}

.artistChoiceSelect {
  display: block;
  width: 100%;
  box-sizing: border-box;
  font-size: 13px;
  color: var(--color-font);
  background-color: transparent;
  border: 1px solid var(--color-300);
  border-radius: 4px;
  padding: 6px 8px;
  cursor: pointer;
  outline: none;
}
</style>
