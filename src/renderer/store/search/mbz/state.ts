import { reactive } from '@common/utils/vueTools'

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
  partialFailed: false,
  progress: {
    done: 0,
    total: 0,
  },
})

export const reset = () => {
  listInfo.list = []
  listInfo.page = 0
  listInfo.maxPage = 0
  listInfo.total = 0
  listInfo.key = null
  listInfo.noItemLabel = ''
  searchState.isSearching = false
  searchState.searchKey = ''
  searchState.groupTotal = null
  searchState.partialFailed = false
  searchState.progress.done = 0
  searchState.progress.total = 0
}
