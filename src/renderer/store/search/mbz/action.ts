import { markRaw } from '@common/utils/vueTools'
import music from '@renderer/utils/musicSdk'
import { toNewMusicInfo, formatPlayTime } from '@renderer/utils'
import { simplify } from '@renderer/utils/simplify-chinese-main'
import { similar } from '@common/utils/common'
import {
  findArtistCandidates,
  getArtistDiscography,
  groupTracks,
  type MbzArtist,
  type MbzCandidate,
  type MbzGroupFull,
  type MbzRangeResult,
} from '@renderer/utils/musicBrainz'
import { addHistoryWord, setSearchText } from '../action'
import { listInfo, searchState, reset, artistChoiceState } from './state'

const pageLimit = 30
const matchTimeout = 8000
const matchThreshold = 0.6
/** 艺术家缓存上限（超出淘汰最早插入项） */
const ARTIST_CACHE_MAX = 100
/** 平台匹配结果缓存上限 */
const MATCH_CACHE_MAX = 500
/** 未收录艺人的负缓存 TTL（短时有效，避免反复搜索同一未收录艺人时重复 /artist 请求） */
const ARTIST_NEGATIVE_TTL_MS = 10 * 60 * 1000
/** 艺术家候选正缓存 TTL（与负缓存一致：MB 数据变更后避免长会话内长期使用陈旧候选） */
const ARTIST_CACHE_TTL_MS = 10 * 60 * 1000

const abortError = () => new DOMException('The operation was aborted', 'AbortError')

/** 艺术家候选缓存：`关键词 → { 候选数组, 缓存时间 }`（含 rank，重名判定用；超出上限淘汰最早插入项） */
const artistCandidatesCache = new Map<string, { candidates: MbzArtist[], at: number }>()
/** 用户已选艺术家记忆：`关键词 → artistId`（同词二次搜索不再弹选择器） */
const chosenArtistCache = new Map<string, string>()
/** 播放时匹配结果缓存：`${source}__${candidate.key}` → 平台曲目信息（key 含版本 id，版本切换后独立匹配） */
const matchCache = new Map<string, LX.Music.MusicInfo>()
/** 进行中的匹配任务（并发去重） */
const pendingMatch = new Map<string, Promise<LX.Music.MusicInfo | null>>()
/** 最近一次搜索的作品集数据（展开/版本切换/播放匹配的数据源；新搜索或清空时替换/清空） */
let lastResult: MbzRangeResult | null = null
/** 最近一次搜索的 key（与 listInfo.key 绑定；防止清空/新搜索后旧数据仍被 findCandidate/buildGroupTracks 使用） */
let lastResultKey: string | null = null
/** 最近一次搜索的源（构建展开曲目行时写入 MusicInfo.source） */
let lastSource: LX.OnlineSource = 'kw'
/** 进行中的艺术家查询（并发去重：同一关键词快速连搜只发一次 /artist 请求） */
const pendingArtist = new Map<string, Promise<MbzArtist[] | null>>()
/** 未命中负缓存：`关键词 → 最近查询时间`（避免反复搜索未收录艺人重复打 MB /artist） */
const artistNegativeCache = new Map<string, number>()

/** 当前搜索的中断控制器：新搜索或组件卸载（切换页面/取消勾选）时中止前一个，停止 MB 拉取与结果缓存 */
let currentSearchController: AbortController | null = null

/**
 * 打开艺术家选择下拉（重名候选）：写入 artistChoiceState，等待 UI 端 resolveArtistChoice 结算
 * @returns 用户选择的艺术家；null=用户取消（外部点击关闭弹窗）
 */
const openArtistChoice = async(candidates: MbzArtist[]): Promise<MbzArtist | null> => {
  return new Promise(resolve => {
    artistChoiceState.candidates = candidates
    artistChoiceState.resolve = resolve
    artistChoiceState.visible = true
  })
}

/** 关闭艺术家选择下拉并返回结果（artist=null 表示取消） */
export const resolveArtistChoice = (artist: MbzArtist | null) => {
  if (!artistChoiceState.visible) return
  artistChoiceState.visible = false
  artistChoiceState.resolve?.(artist)
  artistChoiceState.resolve = null
  artistChoiceState.candidates = []
}

/** 关闭艺术家选择下拉（取消）：新搜索/清空搜索框/中止时调用，避免旧 promise 悬挂与弹窗残留 */
export const closeArtistChoice = () => {
  resolveArtistChoice(null)
}

