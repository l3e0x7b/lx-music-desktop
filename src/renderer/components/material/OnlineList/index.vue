<template>
  <div :class="$style.songList">
    <!-- <transition enter-active-class="animated-fast fadeIn" leave-active-class="animated-fast fadeOut"> -->
    <div :class="$style.list">
      <div class="thead">
        <table>
          <thead>
            <tr v-if="actionButtonsVisible">
              <th class="num" style="width: 5%;">#</th>
              <th class="nobreak">{{ $t('music_name') }}</th>
              <th class="nobreak" style="width: 22%;">{{ $t('music_singer') }}</th>
              <th class="nobreak" style="width: 22%;">{{ $t('music_album') }}</th>
              <th class="nobreak" style="width: 9%;">{{ $t('music_time') }}</th>
              <th class="nobreak" style="width: 16%;">{{ $t('action') }}</th>
            </tr>
            <tr v-else>
              <th class="num" style="width: 5%;">#</th>
              <th class="nobreak">{{ $t('music_name') }}</th>
              <th class="nobreak" style="width: 24%;">{{ $t('music_singer') }}</th>
              <th class="nobreak" style="width: 27%;">{{ $t('music_album') }}</th>
              <th class="nobreak" style="width: 10%;">{{ $t('music_time') }}</th>
            </tr>
          </thead>
        </table>
      </div>
      <div :class="$style.content">
        <div v-show="!noItem" ref="dom_listContent" :class="$style.content">
          <!-- 注意：本文件两个分支（actionButtonsVisible 为真/假）的组行+曲目行模板相互重复，仅列宽百分比不同；
               修改任一行模板时必须同步另一分支，否则「列表操作按钮」开关切换后会出现列宽/内容不一致。 -->
          <base-virtualized-list v-if="actionButtonsVisible" ref="listRef" :list="list" key-name="id" :item-height="listItemHeight" container-class="scroll" content-class="list" @contextmenu.capture="handleListRightClick">
            <template #default="{ item, index }">
              <div
                v-if="item.meta?.mbzGroup"
                class="list-item" :class="[{ selected: rightClickSelectedIndex == index }, { active: selectedList.includes(item) }, { expanded: mbzExpanded.includes(item.meta.mbzGroup.id) }]"
                @click="handleMbzGroupClick($event, index)" @contextmenu.stop.prevent
              >
                <div class="list-item-cell no-select" style="flex: 0 0 5%; text-align: center;">{{ item.meta.mbzGroupIndex }}</div>
                <div class="list-item-cell auto name">
                  <span v-if="item.meta.mbzGroup.releases.length" :class="$style.mbzExpandIcon">{{ mbzExpanded.includes(item.meta.mbzGroup.id) ? '▾' : '▸' }}</span>
                </div>
                <div class="list-item-cell" style="flex: 0 0 22%;"><span class="select" :aria-label="singerTip(item)">{{ item.singer }}</span></div>
                <div class="list-item-cell" style="flex: 0 0 22%;">
                  <select v-if="item.meta.mbzGroup.releases.length" :class="$style.mbzReleaseSelect" :aria-label="groupAlbumTip(item)" :value="mbzSelectedReleaseId(item)" @click.stop @change="handleMbzReleaseChange($event, item.meta.mbzGroup.id)">
                    <option v-for="rel in item.meta.mbzGroup.releases" :key="rel.id" :value="rel.id">{{ releaseOptionText(item.meta.mbzGroup.title, rel) }}</option>
                  </select>
                  <span v-else class="select">{{ item.meta.mbzGroup.title }}</span>
                </div>
                <div class="list-item-cell" style="flex: 0 0 9%;"><span class="no-select"></span></div>
                <div class="list-item-cell" style="flex: 0 0 16%; padding-left: 0; padding-right: 0;"></div>
              </div>
              <div
                v-else
                class="list-item" :class="[{ selected: rightClickSelectedIndex == index }, { active: selectedList.includes(item) }]"
                @click="handleListItemClick($event, index)" @contextmenu="handleListItemRightClick($event, index)"
              >
                <div
                  class="list-item-cell no-select" :class="{ num: item.meta?.mbzGroupIndex == null }"
                  style="flex: 0 0 5%; text-align: center;" @click.stop
                >{{ mbzTrackIndexText(item, index) }}</div>
                <div class="list-item-cell auto name">
                  <span class="select name" :aria-label="titleTip(item)">{{ item.name }}</span>
                  <span v-if="item.meta.mbzMediaFormat" class="no-select badge badge-theme-primary">{{ item.meta.mbzMediaFormat }}</span>
                  <span v-if="item.meta._qualitys.flac24bit" class="no-select badge badge-theme-primary">{{ $t('tag__lossless_24bit') }}</span>
                  <span v-else-if="item.meta._qualitys.ape || item.meta._qualitys.flac || item.meta._qualitys.wav" class="no-select badge badge-theme-primary">{{ $t('tag__lossless') }}</span>
                  <span v-else-if="item.meta._qualitys['320k']" class="no-select badge badge-theme-secondary">{{ $t('tag__high_quality') }}</span>
                  <span v-if="sourceTag" class="no-select badge badge-theme-tertiary">{{ item.source }}</span>
                </div>
                <div class="list-item-cell" style="flex: 0 0 22%;"><span class="select" :aria-label="singerTip(item)">{{ item.singer }}</span></div>
                <div class="list-item-cell" style="flex: 0 0 22%;">
                  <span class="select" :aria-label="releaseTip(item)">{{ item.meta.albumName }}</span>
                  <span v-if="item.meta.mbzType" class="no-select badge badge-theme-primary">{{ mbzTypeText(item.meta.mbzType) }}</span>
                </div>
                <div class="list-item-cell" style="flex: 0 0 9%;"><span class="no-select">{{ item.interval || '--/--' }}</span></div>
                <div class="list-item-cell" style="flex: 0 0 16%; padding-left: 0; padding-right: 0;">
                  <material-list-buttons :index="index" :remove-btn="false" :download-btn="assertApiSupport(item.source)" :play-btn="checkApiSource ? assertApiSupport(item.source) : true" @btn-click="handleListBtnClick" />
                </div>
              </div>
            </template>
            <template #footer>
              <div v-if="!mbz" :class="$style.pagination">
                <material-pagination :count="total" :limit="limit" :page="page" @btn-click="$emit('togglePage', $event)" />
              </div>
            </template>
          </base-virtualized-list>
          <base-virtualized-list v-else ref="listRef" :list="list" key-name="id" :item-height="listItemHeight" container-class="scroll" content-class="list" @contextmenu.capture="handleListRightClick">
            <template #default="{ item, index }">
              <div
                v-if="item.meta?.mbzGroup"
                class="list-item" :class="[{ selected: rightClickSelectedIndex == index }, { active: selectedList.includes(item) }, { expanded: mbzExpanded.includes(item.meta.mbzGroup.id) }]"
                @click="handleMbzGroupClick($event, index)" @contextmenu.stop.prevent
              >
                <div class="list-item-cell no-select" style="flex: 0 0 5%; text-align: center;">{{ item.meta.mbzGroupIndex }}</div>
                <div class="list-item-cell auto name">
                  <span v-if="item.meta.mbzGroup.releases.length" :class="$style.mbzExpandIcon">{{ mbzExpanded.includes(item.meta.mbzGroup.id) ? '▾' : '▸' }}</span>
                </div>
                <div class="list-item-cell" style="flex: 0 0 24%;"><span class="select" :aria-label="singerTip(item)">{{ item.singer }}</span></div>
                <div class="list-item-cell" style="flex: 0 0 27%;">
                  <select v-if="item.meta.mbzGroup.releases.length" :class="$style.mbzReleaseSelect" :aria-label="groupAlbumTip(item)" :value="mbzSelectedReleaseId(item)" @click.stop @change="handleMbzReleaseChange($event, item.meta.mbzGroup.id)">
                    <option v-for="rel in item.meta.mbzGroup.releases" :key="rel.id" :value="rel.id">{{ releaseOptionText(item.meta.mbzGroup.title, rel) }}</option>
                  </select>
                  <span v-else class="select">{{ item.meta.mbzGroup.title }}</span>
                </div>
                <div class="list-item-cell" style="flex: 0 0 10%;"><span class="no-select"></span></div>
              </div>
              <div
                v-else
                class="list-item" :class="[{ selected: rightClickSelectedIndex == index }, { active: selectedList.includes(item) }]"
                @click="handleListItemClick($event, index)" @contextmenu="handleListItemRightClick($event, index)"
              >
                <div
                  class="list-item-cell no-select" :class="{ num: item.meta?.mbzGroupIndex == null }"
                  style="flex: 0 0 5%; text-align: center;" @click.stop
                >{{ mbzTrackIndexText(item, index) }}</div>
                <div class="list-item-cell auto name">
                  <span class="select name" :aria-label="titleTip(item)">{{ item.name }}</span>
                  <span v-if="item.meta.mbzMediaFormat" class="no-select badge badge-theme-primary">{{ item.meta.mbzMediaFormat }}</span>
                  <span v-if="item.meta._qualitys.flac24bit" class="no-select badge badge-theme-primary">{{ $t('tag__lossless_24bit') }}</span>
                  <span v-else-if="item.meta._qualitys.ape || item.meta._qualitys.flac || item.meta._qualitys.wav" class="no-select badge badge-theme-primary">{{ $t('tag__lossless') }}</span>
                  <span v-else-if="item.meta._qualitys['320k']" class="no-select badge badge-theme-secondary">{{ $t('tag__high_quality') }}</span>
                  <span v-if="sourceTag" class="no-select badge badge-theme-tertiary">{{ item.source }}</span>
                </div>
                <div class="list-item-cell" style="flex: 0 0 24%;"><span class="select" :aria-label="singerTip(item)">{{ item.singer }}</span></div>
                <div class="list-item-cell" style="flex: 0 0 27%;">
                  <span class="select" :aria-label="releaseTip(item)">{{ item.meta.albumName }}</span>
                  <span v-if="item.meta.mbzType" class="no-select badge badge-theme-primary">{{ mbzTypeText(item.meta.mbzType) }}</span>
                </div>
                <div class="list-item-cell" style="flex: 0 0 10%;"><span class="no-select">{{ item.interval || '--/--' }}</span></div>
              </div>
            </template>
            <template #footer>
              <div v-if="!mbz" :class="$style.pagination">
                <material-pagination :count="total" :limit="limit" :page="page" @btn-click="$emit('togglePage', $event)" />
              </div>
            </template>
          </base-virtualized-list>
        </div>
        <transition enter-active-class="animated fadeIn" leave-active-class="animated fadeOut">
          <div v-show="noItem" :class="$style.noitem">
            <p v-text="noItem" />
          </div>
        </transition>
      </div>
    </div>
    <!-- </transition> -->
    <!-- <material-flow-btn :show="isShowEditBtn && assertApiSupport(source)" :remove-btn="false" @btn-click="handleFlowBtnClick" /> -->
    <!-- <common-download-modal v-model:show="isShowDownload" :music-info="selectedDownloadMusicInfo" teleport="#view" />
    <common-download-multiple-modal v-model:show="isShowDownloadMultiple" :list="selectedList" teleport="#view" @confirm="removeAllSelect" /> -->
    <common-list-add-modal v-model:show="isShowListAdd" :music-info="selectedAddMusicInfo" teleport="#view" />
    <common-list-add-multiple-modal v-model:show="isShowListAddMultiple" :music-list="addMultipleList" teleport="#view" @confirm="removeAllSelect" />
    <common-download-modal v-model:show="isShowDownload" :music-info="selectedDownloadMusicInfo" teleport="#view" />
    <common-download-multiple-modal v-model:show="isShowDownloadMultiple" :list="downloadMultipleList" teleport="#view" @confirm="removeAllSelect" />
    <base-menu v-model="isShowItemMenu" :menus="menus" :xy="menuLocation" item-name="name" @menu-click="handleMenuClick" />
  </div>
