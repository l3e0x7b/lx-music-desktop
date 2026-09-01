import { reactive } from '@common/utils/vueTools'
import type { MbzArtist } from '@renderer/utils/musicBrainz'

export declare interface MbzListInfo {
  list: LX.Music.MusicInfo[]
  total: number
  page: number
  maxPage: number
  limit: number
  key: string | null
  noItemLabel: string
}

export declare interface SearchProgress {
  done: number
  total: number
}

export declare interface MbzSearchState {
  isSearching: boolean
  searchKey: string
  /** 作品集总数（null=未完成搜索，不展示） */
  groupTotal: number | null
  /** 当前搜索艺术家的 MBID（搜索成功时写入，供 summary 超链接到官网主页；空结果/未完成搜索为 null） */
  artistMbid: string | null
  /** 部分拉取失败：已展示部分数据，后台正在补拉（summary 后显示叹号标识） */
  partialFailed: boolean
  progress: SearchProgress
}

export const listInfo: MbzListInfo = reactive({
  page: 1,
  maxPage: 0,
  limit: 30,
  total: 0,
  list: [],
  key: null,
  noItemLabel: '',
})

export const searchState: MbzSearchState = reactive({
  isSearching: false,
  searchKey: '',
  groupTotal: null,
  artistMbid: null,
  partialFailed: false,
  progress: {
    done: 0,
    total: 0,
  },
})

export declare interface MbzArtistChoiceState {
  /** 是否显示艺术家选择下拉（重名候选） */
  visible: boolean
  /** 重名候选（rank>=2，已按 rank→score 排序，名称全等者排前） */
  candidates: MbzArtist[]
  /** 等待 UI 端回调（resolveArtistChoice）；null=当前无待选 */
  resolve: ((artist: MbzArtist | null) => void) | null
}

/** 艺术家选择下拉状态：重名时由 action.openArtistChoice 写入、UI 端 resolveArtistChoice 结算 */
export const artistChoiceState: MbzArtistChoiceState = reactive({
  visible: false,
  candidates: [],
  resolve: null,
})

export const reset = () => {
  listInfo.list = []
  listInfo.page = 1
  listInfo.maxPage = 0
  listInfo.total = 0
  listInfo.key = null
  listInfo.noItemLabel = ''
  searchState.isSearching = false
  searchState.searchKey = ''
  searchState.groupTotal = null
  searchState.artistMbid = null
  searchState.partialFailed = false
  searchState.progress.done = 0
  searchState.progress.total = 0
}