/** 中止当前 mbz 搜索（组件卸载时调用；中止后不更新 UI、不写缓存） */
export const abortSearch = () => {
  closeArtistChoice()
  currentSearchController?.abort()
}

const intervalToSecond = (interval: string | null | undefined): number => {
  if (!interval) return 0
  const intvArr = interval.split(':')
  let intv = 0
  let unit = 1
  while (intvArr.length) {
    intv += parseInt(intvArr.pop() ?? '0') * unit
    unit *= 60
  }
  return intv
}

const filterStr = (str: any) => {
  return simplify(String(str ?? '')).replace(/\s|'|\.|,|，|&|"|、|\(|\)|（|）|`|~|-|<|>|\||\/|\]|\[|!|！/g, '')
}

const singersRxp = /、|&|;|；|\/|,|，|\|| feat\.|ft\./gi

const getSingerNames = (str: any): string[] => {
  return String(str ?? '').split(singersRxp).map(s => filterStr(s).toLowerCase()).filter(Boolean)
}

const hasChinese = (str: string) => /[\u4e00-\u9fff]/.test(str)

const scoreMatch = (item: any, candidate: MbzCandidate): number => {
  const songName = filterStr(item?.name).toLowerCase()
  const candName = filterStr(candidate.title).toLowerCase()
  if (!songName || !candName) return -1
  let nameScore
  if (songName == candName || songName.includes(candName) || candName.includes(songName)) {
    nameScore = 1
  } else {
    const sim = similar(songName, candName)
    if (sim < 0.5) return -1
    nameScore = sim
  }

  const candSingers = candidate.artists.map((s: string) => filterStr(s).toLowerCase()).filter(Boolean)
  const songSingers = getSingerNames(item?.singer)
  const primarySinger = candSingers[0]
  // 主歌手（专辑艺术家）未出现在平台曲目的歌手中：直接排除，避免匹配到合唱/翻唱版本
  const primaryHit = primarySinger && songSingers.some(singer => singer == primarySinger || singer.includes(primarySinger) || primarySinger.includes(singer))
  if (!primaryHit) return -1
  let singerScore = 0
  for (const cand of candSingers) {
    for (const singer of songSingers) {
      if (singer == cand || singer.includes(cand) || cand.includes(singer)) {
        singerScore = Math.max(singerScore, 1)
      } else {
        singerScore = Math.max(singerScore, similar(singer, cand) * 0.5)
      }
    }
  }

  let score = nameScore * 0.7 + singerScore * 0.3
  const duration = item?._interval ?? intervalToSecond(item?.interval)
  if (duration && candidate.duration && Math.abs(duration * 1000 - candidate.duration) <= 3000) {
    score += 0.2
  }
  return score
}

const findBestMatch = (items: any[], candidate: MbzCandidate): any => {
  let best: any = null
  let bestScore = 0
  for (const item of items) {
    const score = scoreMatch(item, candidate)
    if (score < 0) continue
    if (score > bestScore || (score == bestScore && hasChinese(item?.singer) && !hasChinese(best?.singer))) {
      best = item
      bestScore = score
    }
  }
  return bestScore >= matchThreshold ? best : null
}

const matchCandidate = async(candidate: MbzCandidate, source: LX.OnlineSource): Promise<LX.Music.MusicInfo | null> => {
  const query = `${candidate.title} ${candidate.artists[0] || ''}`.trim()
  // 平台 musicSearch SDK 无取消句柄：超时后仅放弃结果（searchTask 后台继续跑至平台自身超时）。
  // 残余请求为每个失败匹配 1 个，占用平台 API 额度有限，可接受。
  const searchTask = music[source].musicSearch.search(query, 1, pageLimit).catch(() => null)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      searchTask,
      new Promise(resolve => { timer = setTimeout(() => { resolve(null) }, matchTimeout) }),
    ])
    if (!result?.list?.length) return null
    const match = findBestMatch(result.list, candidate)
    if (!match) return null
    return markRaw(toNewMusicInfo(match))
  } catch (error) {
    console.log(error)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 播放时的即时平台匹配（结果缓存，重复点击不重复请求）
 */
export const matchOnPlay = async(candidate: MbzCandidate, source: LX.OnlineSource): Promise<LX.Music.MusicInfo | null> => {
  const key = `${source}__${candidate.key}`
  const cached = matchCache.get(key)
  if (cached) return cached
  const pending = pendingMatch.get(key)
  if (pending) return pending
  const task = (async() => {
    const match = await matchCandidate(candidate, source)
    if (match) {
      matchCache.set(key, match)
      if (matchCache.size > MATCH_CACHE_MAX) {
        const oldest = matchCache.keys().next().value
        if (oldest) matchCache.delete(oldest)
      }
    }
    return match
  })()
  pendingMatch.set(key, task)
  try {
    return await task
  } finally {
    pendingMatch.delete(key)
  }
}

/**
 * 将 MusicBrainz 候选项转换为占位曲目信息（原始数据，播放前会替换为平台匹配结果）
 */
const toMbzMusicInfo = (candidate: MbzCandidate, source: LX.OnlineSource): LX.Music.MusicInfo => {
  const info = {
    id: `mbz__${candidate.key}`,
    name: candidate.title,
    singer: candidate.artists.join(' / '),
    source,
    interval: candidate.duration ? formatPlayTime(candidate.duration / 1000) : '',
    meta: {
      songId: '',
      albumName: candidate.album,
      qualitys: [],
      _qualitys: {},
      mbzGroupId: candidate.mbzGroupId,
      mbzType: candidate.primaryType,
      mbzTrackMbid: candidate.mbid,
      mbzArtistMbid: candidate.artistMbid,
      mbzReleaseMbid: candidate.releaseMbid,
      mbzReleaseCatalog: candidate.releaseCatalog,
      mbzReleaseBarcode: candidate.releaseBarcode,
      mbzMediaFormat: candidate.mediaFormat,
    },
  }
  return markRaw(info) as LX.Music.MusicInfo
}

/**
 * 将作品集（组）转换为组行占位信息（meta.mbzGroup 内嵌版本下拉数据，供展开/选版使用）
 */
const toMbzGroupMusicInfo = (group: MbzGroupFull, source: LX.OnlineSource): LX.Music.MusicInfo => {
  const info = {
    id: `mbz_group__${group.id}`,
    name: group.title,
    singer: group.artists.join(' / '),
    source,
    interval: '',
    meta: {
      songId: '',
      albumName: group.title,
      qualitys: [],
      _qualitys: {},
      mbzGroupId: group.id,
      mbzType: group.primaryType,
      mbzArtistMbid: group.primaryArtistMbid,
      mbzGroup: {
        id: group.id,
        title: group.title,
        artists: group.artists,
        primaryType: group.primaryType,
        date: group.date,
        releases: group.releaseOptions,
      },
    },
  }
  return markRaw(info) as unknown as LX.Music.MusicInfo
}

/**
 * 生成作品集指定版本的曲目行（占位 MusicInfo；版本切换后重新生成，行 id 含版本 id）
 */
export const buildGroupTracks = (groupId: string, releaseId: string): LX.Music.MusicInfo[] => {
  if (lastResultKey !== listInfo.key) return []
  const group = lastResult?.groups.find(item => item.id == groupId)
  if (!group) return []
  return groupTracks(group, releaseId).map(candidate => toMbzMusicInfo(candidate, lastSource))
}

/**
 * 从占位曲目 id（mbz__<groupId>__<releaseId>__<mediaIdx>__<recId>）反查候选（播放匹配用；
 * 组行 id 以 mbz_group__ 开头，不匹配返回 null）
 */
export const findCandidate = (id: string): MbzCandidate | null => {
  if (!id.startsWith('mbz__')) return null
  // 旧搜索结果（清空/新搜索后 lastResult 未同步）不参与解析，避免对过期展示行返回过期候选
  if (lastResultKey !== listInfo.key) return null
  const fullKey = id.slice(5)
  const parts = fullKey.split('__')
  if (parts.length < 4) return null
  const groupId = parts[0]
  const releaseId = parts[1]
  const group = lastResult?.groups.find(item => item.id == groupId)
  if (!group) return null
  // 按 key 精确匹配（含媒体序号）：同 release 多媒体引用同一 recording 时（CD+DVD 合版），
  // 点击 DVD 行不会解析到 CD 行候选，mediaFormat 等悬浮元数据与所击行一致
  return groupTracks(group, releaseId).find(track => track.key == fullKey) ?? null
}

/**
 * 按关键词查艺术家候选数组（正缓存 + 负缓存 + in-flight 并发去重，缓存上限淘汰最旧）
 * @returns 候选数组（含 rank，已按 rank→score 排序，供重名判定与选择器使用）；null=查无此艺人（负缓存）
 * @param signal 可选中断信号：中止时在请求边界静默抛 AbortError（不写缓存），
 * 由调用方（action.search）统一处理；已被接受的中断请求本身会继续跑完
 */
const getArtistCandidates = async(text: string, signal?: AbortSignal): Promise<MbzArtist[] | null> => {
  if (signal?.aborted) throw abortError()
  const cached = artistCandidatesCache.get(text)
  if (cached && Date.now() - cached.at < ARTIST_CACHE_TTL_MS) {
    if (signal?.aborted) throw abortError()
    return cached.candidates
  }
  const negAt = artistNegativeCache.get(text)
  if (negAt && Date.now() - negAt < ARTIST_NEGATIVE_TTL_MS) return null
  const pending = pendingArtist.get(text)
  if (pending) {
    return pending.then(result => {
      if (signal?.aborted) throw abortError()
      return result
    })
  }
  const task = (async() => {
    const artists = await findArtistCandidates(text)
    if (artists.length) {
      artistCandidatesCache.set(text, { candidates: artists, at: Date.now() })
      if (artistCandidatesCache.size > ARTIST_CACHE_MAX) {
        const oldest = artistCandidatesCache.keys().next().value
        if (oldest) artistCandidatesCache.delete(oldest)
      }
      artistNegativeCache.delete(text)
    } else {
      artistNegativeCache.set(text, Date.now())
      if (artistNegativeCache.size > ARTIST_CACHE_MAX) {
        const oldest = artistNegativeCache.keys().next().value
        if (oldest) artistNegativeCache.delete(oldest)
      }
    }
    return artists.length ? artists : null
  })()
  pendingArtist.set(text, task)
  try {
    const result = await task
    if (signal?.aborted) throw abortError()
    return result
  } finally {
    pendingArtist.delete(text)
  }
}

export const search = async(text: string, source: LX.OnlineSource, page: number): Promise<LX.Music.MusicInfo[]> => {
  if (!text) {
    // 清空搜索框（v-show 隐藏，组件不卸载）：中止进行中的拉取并关闭可能打开的艺术家选择弹窗，
    // 同时清空已选艺术家记忆——用户清空后重搜同词应重新弹选择器，而非沿用旧选择
    closeArtistChoice()
    currentSearchController?.abort()
    chosenArtistCache.clear()
    reset()
    lastResult = null
    lastResultKey = null
    return []
  }
  // 新搜索替换前一个：中止旧拉取、关闭仍打开的艺术家选择弹窗（其进行中请求停止，结果丢弃、不入缓存）
  closeArtistChoice()
  currentSearchController?.abort()
  const searchController = new AbortController()
  currentSearchController = searchController
  const key = `${page}__${source}__${text}`
  searchState.searchKey = key
  searchState.isSearching = true
  searchState.groupTotal = null
  searchState.partialFailed = false
  searchState.progress.done = 0
  searchState.progress.total = 0
  listInfo.noItemLabel = window.i18n.t('list__loading')

  let artist: MbzArtist | null = null
  let loadFailed = false
  try {
    const candidates = await getArtistCandidates(text, searchController.signal)
    if (candidates?.length) {
      // 重名判定：名称或别名与搜索词「全等」的候选（rank>=2）多于 1 个 → 弹选择器让用户选择；
      // 否则自动取排序首位（含 rank 全为 0 的模糊匹配，维持现自动行为避免骚扰）
      const strong = candidates.filter(item => item.rank >= 2)
      if (strong.length > 1) {
        const rememberedId = chosenArtistCache.get(text)
        if (rememberedId) {
          artist = candidates.find(item => item.id == rememberedId) ?? strong[0]
        } else {
          artist = await openArtistChoice(strong)
          if (searchController.signal.aborted) throw abortError()
          if (!artist) {
            // 用户取消选择（关闭弹窗）：恢复搜索未开始的「搜我所想~~」提示页——
            // 清空搜索词，由 search('')/reset 现有重置链路复位（提示页仅 searchText 为空时显示）
            searchState.isSearching = false
            listInfo.noItemLabel = ''
            setSearchText('')
            return []
          }
          chosenArtistCache.set(text, artist.id)
          if (chosenArtistCache.size > ARTIST_CACHE_MAX) {
            const oldest = chosenArtistCache.keys().next().value
            if (oldest) chosenArtistCache.delete(oldest)
          }
        }
      } else {
        artist = strong[0] ?? candidates[0]
      }
    }
  } catch (error) {
    if ((error as Error)?.name == 'AbortError') {
      // 搜索已中止（切换页面/取消勾选/新搜索/清空搜索框）：静默退出，不更新 UI、不写缓存。
      // 无更新的搜索接手时复位 isSearching；被新搜索替换时由新搜索负责管理
      if (currentSearchController === searchController) {
        searchState.isSearching = false
      }
      return []
    }
    console.log(error)
    loadFailed = true
  }
  if (searchState.searchKey != key) {
    // 本搜索已过期（searchKey 已变化，说明存在更新的搜索或 reset）：isSearching 由更新的搜索（或 reset）负责复位，此处不干预
    return []
  }
  if (!artist) {
    listInfo.list = []
    listInfo.total = 0
    listInfo.page = 1
    listInfo.maxPage = 0
    listInfo.key = null
    listInfo.noItemLabel = window.i18n.t(loadFailed ? 'search__mbz_load_failed' : 'search__mbz_no_artist')
    searchState.isSearching = false
    return []
  }
  let result: MbzRangeResult | null = null
  try {
    result = await getArtistDiscography(artist.id, (done, total) => {
      if (searchState.searchKey != key) return
      searchState.progress.done = done
      searchState.progress.total = total
    }, searchController.signal)
  } catch (error) {
    if ((error as Error)?.name == 'AbortError') {
      // 搜索已中止（切换页面/取消勾选/新搜索/清空搜索框）：静默退出，不更新 UI、不写缓存。
      // 仅当无更新的搜索接手（currentSearchController 仍为本次控制器，即组件卸载/取消勾选触发的孤立中止）时
      // 复位 isSearching；被新搜索替换时由新搜索负责管理，此处不干预
      if (currentSearchController === searchController) {
        searchState.isSearching = false
      }
      return []
    }
    console.log(error)
  }
  if (searchState.searchKey != key) {
    // 本搜索已过期（searchKey 已变化，说明存在更新的搜索或 reset）：isSearching 由更新的搜索（或 reset）负责复位，此处不干预
    return []
  }
  if (!result) {
    listInfo.list = []
    listInfo.total = 0
    listInfo.page = 1
    listInfo.maxPage = 0
    listInfo.key = null
    listInfo.noItemLabel = window.i18n.t('search__mbz_load_failed')
    searchState.isSearching = false
    return []
  }
  lastResult = result
  lastResultKey = key
  lastSource = source
  searchState.groupTotal = result.groupTotal
  // 全量作品集行（不分页）：版本与曲目由用户在界面上展开/选择
  const list = result.groups.map(group => toMbzGroupMusicInfo(group, source))
  listInfo.list = list
  listInfo.total = result.groupTotal
  listInfo.page = 1
  listInfo.maxPage = 1
  listInfo.key = key
  listInfo.noItemLabel = list.length
    ? ''
    : window.i18n.t(result.failedPages > 0 || result.failedOrphans > 0 ? 'search__mbz_load_failed' : 'search__mbz_no_result')
  searchState.isSearching = false
  if (list.length) void addHistoryWord(text)
  // 部分失败：有部分数据时照常展示并标记叹号（等待后台补拉完成自动刷新）；
  // 无任何数据时 noItemLabel 已给出失败文案，不再叠加叹号，避免「无记录」与「部分失败」语义矛盾
  if ((result.failedPages > 0 || result.failedOrphans > 0) && list.length > 0) {
    searchState.partialFailed = true
    void result.refilled.then(async() => {
      // 中止后（组件卸载/取消勾选/新搜索接手）不再刷新 store：补拉独立于 signal 运行，
      // 其完成回调须显式判当前控制器与 signal 状态，避免在已卸载视图背后改写模块级状态
      if (searchController.signal.aborted) return
      if (currentSearchController !== searchController) return
      if (searchState.searchKey != key) return
      const fresh = await getArtistDiscography(artist.id, undefined, searchController.signal).catch(() => null)
      if (searchController.signal.aborted) return
      if (currentSearchController !== searchController || !fresh || searchState.searchKey != key) return
      searchState.partialFailed = fresh.failedPages > 0 || fresh.failedOrphans > 0
      lastResult = fresh
      const freshList = fresh.groups.map(group => toMbzGroupMusicInfo(group, source))
      listInfo.list = freshList
      listInfo.total = fresh.groupTotal
    })
  }
  return list
}