</template>

<script>
import { clipboardWriteText } from '@common/utils/electron'
import { assertApiSupport } from '@renderer/store/utils'
import { ref } from '@common/utils/vueTools'
import useList from './useList'
import useMenu from './useMenu'
import usePlay from './usePlay'
import useMusicDownload from './useMusicDownload'
import useMusicAdd from './useMusicAdd'
import useMusicActions from './useMusicActions'
import { appSetting } from '@renderer/store/setting'
export default {
  name: 'MaterialOnlineList',
  props: {
    list: {
      type: Array,
      default() {
        return []
      },
    },
    page: {
      type: Number,
      required: true,
    },
    limit: {
      type: Number,
      required: true,
    },
    total: {
      type: Number,
      required: true,
    },
    sourceTag: {
      type: Boolean,
      default: false,
    },
    noItem: {
      type: String,
      default: '',
    },
    checkApiSource: {
      type: Boolean,
      default: false,
    },
    resolvePlaceholder: {
      type: Function,
      default: null,
    },
    mbz: {
      type: Boolean,
      default: false,
    },
    mbzExpanded: {
      type: Array,
      default() {
        return []
      },
    },
  },
  emits: ['show-menu', 'play-list', 'togglePage', 'mbz-toggle-expand', 'mbz-select-release'],
  setup(props, { emit }) {
    const actionButtonsVisible = appSetting['list.actionButtonsVisible']
    const rightClickSelectedIndex = ref(-1)
    const dom_listContent = ref(null)
    const listRef = ref(null)

    const mbzTypeText = (type) => {
      switch (type) {
        case 'Album':
          return window.i18n.t('tag__mbz_album')
        case 'EP':
          return window.i18n.t('tag__mbz_ep')
        case 'Single':
          return window.i18n.t('tag__mbz_single')
        default:
          return window.i18n.t('tag__mbz_other')
      }
    }

    /** 组行选中版本 id：优先行内 meta.mbzReleaseId（切换版本时写入），缺省官网序第一行 */
    const mbzSelectedReleaseId = (groupRow) => {
      return groupRow.meta?.mbzReleaseId ?? groupRow.meta?.mbzGroup?.releases?.[0]?.id ?? ''
    }

    /** 组行版本下拉悬浮提示：展示选中版本的 MBID、catalog、barcode（与候选曲目行 releaseTip 一致） */
    const groupAlbumTip = (groupRow) => {
      const groupMeta = groupRow.meta?.mbzGroup
      if (!groupMeta?.releases?.length) return groupMeta?.title ?? ''
      const selectedId = mbzSelectedReleaseId(groupRow)
      const rel = groupMeta.releases.find(r => r.id == selectedId)
      if (!rel) return groupMeta.title
      const lines = [window.i18n.t('search__mbz_release_mbid', { mbid: rel.id })]
      if (rel.catalog) lines.push(window.i18n.t('search__mbz_release_catalog', { catalog: rel.catalog }))
      if (rel.barcode) lines.push(window.i18n.t('search__mbz_release_barcode', { barcode: rel.barcode }))
      return lines.join('\n')
    }

    /** 曲目行序号：mbz 曲目行为组内序号（从 1 计数），普通行用列表下标 */
    const mbzTrackIndexText = (item, index) => {
      return item.meta?.mbzTrackIndex != null ? item.meta.mbzTrackIndex : index + 1
    }

    /** 版本下拉选项文字：高音质 ● 前缀 + 作品集名 · format · tracks · country · date · label（空值省略，圆点分隔） */
    const releaseOptionText = (groupTitle, rel) => {
      const qualityMark = rel.quality == 'high' ? '● ' : ''
      return qualityMark + [groupTitle, rel.format, rel.trackCount, rel.country, rel.date, rel.label]
        .map(value => String(value ?? '').trim())
        .filter(Boolean)
        .join(' · ')
    }

    const handleMbzGroupClick = (event, index) => {
      const groupRow = props.list[index]
      const groupId = groupRow?.meta?.mbzGroup?.id
      if (!groupId) return
      const releases = groupRow.meta.mbzGroup.releases
      // 无版本数据（孤儿组）无展开/收起能力
      if (!releases.length) return
      emit('mbz-toggle-expand', groupId)
    }

    const handleMbzReleaseChange = (event, groupId) => {
      emit('mbz-select-release', { groupId, releaseId: event.target.value })
    }

    const titleTip = (item) => {
      return item.meta?.mbzTrackMbid
        ? window.i18n.t('search__mbz_track_mbid', { mbid: item.meta.mbzTrackMbid })
        : item.name
    }
    const singerTip = (item) => {
      return item.meta?.mbzArtistMbid
        ? window.i18n.t('search__mbz_artist_mbid', { mbid: item.meta.mbzArtistMbid })
        : item.singer
    }
    const releaseTip = (item) => {
      const meta = item.meta ?? {}
      // mbz 曲目行：悬浮展示选中版本的 release MBID + Catalog + Barcode
      if (meta.mbzReleaseMbid) {
        const lines = [window.i18n.t('search__mbz_release_mbid', { mbid: meta.mbzReleaseMbid })]
        if (meta.mbzReleaseCatalog) lines.push(window.i18n.t('search__mbz_release_catalog', { catalog: meta.mbzReleaseCatalog }))
        if (meta.mbzReleaseBarcode) lines.push(window.i18n.t('search__mbz_release_barcode', { barcode: meta.mbzReleaseBarcode }))
        return lines.join('\n')
      }
      return item.meta.albumName
    }

    const {
      selectedList,
      listItemHeight,
      handleSelectData,
      removeAllSelect,
    } = useList({ props, listRef })

    const {
      handlePlayMusic,
      handlePlayMusicLater,
      doubleClickPlay,
    } = usePlay({ selectedList, props, removeAllSelect, emit })

    const {
      isShowListAdd,
      isShowListAddMultiple,
      addMultipleList,
      selectedAddMusicInfo,
      handleShowMusicAddModal,
    } = useMusicAdd({ selectedList, props })

    const {
      isShowDownload,
      isShowDownloadMultiple,
      downloadMultipleList,
      selectedDownloadMusicInfo,
      handleShowDownloadModal,
    } = useMusicDownload({ selectedList, props })

    const {
      handleSearch,
      handleOpenMusicDetail,
      handleDislikeMusic,
    } = useMusicActions({ props })

    const {
      menus,
      menuLocation,
      isShowItemMenu,
      showMenu,
      menuClick,
    } = useMenu({
      props,
      assertApiSupport,
      emit,

      handleShowDownloadModal,
      handlePlayMusic,
      handlePlayMusicLater,
      handleSearch,
      handleShowMusicAddModal,
      handleOpenMusicDetail,
      handleDislikeMusic,
    })

    const handleListItemClick = (event, index) => {
      if (rightClickSelectedIndex.value > -1) return
      handleSelectData(index)
      doubleClickPlay(index)
    }
    const handleListItemRightClick = (event, index) => {
      rightClickSelectedIndex.value = index
      showMenu(event, props.list[index], index)
    }
    const handleMenuClick = (action) => {
      let index = rightClickSelectedIndex.value
      rightClickSelectedIndex.value = -1
      menuClick(action, index)
    }
    const handleListRightClick = (event) => {
      if (!event.target.classList.contains('select')) return
      event.stopImmediatePropagation()
      let classList = dom_listContent.value.classList
      classList.add('copying')
      window.requestAnimationFrame(() => {
        let str = window.getSelection().toString()
        classList.remove('copying')
        str = str.split(/\n\n/).map(s => s.replace(/\n/g, '  ')).join('\n').trim()
        if (!str.length) return
        clipboardWriteText(str)
      })
    }
    const handleListBtnClick = ({ action, index }) => {
      switch (action) {
        case 'download':
          handleShowDownloadModal(index, true).catch(() => {})
          break
        case 'play':
          void handlePlayMusic(index, true)
          break
        case 'search':
          handleSearch(index)
          break
        case 'listAdd':
          handleShowMusicAddModal(index, true).catch(() => {})
          break
      }
    }
    const scrollToTop = () => {
      listRef.value.scrollTo(0, true)
    }

    return {
      listItemHeight,
      handleListItemClick,
      selectedList,
      handleListItemRightClick,
      removeAllSelect,
      handleListBtnClick,
      rightClickSelectedIndex,
      dom_listContent,
      listRef,

      mbzTypeText,
      titleTip,
      singerTip,
      releaseTip,
      releaseOptionText,
      mbzTrackIndexText,
      mbzSelectedReleaseId,
      groupAlbumTip,
      handleMbzGroupClick,
      handleMbzReleaseChange,
      menus,
      isShowItemMenu,
      menuLocation,
      handleMenuClick,

      handleListRightClick,
      assertApiSupport,

      isShowListAdd,
      isShowListAddMultiple,
      addMultipleList,
      selectedAddMusicInfo,

      isShowDownload,
      isShowDownloadMultiple,
      downloadMultipleList,
      selectedDownloadMusicInfo,

      scrollToTop,
      actionButtonsVisible,
    }
  },
}
</script>


<style lang="less" module>
@import '@renderer/assets/styles/layout.less';
.songList {
  overflow: hidden;
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  position: relative;
}

.list {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-flow: column nowrap;
  font-size: 14px;
}

.content {
  flex: auto;
  min-height: 0;
  position: relative;
  height: 100%;
}

.pagination {
  text-align: center;
  padding: 15px 0;
  // left: 50%;
  // transform: translateX(-50%);
}
.noitem {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  width: 100%;
  display: flex;
  flex-flow: column nowrap;
  justify-content: center;
  align-items: center;
  // background-color: var(--color-000);

  p {
    font-size: 24px;
    color: var(--color-font-label);
  }
}

.mbzExpandIcon {
  flex: none;
  font-size: 12px;
  color: var(--color-font-label);
  cursor: pointer;
  user-select: none;
}

.mbzReleaseSelect {
  display: block;
  width: 100%;
  box-sizing: border-box;
  font-size: 11px;
  color: var(--color-font);
  background-color: transparent;
  border: 1px solid var(--color-300);
  border-radius: 4px;
  padding: 1px 2px;
  cursor: pointer;
  outline: none;
}

</style>
