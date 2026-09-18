import { httpFetch } from '../request'
import { requestMsg } from '../message'
import { cacheGet, cacheSave, cacheClearAll, type DiscographyPersist, type MbzGroupRaw, type MbzReleaseRaw } from './cache'

// 诊断日志开关：仅开发环境输出。常量须定义在本模块内（DefinePlugin 文本替换 + 同模块作用域内
// 常量折叠），生产包经 terser 摇树移除各调用点，日志字符串不进入生产包；跨模块共享常量无法折叠
const isDebug = process.env.NODE_ENV === 'development'

const baseUrl = 'https://musicbrainz.org/ws/2'
const PAGE_LIMIT = 100
/** browse 带 recordings 内联时服务端按响应体积截断，实际页大小约 25~40；仅用于进度预估 */
const PAGE_ESTIMATED_STEP = 25
/** 限流窗口：窗口内最多 MAX_CONCURRENCY 个请求开始（峰值突发 ≤ 并发上限，平均 ≈ 并发数/窗口秒） */
const RATE_WINDOW_MS = 1000
/** 429/503 降级后的保守窗口（burst=1 串行慢档，≈ 0.9 req/s） */
const RATE_WINDOW_SERIAL_MS = 1100
/** 限流器并发上限（同时在飞 ≤ 该值；孤儿组检查并发池复用） */
const MAX_CONCURRENCY = 2
/** 429/503 累计 ≥ 该值后降级为保守档（环境差时更快进入保护档） */
const RETRY_429_LIMIT = 2
/** 保守档下连续成功 ≥ 该值后恢复默认档 */
const RATE_RECOVER_AFTER = 5
/** 429/503 退避基数（指数：3s/6s/9s/12s） */
const RETRY_MS = 3000
/** 单请求响应头超时：连接 + TLS + 首字节等待。
 * 注意：用户到 MB 的链路响应常达 5-15s（disc-tracker 无超时照样成功），
 * 过短的超时会把慢响应误杀为「超时」→ 重试 → 时间爆炸。30s 仅拦真挂起 */
const TIMEOUT = 30000
/** 孤儿组检查超时（可牺牲性请求：失败即视为无官方发行，不重试；响应较小但链路延迟仍可能 5-15s） */
const ORPHAN_TIMEOUT = 15000
/** 网络类错误重试次数（退避 1s/2s） */
const NETWORK_RETRY_NUM = 2
const maxRetryNum = 3
/** 孤儿组查询并发池大小（与限流器并发上限一致，请求真实并行但受全局限流窗口约束） */
const ORPHAN_CHECK_CONCURRENCY = 2
/** 孤儿组检查失败止损：连续失败 ≥ 该值（通路持续差）时放弃剩余检查，避免拖垮整次搜索 */
const ORPHAN_FAIL_STOP = 5
/** 孤儿组检查总数预算：检查数超该值即停止，剩余组计入 failedOrphans 走后台补拉自愈。
 * 与 ORPHAN_FAIL_STOP（连续失败止损）互补：封堵「孤儿极多（合辑艺人）且网络差但非连续失败」时的长尾 */
const ORPHAN_CHECK_MAX_TOTAL = 50
/** 部分失败仍入缓存的最大失败页数（≤ 该值视为「不完整但可用」，命中后后台静默补拉；
 * 周杰伦 release 链 7 页，失败 5 页仍有 2 页可用数据，先展示 + 后台补全优于整次白等） */
const PARTIAL_CACHE_MAX_FAILED_PAGES = 5
/** 页级连续失败熔断：首页即持续失败时 total 未知、主循环无自然出口（后台补拉链甚至没有 signal），
 * 达上限即终止本链，剩余数据交由 failedPages 语义承接（部分数据可用 + 下次搜索补拉） */
const MAX_CONSECUTIVE_PAGE_FAILS = 3
/** 自动补拉循环的重试冷却（补拉失败后间隔 5 分钟自动重试一次，直至补全或被取消） */
const REFILL_COOLDOWN_MS = 5 * 60 * 1000
const UA = 'lx-music-desktop/2.12.2 (https://github.com/lyswhut/lx-music-desktop) +https://github.com/lyswhut/lx-music-desktop/issues'

const httpFetchAsync = async(url: string, options?: Record<string, any>): Promise<{ statusCode: number, body: any }> => {
  const timeout = (options?.timeout as number) ?? TIMEOUT
  // 看门狗：needle 的 response_timeout 只覆盖响应头阶段，响应体停滞时回调永不触发，
  // 用硬超时兜底保证请求必然 settle，避免全局限速队列被永久阻塞。
  // 30s + 15s：慢链路下响应头 + 响应体共 45s 内传完都算成功（disc-tracker 无超时照样成功，
  // 过早兜底会把慢响应误杀为超时导致重试爆炸）
  let timer: ReturnType<typeof setTimeout> | undefined
  let requestObj: { promise: Promise<unknown>, cancelHttp?: () => void } | null = null
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // 看门狗接管后同时中止底层 needle 请求（响应体停滞场景），避免连接占用拖延全局限流队列；
      // 正常完成路径下 requestObj 已完结，cancelHttp 为空操作
      requestObj?.cancelHttp?.()
      reject(new Error(requestMsg.timeout))
    }, timeout + 15000)
  })
  try {
    requestObj = httpFetch(url, options) as any
    // requestObj 在 try 内已赋值，watchdog 回调里通过 cancelHttp 中止的是同一对象
    return await Promise.race([
      requestObj!.promise as any,
      watchdog,
    ])
  } finally {
    clearTimeout(timer)
  }
}

const sleep = async(ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * 全局限速器：滑动窗口限流——窗口（windowMs）内最多 burst 个请求开始，且在飞请求 ≤ burst
 * （峰值突发 ≈ 并发上限，平均 ≈ 并发上限/窗口；429/503 累计 → 降级为 burst=1 串行慢档，
 * 连续成功 → 自动回升默认档，避免一次繁忙窗口拖慢整个后续过程）
 */
const rateState = { windowMs: RATE_WINDOW_MS, burst: MAX_CONCURRENCY, retry429Count: 0, consecutiveOk: 0, lastDowngradeAt: 0 }
let inFlight = 0
let windowStart = 0
let windowCount = 0

const limiter = async <T,>(task: () => Promise<T>): Promise<T> => {
  while (true) {
    const now = Date.now()
    if (now - windowStart >= rateState.windowMs) {
      windowStart = now
      windowCount = 0
    }
    if (inFlight < rateState.burst && windowCount < rateState.burst) break
    await sleep(50)
  }
  windowCount++
  inFlight++
  try {
    return await task()
  } finally {
    inFlight--
  }
}

const apiFetch = async(url: string, retryNum = 0, timeout = TIMEOUT): Promise<any> => {
  if (retryNum > maxRetryNum) throw new Error('MB request failed')
  let resp: { statusCode: number, body: any }
  try {
    // 单次请求在限流队列内执行；重试在本次请求结束后重新入队，避免在队列内递归导致死锁
    resp = await limiter(async() => {
      return httpFetchAsync(url, {
        headers: {
          'User-Agent': UA,
        },
        timeout,
      })
    })
  } catch (error) {
    // 网络类错误（超时/连接中断）：短退避重试（1s/2s），网络差时避免一次失败就丢页
    const message = (error as Error)?.message
    if (message == requestMsg.timeout || message == requestMsg.unachievable || message == requestMsg.notConnectNetwork ||
        message?.includes('ECONNRESET')) {
      if (retryNum < NETWORK_RETRY_NUM) {
        await sleep(1000 * (retryNum + 1))
        return apiFetch(url, retryNum + 1, timeout)
      }
    }
    throw error
  }
  if (resp.statusCode === 429 || resp.statusCode === 503) {
    rateState.retry429Count++
    rateState.consecutiveOk = 0
    if (rateState.retry429Count >= RETRY_429_LIMIT && (rateState.burst > 1 || rateState.windowMs != RATE_WINDOW_SERIAL_MS)) {
      rateState.burst = 1
      rateState.windowMs = RATE_WINDOW_SERIAL_MS
      rateState.lastDowngradeAt = Date.now()
    }
    // 服务器繁忙（429/503）：指数退避重试（3s/6s/9s/12s），避开瞬时繁忙窗口
    await sleep(RETRY_MS * (retryNum + 1))
    return apiFetch(url, retryNum + 1, timeout)
  }
  if (resp.statusCode >= 400) throw new Error(`MB request error: ${resp.statusCode}`)
  // 连续成功回升：保守档下达标即恢复默认档（窗口回落、突发回满、429 计数一并归零，
  // 避免恢复后首次 429 因残留计数立即再次降档——P3-4）
  if (rateState.burst < MAX_CONCURRENCY || rateState.windowMs > RATE_WINDOW_MS) {
    rateState.consecutiveOk++
    if (rateState.consecutiveOk >= RATE_RECOVER_AFTER) {
      rateState.burst = MAX_CONCURRENCY
      rateState.windowMs = RATE_WINDOW_MS
      rateState.consecutiveOk = 0
      rateState.retry429Count = 0
    }
  } else {
    rateState.consecutiveOk = 0
  }
  return resp.body
}

export interface MbzArtist {
  id: string
  name: string
  /** 排序名（Sort name，如 "Wong, Faye"） */
  sortName: string
  /** 类型（Person/Group 等） */
  type: string
  /** 性别（首字母大写，如 Female/Male） */
  gender: string
  /** 地区名（如 Hong Kong/Taiwan） */
  area: string
  /** 出道/成立时间（life-span.begin，如 1969-08-08） */
  begin: string
  /** 匹配得分：名称全等 +3；否则 名称包含 +1 / 别名全等 +2；rank>=2 视为与搜索词全等命中（重名判定用）。
   * 名称全等时不再叠加别名全等分（别名多为名称的大小写变体，双计会把同分档艺人挤到首位、
   * 偏离官网 score 顺序，如 "Twins" 的 US TWINS 艺人 rank5 压过 score=100 的香港 Twins） */
  rank: number
}

/** 标题兜底：仅保留非空检查——MV/花絮轨亦按原始数据如实展示
 * （如《11月的蕭邦》TW 版 VCD 轨 "夜曲MV"；媒体类型由曲目行 Format 标签区分，
 * 是否播放匹配交给用户取舍）。不做标题关键词过滤 */

export interface MbzCandidate {
  key: string
  title: string
  artists: string[]
  /** 主歌手（专辑主艺术家）MBID，供悬浮提示展示 */
  artistMbid: string
  /** 专辑名（选中版本 release 的实际标题，如跨時代 TW 版 "跨时代"；缺失回退组标题） */
  album: string
  /** 所属作品集（release group）MBID，供悬浮提示展示 */
  mbzGroupId: string
  /** 曲目所在版本（release）MBID，供悬浮提示展示 */
  releaseMbid: string
  /** 曲目所在版本目录号（"[none]" 等占位清洗为空），供悬浮提示展示 */
  releaseCatalog: string
  /** 曲目所在版本条码（"[none]" 等占位清洗为空），供悬浮提示展示 */
  releaseBarcode: string
  /** 作品集类型（Album/EP/Single/Other 等） */
  primaryType: string
  /** 曲目来源媒体格式（CD/DVD 等，曲目行标签展示，与版本 trackCount 逐媒体对应） */
  mediaFormat: string
  duration: number
  mbid: string
}

/** 版本下拉展示用精简结构（数据来自 browse 响应派生，不含曲目） */
export interface MbzGroupRelease {
  id: string
  /** 媒体格式（多碟以 + 连接；Digital Media 缩略为 Digital） */
  format: string
  /** 各媒体曲目数原始展示（如 "10+7"；无媒体为空串） */
  trackCount: string
  /** 发行地区代码（如 TW） */
  country: string
  date: string
  /** 音质标记（"high"/"normal"，下拉选项高音质前缀 ● 标识） */
  quality: string
  /** 发行厂牌（"[none]" 等占位清洗为空） */
  label: string
  /** 目录号（"[none]" 等占位清洗为空） */
  catalog: string
  barcode: string
}

export interface MbzGroupFull {
  id: string
  title: string
  /** 主艺术家（同组 release 共享的 artist-credit） */
  artists: string[]
  /** 主艺术家 MBID（与候选曲目 extractTracks 的 artistMbid 同源同逻辑：专辑主艺术家，合辑跳过 Various Artists） */
  primaryArtistMbid: string
  /** 作品集首次发行日期（官方版本最早日期优先，防 Withdrawn 污染组日期） */
  date: string
  primaryType: string
  /** 副类型（排序与官网 Discography 组合小节一致） */
  secondaryTypes: string[]
  /** 官方发行版本池（status == Official，无 Official 时回退全部），按官网列表排序（date → country → barcode） */
  releases: MbzReleaseRaw[]
  /** 下拉展示结构（与 releases 同序） */
  releaseOptions: MbzGroupRelease[]
}

export interface MbzRangeResult {
  /** 全量作品集（已按类型/日期聚合排序，未匹配平台） */
  groups: MbzGroupFull[]
  /** 有效作品集（release-group）总数 */
  groupTotal: number
  /** 本次调用内加载失败的页数（>0 表示部分数据缺失；仅统计 release/group 两条 browse 链的页级失败，不含孤儿组失败） */
  failedPages: number
  /** 孤儿组（release browse 未覆盖、另行检查 Official 的组）检查失败的组数（请求失败/止损放弃；>0 表示部分孤儿组缺失） */
  failedOrphans: number
  /** 后台补拉完成信号：failedPages>0 或 failedOrphans>0 时由 loadDiscography 自动触发的 refill 完成 promise（无补全时立即 resolved） */
  refilled: Promise<void>
}

interface AggregatedDiscography {
  groups: MbzGroupFull[]
}

interface DiscographyCache {
  raw: { releases: MbzReleaseRaw[], groups: MbzGroupRaw[], orphanOfficial: string[] }
  aggregated: AggregatedDiscography
  failedPages: number
  failedOrphans: number
}

const artistCache = new Map<string, DiscographyCache>()
/** 会话内内存缓存上限（超出淘汰最早插入项，避免长会话内存无界增长） */
const ARTIST_CACHE_MAX = 10

const artistCacheSet = (artistId: string, cache: DiscographyCache) => {
  // 先 delete 再 set（真 LRU）：Map.set 对已存在的 key 只更新值、不改变插入顺序，
  // 补拉重设现有条目时其仍会被当作「最早插入」淘汰（刚刷新的数据被挤出，下次搜索又需重拉）
  artistCache.delete(artistId)
  artistCache.set(artistId, cache)
  if (artistCache.size > ARTIST_CACHE_MAX) {
    const oldest = artistCache.keys().next().value
    if (oldest) artistCache.delete(oldest)
  }
}

/**
 * 按艺术家名查询 MusicBrainz 艺术家候选（支持中文/别名）
 * 使用默认字段带引号精确短语查询（与官网简单搜索同口径：默认字段覆盖艺术家名与别名，
 * 精确命中得最高分排首位；带引号短语保持多词精确，无「Chou Chou」类分词噪声）。
 * 结果再按「名称/别名精确匹配」加权排序兜底。
 * 注：显式字段短语 `artist:"x" OR alias:"x"` 对常用英文词（如 "Twins"）会把
 * 名字全等的目标艺人压到 20 位开外，被 limit 截断（官网默认口径则列首位，实测 8 组名字全中）
 * @param artistName 艺术家名或别名
 * @returns 艺术家候选列表（按匹配度排序）
 */
export const findArtistCandidates = async(artistName: string): Promise<MbzArtist[]> => {
  const name = artistName.trim()
  if (!name) return []
  const escaped = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const query = `"${escaped}"`
  const url = `${baseUrl}/artist?query=${encodeURIComponent(query)}&fmt=json&limit=25&inc=aliases`
  const body = await apiFetch(url)
  if (!body?.artists?.length) return []
  const target = name.toLowerCase()
  return (body.artists as any[])
    .map((item: any) => {
      const aliases: any[] = ((item.aliases ?? []) as any[]).map((alias: any) => alias.name).filter(Boolean)
      const lowerName = String(item.name ?? '').toLowerCase()
      let rank = 0
      if (lowerName == target) {
        rank += 3
      } else {
        if (lowerName.includes(target)) rank += 1
        if (aliases.some(alias => alias.toLowerCase() == target)) rank += 2
      }
      const gender = String(item.gender ?? '')
      const artist: MbzArtist = {
        id: item.id,
        name: item.name,
        sortName: item['sort-name'] ?? '',
        type: item.type ?? '',
        gender: gender ? gender.charAt(0).toUpperCase() + gender.slice(1) : '',
        area: item.area?.name ?? '',
        begin: item['life-span']?.begin ?? '',
        rank,
      }
      return { artist, score: item.score ?? 0 }
    })
    .sort((a, b) => b.artist.rank - a.artist.rank || b.score - a.score)
    .map(item => item.artist)
}

const isVarious = (name: string) => /^various(?:\s+artists?)?$/i.test(name) || /^v\.?a\.?$/i.test(name)

/** 官网「官方发行」判定（musicbrainz-server 物化表 unofficial 口径）：
 * Official(1) / Withdrawn(5) / 未填状态(null，官网视为默认 Official) */
const isOfficialStatus = (status?: string | null): boolean => status === 'Official' || status === 'Withdrawn' || status == null

/** 可选择的真实版本（下拉/孤儿回填）：Official 或未填状态（null）；排除 Bootleg/Promotion/Withdrawn/Pseudo-Release */
const isSelectableStatus = (status?: string | null): boolean => status === 'Official' || status == null

/** 官方组判定：组内存在 Official/Withdrawn 版本即视为官方组 */
const groupHasOfficial = (releases: MbzReleaseRaw[]): boolean =>
  releases.some(release => isOfficialStatus(release.status))

/** 官网 Discography 主类型小节顺序（Album → EP → Single → …） */
const PRIMARY_TYPE_ORDER = ['Album', 'EP', 'Single', 'Compilation', 'Live', 'Other', 'Broadcast']
/** MB 副类型 id（组合小节按 id 升序签名排序，如 Album+Compilation 先于 Album+Soundtrack） */
const SECONDARY_TYPE_IDS: Record<string, number> = {
  Compilation: 1,
  Soundtrack: 2,
  Spokenword: 3,
  Interview: 4,
  Audiobook: 5,
  Live: 6,
  Remix: 7,
  'DJ-mix': 8,
  'Mixtape/Street': 9,
  Demo: 10,
  'Audio drama': 11,
  'Field recording': 12,
}

/** 官网组合小节签名：主类型序号 + 副类型 id 升序，用于分类排序 */
const typeSignature = (group: MbzGroupFull): string => {
  const primaryIdx = PRIMARY_TYPE_ORDER.indexOf(group.primaryType)
  const primary = String(primaryIdx < 0 ? PRIMARY_TYPE_ORDER.length : primaryIdx).padStart(2, '0')
  const secondaries = [...group.secondaryTypes]
    .map(type => SECONDARY_TYPE_IDS[type] ?? 99)
    .sort((a, b) => a - b)
    .map(id => String(id).padStart(2, '0'))
    .join('')
  return `${primary}${secondaries}`
}

/**
 * 发行日期比较：缺失部分视为更大（仅精确到年份的版本排在有完整日期的版本之后，与官网列表一致）
 */
const compareReleaseDate = (a: string, b: string): number => {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const pa = a.split('-').map(Number)
  const pb = b.split('-').map(Number)
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 999
    const vb = pb[i] ?? 999
    if (va != vb) return va < vb ? -1 : 1
  }
  return 0
}

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' })

/** 发行地区 ISO 代码 → 官网排序用的英文地区名（与 musicbrainz-server area.name 排序一致；
 * XW 为 MB 对全球数字发行的占位代码，官网 area 名为 Worldwide；未知代码回退原文） */
const countryName = (code?: string): string => {
  if (!code) return ''
  if (code == 'XW') return 'Worldwide'
  try {
    return countryNames.of(code) ?? code
  } catch {
    return code
  }
}

/**
 * 官网 release-group 页面 Release 列表排序：date → country（英文名，空排后）→ barcode（空排后）→ MBID 兜底
 * （官网排序键完全一致时可编程复现；barcode 并列时官网为数据库物理序不可编程，用 MBID 兜底，用户可自行选择）
 */
const sortReleasesForGroup = (list: MbzReleaseRaw[]): MbzReleaseRaw[] => [...list].sort((a, b) => {
  const dateDiff = compareReleaseDate(a.date ?? '', b.date ?? '')
  if (dateDiff != 0) return dateDiff
  const ca = countryName(a.country)
  const cb = countryName(b.country)
  if (!ca && !cb) {
    // 平
  } else if (!ca) {
    return 1
  } else if (!cb) {
    return -1
  } else if (ca != cb) {
    return ca < cb ? -1 : 1
  }
  const ba = a.barcode ?? ''
  const bb = b.barcode ?? ''
  if (ba != bb) return ba ? (bb ? (ba < bb ? -1 : 1) : -1) : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
})

const cleanPlaceholder = (value?: string | null): string => {
  const str = (value ?? '').trim()
  return !str || str.toLowerCase() == '[none]' ? '' : str
}

/** 版本下拉展示数据派生（browse 响应 → MbzGroupRelease） */
const deriveReleaseInfo = (release: MbzReleaseRaw): MbzGroupRelease => {
  const mediaFormats: string[] = []
  const mediaCounts: number[] = []
  for (const media of release.media ?? []) {
    if (media.format) mediaFormats.push(media.format == 'Digital Media' ? 'Digital' : media.format)
    if (media['track-count']) mediaCounts.push(media['track-count'])
  }
  const labelInfo = (release['label-info'] ?? [])[0]
  return {
    id: release.id,
    format: mediaFormats.join('+'),
    trackCount: mediaCounts.join('+'),
    country: release.country ?? '',
    date: release.date ?? '',
    quality: release.quality ?? '',
    label: cleanPlaceholder(labelInfo?.label?.name),
    catalog: cleanPlaceholder(labelInfo?.['catalog-number']),
    barcode: cleanPlaceholder(release.barcode),
  }
}

/** 曲目提取缓存：`(groupId, releaseId)` → 曲目候选（版本下拉数据在 result 生命周期内不变，避免展开/切换/匹配时反复全量 extractTracks） */
const groupTracksCache = new Map<string, MbzCandidate[]>()
/** 曲目提取缓存上限（超出淘汰最早插入项） */
const GROUP_TRACKS_CACHE_MAX = 200

/**
 * 提取作品集指定版本（release）的曲目候选（未匹配平台；结果按 (groupId, releaseId) 缓存）
 * @param releaseId 版本 MBID；未指定或找不到时取官网序第一行版本
 */
export const groupTracks = (group: MbzGroupFull, releaseId?: string): MbzCandidate[] => {
  const release = group.releases.find(item => item.id == releaseId) ?? group.releases[0]
  if (!release) return []
  const cacheKey = `${group.id}__${release.id}`
  const cached = groupTracksCache.get(cacheKey)
  if (cached) return cached
  const tracks = extractTracks({ id: group.id, title: group.title, primaryType: group.primaryType }, release)
  groupTracksCache.set(cacheKey, tracks)
  if (groupTracksCache.size > GROUP_TRACKS_CACHE_MAX) {
    const oldest = groupTracksCache.keys().next().value
    if (oldest) groupTracksCache.delete(oldest)
  }
  return tracks
}

/**
 * 从组内指定版本（release）提取曲目（同版本内按录音去重）
 * @param group 轻量组信息（id/title，曲目行的专辑名与组 MBID 来源）
 */
const extractTracks = (group: { id: string, title: string, primaryType: string }, release: MbzReleaseRaw): MbzCandidate[] => {
  const tracks: MbzCandidate[] = []
  const albumCredits = (release['artist-credit'] ?? []).filter(credit => credit.artist?.id)
  const albumArtists = albumCredits.map(credit => credit.name).filter(Boolean)
  // 主歌手取专辑主艺术家；合辑（Various Artists）时回退为曲目主唱
  const albumPrimary = albumArtists.find(name => !isVarious(name)) ?? ''
  const seen = new Set<string>()
  release.media?.forEach((media, mediaIdx) => {
    // 所有媒体都参与提取（CD+VCD/DVD 合版逐轨展示，配合曲目行 Format 标签）；
    // 不再整媒体跳过（如《范特西》JP 版 CD[10]+DVD[13] 的 13 个 DVD 轨需展示），
    // 视频轨由 recording.video / 标题关键词过滤——多碟合版内容由用户自行取舍
    for (const track of media.tracks ?? []) {
      const recording = track.recording
      if (!recording) continue
      // 标题取媒体内曲目名（track.title，版本本地化语言差异的来源，如 CN 简体/JP 日文），
      // 缺失时回退共享录音标题（recording.title，常为繁体中文）
      const title = ((track.title ?? recording.title) ?? '').trim()
      // 只要标题非空即展示：MV/花絮轨亦按原始数据如实展示（如《11月的蕭邦》TW 版 VCD 轨 "夜曲MV"），
      // 媒体类型由曲目行 Format 标签区分；recording.video 不排除（多碟合版的 DVD/VCD 轨需全部展示）
      if (!title) continue
      // 候选键含作品集 id、版本 id、媒体序号与录音 id：同一录音跨媒体/跨版本各自独立（版本/媒体切换后 key 变化）
      const key = `${group.id}__${release.id}__${mediaIdx}__${recording.id}`
      if (seen.has(key)) continue
      seen.add(key)
      const trackCredits = (track['artist-credit'] ?? recording['artist-credit'] ?? []).filter(credit => credit.artist?.id)
      const trackArtists = trackCredits.map(credit => credit.name).filter(Boolean)
      const primary = albumPrimary || (trackArtists[0] ?? '')
      const artists = [primary, ...new Set([...albumArtists, ...trackArtists].filter(name => name != primary && !isVarious(name)))].filter(Boolean)
      if (!artists.length) continue
      // 主歌手 MBID：优先专辑主艺术家，缺失时回退曲目首个署名
      const primaryCredit = albumCredits.find(credit => credit.name == primary) ?? trackCredits.find(credit => credit.name == primary)
      tracks.push({
        key,
        title,
        artists,
        artistMbid: primaryCredit?.artist?.id ?? '',
        album: release.title?.trim() || group.title,
        mbzGroupId: group.id,
        releaseMbid: release.id,
        releaseCatalog: cleanPlaceholder(release['label-info']?.[0]?.['catalog-number']),
        releaseBarcode: cleanPlaceholder(release.barcode),
        primaryType: group.primaryType,
        mediaFormat: media.format ?? '',
        duration: recording.length ?? 0,
        mbid: recording.id,
      })
    }
  })
  return tracks
}

/**
 * 全量 releases 拉取页（曲目 recordings 内联，release-group 引用一并带回）
 */
const fetchReleasePage = async(artistId: string, offset: number): Promise<{ items: MbzReleaseRaw[], count: number }> => {
  const url = `${baseUrl}/release?artist=${artistId}&fmt=json&limit=${PAGE_LIMIT}&offset=${offset}&inc=recordings+release-groups+artist-credits+labels`
  const body = await apiFetch(url, 0, TIMEOUT)
  return { items: body?.releases ?? [], count: body?.['release-count'] ?? 0 }
}

/**
 * release-group 元数据页（标题/日期/类型；专辑名以主版本 release 标题为准，不需要别名）
 */
const fetchGroupMetaPage = async(artistId: string, offset: number): Promise<{ items: MbzGroupRaw[], count: number }> => {
  const url = `${baseUrl}/release-group?artist=${artistId}&fmt=json&limit=${PAGE_LIMIT}&offset=${offset}&inc=artist-credits`
  const body = await apiFetch(url, 0, TIMEOUT)
  return { items: body?.['release-groups'] ?? [], count: body?.['release-group-count'] ?? 0 }
}

/**
 * 逐页 browse 直到取满 count 或空页（页级容错：失败页记录后跳过；连续失败达上限熔断终止本链，
 * 剩余缺失由 failedPages 上抛、后台自动补拉循环（startRefillLoop）补齐）
 * 带 recordings 内联时服务端会按响应体积截断（页大小不定），因此以「实际返回条数」推进 offset，
 * 保证不因页大小变化漏数据
 * @param fetchPage 按 offset 拉取一页（offset 为条目索引）
 * @param collect 收集一页条目
 * @param pageStep 预估步长与失败页默认步进（release 链带 recordings 内联被截断，用 PAGE_ESTIMATED_STEP；release-group 链为满页，用 PAGE_LIMIT）
 * @param signal 中断信号（中止时停止发起后续请求并抛 AbortError，供上层丢弃结果）
 * @returns 熔断/补拉后仍未成功的页数（>0 表示部分数据缺失）
 */
const browseAllPages = async <T,>(
  fetchPage: (offset: number) => Promise<{ items: T[], count: number }>,
  collect: (items: T[]) => void,
  pageStep = PAGE_ESTIMATED_STEP,
  signal?: AbortSignal,
): Promise<{ failedPages: number }> => {
  let offset = 0
  let total = 0
  // 最近一次成功页的实际长度：失败页按此近似跳过，避免大步进漏更多数据；
  // 首页失败时无成功页可参考，按 pageStep（约等于实际页长量级）近似
  let lastPageLen = pageStep
  // 主趟失败页 offset 集合：服务器繁忙窗口（超时/503）可能持续数分钟，
  // 不中断整条链；持续不可用时由下方连续失败熔断兜底终止。
  // 仅用于统计失败页数（failedPages），无需记录步长
  const failedOffsets = new Set<number>()
  let consecutiveFails = 0
  while (true) {
    if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
    let items: T[]
    let count: number
    try {
      const page = await fetchPage(offset)
      items = page.items
      count = page.count
    } catch (error) {
      isDebug && console.log('[mbz] page failed:', (error as Error)?.message ?? error)
      failedOffsets.add(offset)
      // 连续失败熔断：total 未知（无任何成功页）或持续繁忙时主循环没有自然出口，
      // 达上限即 break 终止本链——已收集数据保留，缺失计入 failedPages 由后台补拉承接
      if (++consecutiveFails >= MAX_CONSECUTIVE_PAGE_FAILS) break
      // 失败页的实际页长未知，按上一成功页的实际长度近似跳过（页级容错，代价是少量漏项，由 failedPages 上抛）
      offset += lastPageLen
      continue
    }
    consecutiveFails = 0
    collect(items)
    lastPageLen = items.length || lastPageLen
    offset += items.length
    if (!total) total = count
    // R8：正常终点是「offset 收敛到 total」或空页即尽头；若服务端异常返回空页但计数仍在 offset 之后
    // （如翻页期间数据漂移/响应被截空），按失败页计数并终止，避免静默丢数据且无人知
    if (!items.length && count > offset) failedOffsets.add(offset)
    if (!items.length || (total && offset >= total)) break
  }
  // 补拉由外层 getArtistDiscography → startRefillLoop 后台异步完成，不在此阻塞
  return { failedPages: failedOffsets.size }
}

/**
 * 孤儿组检查：作品集归属该艺人但其 release 未出现在 release browse 中
 * （如 release 署名 Various Artists 的合辑），查询该组全量 release（不做官方预过滤，
 * 官方与否由调用方按 groupHasOfficial 口径判定）。
 * 返回的 releases 带 recordings 内联（曲目/悬浮数据可直接用），由调用方并入全量列表
 * @returns 全量 releases；[]=无任何 release；null=请求失败（超时/网络，调用方按失败计数，可止损跳过）
 */
const checkGroupOfficial = async(groupId: string): Promise<MbzReleaseRaw[] | null> => {
  try {
    const url = `${baseUrl}/release?release-group=${groupId}&fmt=json&limit=${PAGE_LIMIT}&inc=recordings+artist-credits+labels`
    const body = await apiFetch(url, 0, ORPHAN_TIMEOUT)
    return body?.releases as MbzReleaseRaw[] ?? []
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    isDebug && console.log('[mbz] orphan check failed:', (error as Error)?.message ?? error)
    return null
  }
}

/**
 * 拉取该艺术家全部 releases 与 release-group 元数据（页级 browse + 页级容错 + 全局限流）
 * releases（曲目内联）与 release-group 元数据两条分页链并行推进（共享滑动窗口限流器）
 * 孤儿组（组归属艺人但无 release 落入 release browse，如版本署名 Various Artists 的合辑）
 * 全量轻量查询 Official 状态（与官网 Discography 口径一致，不因限流降档或数量而跳过）：
 * 并发池化（真实并行，受全局限流器窗口约束）；检查失败/止损跳过的组计入 failedOrphans，
 * 由上层「部分失败叹号 + 后台补拉」自愈，避免静默丢失
 * 防御门槛：release 链整体失败（releases 为空）时，全部组都会误判为孤儿，逐组重查询会放大请求风暴——
 * 该情形直接跳过逐组检查、将全部孤儿计入 failedOrphans，交由后台补拉在通路恢复后自愈
 * @param signal 中断信号：中止时停止发起后续请求并抛 AbortError（上层丢弃结果、不入缓存）
 */
const fetchDiscography = async(artistId: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<{ releases: MbzReleaseRaw[], groups: MbzGroupRaw[], orphanOfficial: string[], failedPages: number, failedOrphans: number }> => {
  // 软重置：降级后超过 30s 无新降级，恢复默认档（避免前次搜索的繁忙状态拖累本次搜索）
  if (rateState.burst == 1 && rateState.lastDowngradeAt && Date.now() - rateState.lastDowngradeAt > 30000) {
    rateState.burst = MAX_CONCURRENCY
    rateState.windowMs = RATE_WINDOW_MS
    rateState.retry429Count = 0
    rateState.consecutiveOk = 0
  } else {
    rateState.retry429Count = 0
    rateState.consecutiveOk = 0
  }
  const releases: MbzReleaseRaw[] = []
  const groups: MbzGroupRaw[] = []
  // 按 id 去重：补拉趟与主趟在「失败页真实页长 > 近似步长」时可能重叠
  const seenReleaseIds = new Set<string>()
  const seenGroupIds = new Set<string>()
  const releaseGroupIds = new Set<string>()
  /** release 链中已确认含 Official 发行的组（与 aggregateDiscography 的 official 判定口径一致，不含孤儿组） */
  const officialGroupIds = new Set<string>()
  /** 已确认官方组数 = officialGroupIds ∩ group browse 已收组（排除反向孤儿：release 链引用了但组链未返回的组，最终结果同样不含它们） */
  const confirmedOfficialCount = () => {
    let count = 0
    for (const id of officialGroupIds) {
      if (seenGroupIds.has(id)) count++
    }
    return count
  }
  // done（已确认官方组数）与 total（group 链已收组数）来自两条并行分页链，
  // 中途 done 可能暂时超过 total：收敛到 total 以内，避免进度条瞬时倒挂/超 100%
  const reportGroupProgress = () => {
    // 组链首页返回前 groups 为空：不回调，避免进度条瞬时显示 0/1 后再被真实作品集数接管
    if (!groups.length) return
    const total = groups.length
    onProgress?.(Math.min(confirmedOfficialCount(), total), total)
  }
  const [releaseResult, groupResult] = await Promise.all([
    browseAllPages(
      async offset => fetchReleasePage(artistId, offset),
      items => {
        for (const item of items) {
          if (seenReleaseIds.has(item.id)) continue
          seenReleaseIds.add(item.id)
          releases.push(item)
          const groupId = item['release-group']?.id
          if (groupId) {
            releaseGroupIds.add(groupId)
            if (isOfficialStatus(item.status)) officialGroupIds.add(groupId)
          }
        }
        reportGroupProgress()
      },
      PAGE_ESTIMATED_STEP,
      signal,
    ),
    browseAllPages(
      async offset => fetchGroupMetaPage(artistId, offset),
      items => {
        for (const item of items) {
          if (seenGroupIds.has(item.id)) continue
          seenGroupIds.add(item.id)
          groups.push(item)
        }
        reportGroupProgress()
      },
      PAGE_LIMIT,
      signal,
    ),
  ])
  const orphanOfficial: string[] = []
  /** 孤儿检查失败（请求失败/止损放弃）的组数：单独计数，由「叹号 + 后台补拉」自愈，避免静默丢失 */
  let failedOrphans = 0
  const orphans = groups.filter(group => !releaseGroupIds.has(group.id)).map(group => group.id)
  if (orphans.length) {
    if (!releases.length) {
      // 防御门槛：release 链整体失败（releases 空）时，全部组都被误判为孤儿，
      // 逐组重查询会把慢网络下的一次失败放大成「组数量级」请求风暴。
      // 此时全部孤儿直接计入 failedOrphans，交由后台补拉在通路恢复后重拉自愈。
      failedOrphans = orphans.length
      onProgress?.(confirmedOfficialCount(), groups.length)
    } else {
      // 孤儿组检查并入进度：以「已确认组数 / 总作品集数」推进（done 不含 release 链未覆盖的孤儿，
      // 随逐个检查增加；进度钳制到 total 以内，避免倒挂/超 100%）
      let checked = 0
      let index = 0
      let stopped = false
      let failStreak = 0
      const worker = async() => {
        while (index < orphans.length && !stopped && checked < ORPHAN_CHECK_MAX_TOTAL) {
          if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
          // 失败止损：连续失败过多说明通路持续差，剩余检查大概率继续失败，放弃避免拖垮整次搜索；
          // 放弃的组计入 failedOrphans，待后台补拉在通路恢复后补齐
          if (failStreak >= ORPHAN_FAIL_STOP) {
            stopped = true
            break
          }
          const groupId = orphans[index++]
          const result = await checkGroupOfficial(groupId)
          if (result === null) {
            // eslint-disable-next-line require-atomic-updates
            failStreak++
            // eslint-disable-next-line require-atomic-updates
            failedOrphans++
          } else {
            // eslint-disable-next-line require-atomic-updates
            failStreak = 0
            if (groupHasOfficial(result)) {
              orphanOfficial.push(groupId)
              // 回填孤儿组可选择的真实版本（Official 或 null，含 recordings）：与 release browse 结果同池，
              // 孤儿组因此获得版本下拉/展开能力（该组 release 的 artist-credit 非本艺人，不会污染其他组）。
              // 注意：browse by release-group 响应不含 release-group 引用，需显式补上（聚合按此分组）
              for (const release of result) {
                if (!isSelectableStatus(release.status)) continue
                if (seenReleaseIds.has(release.id)) continue
                seenReleaseIds.add(release.id)
                if (!release['release-group']) release['release-group'] = { id: groupId }
                releases.push(release)
              }
            }
          }
          checked++
          onProgress?.(Math.min(confirmedOfficialCount() + orphanOfficial.length, groups.length), groups.length)
        }
      }
      // worker 仅可能以 AbortError 拒绝（checkGroupOfficial 已吞掉其余错误）：
      // Promise.all 提前拒绝后其余 worker 的 AbortError 将无人消费，静默避免 unhandled rejection，
      // 中止语义由 Promise.all 之后的 signal 复查保证
      await Promise.all(Array.from({ length: Math.min(ORPHAN_CHECK_CONCURRENCY, orphans.length) }, async() => worker().catch(error => {
        if ((error as Error)?.name != 'AbortError') isDebug && console.log(error)
      })))
      if (signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      if (checked < orphans.length) {
        // 提前退出（连续失败止损或超总数预算）：剩余未检查的组计入失败（等待后台补拉），
        // 进度按已确认官方数收敛（最终由 loadDiscography 修正为实际聚合结果）
        failedOrphans += orphans.length - checked
        onProgress?.(Math.min(confirmedOfficialCount() + orphanOfficial.length, groups.length), groups.length)
      }
    }
  }
  const failedPages = releaseResult.failedPages + groupResult.failedPages
  return { releases, groups, orphanOfficial, failedPages, failedOrphans }
}

/**
 * 本地聚合：以 release-group browse（组归属该艺人）为作品集来源 →
 * 组内 releases 存在 Official 状态（孤儿组则查 orphanOfficial）→ 组保留全部官方发行版本
 * （官网序 date → country → barcode），版本由用户在下拉中自选 → 组排序（类型小节 → 日期 → 标题）
 */
const aggregateDiscography = (releases: MbzReleaseRaw[], groupRawList: MbzGroupRaw[], orphanOfficial: Set<string> = new Set()): AggregatedDiscography => {
  const releasesByGroup = new Map<string, MbzReleaseRaw[]>()
  for (const release of releases) {
    const groupId = release['release-group']?.id
    if (!groupId) continue
    const list = releasesByGroup.get(groupId)
    if (list) list.push(release)
    else releasesByGroup.set(groupId, [release])
  }
  const groups: MbzGroupFull[] = []
  for (const meta of groupRawList) {
    const groupReleases = releasesByGroup.get(meta.id) ?? []
    const official = groupHasOfficial(groupReleases) || orphanOfficial.has(meta.id)
    if (!official) continue
    // 版本池：只保留官方发行（status == Official），与官网列表口径一致；无 Official 版时（孤儿组等）回退全部
    const pool = groupReleases.filter(release => release.status == 'Official')
    const ordered = sortReleasesForGroup(pool.length ? pool : groupReleases)
    const first = ordered[0]
    // 主艺术家与主歌手 MBID：与候选曲目 extractTracks 同源同逻辑（跳过 Various 合辑概念艺术家，缺失回退首个署名）
    const credits = (first?.['artist-credit'] ?? meta['artist-credit'] ?? []).filter(credit => credit.artist?.id)
    const primaryCredit = credits.find(credit => !isVarious(credit.name)) ?? credits[0]
    // 组日期：官方最早版本日期优先（组 first-release-date 可能被 Withdrawn 污染，如《最偉大的作品》frd=07-08）
    const group: MbzGroupFull = {
      id: meta.id,
      title: (meta.title ?? '').trim() || (first?.title ?? '').trim() || meta.id,
      artists: credits.map(credit => credit.name).filter(Boolean),
      primaryArtistMbid: primaryCredit?.artist?.id ?? '',
      date: first?.date ?? meta['first-release-date'] ?? '',
      primaryType: meta['primary-type'] ?? first?.['release-group']?.['primary-type'] ?? '',
      secondaryTypes: meta['secondary-types'] ?? [],
      releases: ordered,
      releaseOptions: ordered.map(deriveReleaseInfo),
    }
    groups.push(group)
  }
  // 分类排序：官网 Discography 小节签名（主类型 + 副类型组合）→ 日期升序 → 标题
  groups.sort((a, b) => {
    const sa = typeSignature(a)
    const sb = typeSignature(b)
    if (sa != sb) return sa < sb ? -1 : 1
    if (a.date && !b.date) return -1
    if (!a.date && b.date) return 1
    if (a.date != b.date) return a.date < b.date ? -1 : 1
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0
  })
  return { groups }
}

/** 进行中的作品集加载项：共享 AbortController + 引用计数 + 进度广播。
 * 同艺人重复搜索复用同一加载任务，但单个调用方的中止（切页/取消勾选/被新搜索替换）
 * 不再连带 abort 掉其他仍需要的调用方；进度回调集合化广播，过期回调由上层 searchKey 守卫自行空转 */
interface PendingLoadEntry {
  promise: Promise<DiscographyCache>
  controller: AbortController
  refs: number
  onProgress: Set<(done: number, total: number) => void>
}

const pendingLoad = new Map<string, PendingLoadEntry>()

const loadDiscography = async(artistId: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<DiscographyCache> => {
  let entry = pendingLoad.get(artistId)
  if (!entry) {
    const controller = new AbortController()
    const progressCallbacks = new Set<(done: number, total: number) => void>()
    const reportProgress = (done: number, total: number) => {
      for (const cb of progressCallbacks) cb(done, total)
    }
    entry = {
      controller,
      refs: 0,
      onProgress: progressCallbacks,
      promise: Promise.resolve(undefined as unknown as DiscographyCache),
    }
    entry.promise = (async() => {
      let cache = artistCache.get(artistId)
      if (!cache) {
        // 落盘缓存读取（读失败静默回退网络）
        const persisted = await cacheGet(artistId)
        if (persisted?.releases?.length) {
          cache = {
            raw: {
              releases: persisted.releases,
              groups: persisted.groups ?? [],
              orphanOfficial: persisted.orphanOfficial ?? [],
            },
            aggregated: aggregateDiscography(persisted.releases, persisted.groups ?? [], new Set(persisted.orphanOfficial ?? [])),
            failedPages: persisted.failedPages ?? 0,
            failedOrphans: persisted.failedOrphans ?? 0,
          }
          artistCacheSet(artistId, cache)
        }
      }
      // 缓存命中（内存/落盘）：进度直接置为实际聚合后的官方作品集数，避免命中缓存的快速加载期间短暂显示 0/1
      if (cache) reportProgress(cache.aggregated.groups.length, cache.aggregated.groups.length)
      if (!cache) {
        const payload = await fetchDiscography(artistId, reportProgress, controller.signal)
        const aggregated = aggregateDiscography(payload.releases, payload.groups, new Set(payload.orphanOfficial))
        // 最终进度修正为实际聚合后的作品集数（browse 原始组数包含无官方发行等过滤项）
        reportProgress(aggregated.groups.length, aggregated.groups.length)
        cache = {
          raw: { releases: payload.releases, groups: payload.groups, orphanOfficial: payload.orphanOfficial },
          aggregated,
          failedPages: payload.failedPages,
          failedOrphans: payload.failedOrphans,
        }
        // 部分失败（失败页数少）也入缓存：网络差时避免「几分钟白跑且下次重来」，
        // 命中不完整缓存后由后台自动补拉循环（startRefillLoop）补全；此处不触发（由 getArtistDiscography 统一启动/复用）。
        // 孤儿组失败单独计数，不阻断缓存准入（主数据页完整即可缓存），但已持久化供补拉判定。
        if (payload.failedPages <= PARTIAL_CACHE_MAX_FAILED_PAGES) {
          artistCacheSet(artistId, cache)
          // 曲目提取缓存键为 (groupId, releaseId) 不含 artistId，无法按 artist 精确清理；
          // 数据刷新后全清，旧曲目行（重拉前内容）不再复用，其它艺人展开时重新 extractTracks（亚秒级本地计算）
          groupTracksCache.clear()
          // 有效数据落盘缓存（空结果不缓存，避免阻隔下次重试）
          if (payload.releases.length) {
            await cacheSave({
              artistId,
              releases: payload.releases,
              groups: payload.groups,
              orphanOfficial: payload.orphanOfficial,
              fetchedAt: Date.now(),
              failedPages: payload.failedPages,
              failedOrphans: payload.failedOrphans,
            } satisfies DiscographyPersist)
          }
        }
      }
      // 命中不完整数据（页失败或孤儿失败）不由这里触发补拉：
      // 自动补拉循环（startRefillLoop）由 getArtistDiscography 按 cache 是否完整统一启动/复用
      return cache
    })()
    // 任务完成后自清理（仅当仍是当前项时删除，避免误删后续重建的同 id 项）
    const cleanup = () => {
      if (pendingLoad.get(artistId) === entry) pendingLoad.delete(artistId)
    }
    entry.promise.then(cleanup, cleanup)
    pendingLoad.set(artistId, entry)
  }
  const currentEntry = entry

  // 登记本调用方：加入进度广播集合并计数
  if (onProgress) currentEntry.onProgress.add(onProgress)
  currentEntry.refs++
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (onProgress) currentEntry.onProgress.delete(onProgress)
    currentEntry.refs--
    // 仅当无任何调用方仍需要本次拉取时才真正中止共享任务
    if (currentEntry.refs <= 0) currentEntry.controller.abort()
  }

  try {
    if (signal) {
      if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError')
      // 用调用方自身 signal 与共享任务竞速：调用方中止即抛 AbortError，共享任务不受影响
      return await new Promise<DiscographyCache>((resolve, reject) => {
        const onAbort = () => { reject(new DOMException('The operation was aborted', 'AbortError')) }
        signal.addEventListener('abort', onAbort, { once: true })
        currentEntry.promise.then(
          value => { signal.removeEventListener('abort', onAbort); resolve(value) },
          error => { signal.removeEventListener('abort', onAbort); reject(error) },
        )
      })
    }
    return await currentEntry.promise
  } finally {
    release()
  }
}

/** 不完整缓存的后台自动补拉循环（per-artist 幂等）：首次立即跑，失败后按冷却调度自动重试直至完整，
 * 或直到被取消（取消勾选/切源到全部/切类型/清空搜索框，走 cancelAllRefills）。
 * 补拉结果过差（失败页超限）时不覆盖旧缓存；孤儿失败单独计数不阻断覆盖（主数据页完整即可写缓存） */
const refillLoops = new Map<string, {
  done: Promise<void>
  controller: AbortController
  cancel: () => void
}>()

const startRefillLoop = async(artistId: string): Promise<void> => {
  const existing = refillLoops.get(artistId)
  if (existing) return existing.done
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let finish!: () => void
  const done = new Promise<void>(resolve => {
    finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
  })

  const attempt = async() => {
    try {
      const payload = await fetchDiscography(artistId, undefined, controller.signal)
      const cache = {
        raw: { releases: payload.releases, groups: payload.groups, orphanOfficial: payload.orphanOfficial },
        aggregated: aggregateDiscography(payload.releases, payload.groups, new Set(payload.orphanOfficial)),
        failedPages: payload.failedPages,
        failedOrphans: payload.failedOrphans,
      }
      // 与主趟同阈值：补拉结果过差（失败页超限）时不覆盖，保留原缓存再等下轮；
      // 孤儿失败单独计数，不阻断覆盖（主数据页完整即可写缓存）
      if (payload.failedPages <= PARTIAL_CACHE_MAX_FAILED_PAGES) {
        artistCacheSet(artistId, cache)
        // 与主趟同理：数据刷新后全清曲目提取缓存，避免展开时复用重拉前的旧曲目行
        groupTracksCache.clear()
        if (payload.releases.length) {
          await cacheSave({
            artistId,
            releases: payload.releases,
            groups: payload.groups,
            orphanOfficial: payload.orphanOfficial,
            fetchedAt: Date.now(),
            failedPages: payload.failedPages,
            failedOrphans: payload.failedOrphans,
          } satisfies DiscographyPersist)
        }
      }
      // 完整（页失败与孤儿失败均归零）才终止；否则冷却后自动重试
      if (payload.failedPages === 0 && payload.failedOrphans === 0) {
        finish()
        return
      }
      if (controller.signal.aborted) {
        finish()
        return
      }
      timer = setTimeout(attempt, REFILL_COOLDOWN_MS)
    } catch (error) {
      if ((error as Error)?.name == 'AbortError') {
        finish()
        return
      }
      isDebug && console.log('[mbz] refill failed:', (error as Error)?.message ?? error)
      if (controller.signal.aborted) {
        finish()
        return
      }
      timer = setTimeout(attempt, REFILL_COOLDOWN_MS)
    }
  }
  void attempt()

  const loop = {
    done,
    controller,
    cancel: () => {
      clearTimeout(timer)
      controller.abort()
      finish()
    },
  }
  refillLoops.set(artistId, loop)
  void done.finally(() => {
    if (refillLoops.get(artistId) === loop) refillLoops.delete(artistId)
  })
  return done
}

/** 取消全部进行中的自动补拉循环（mbz 模式结束：取消勾选/切源到全部/切类型/清空搜索框时调用） */
export const cancelAllRefills = () => {
  for (const loop of refillLoops.values()) loop.cancel()
  refillLoops.clear()
}

/**
 * 获取指定艺术家的全部作品集候选（与官网 overview 口径一致：
 * 按 release-group 聚合，仅保留含 Official release 的作品集）
 * 数据来源顺序：内存缓存 → IndexedDB 落盘缓存（TTL 3 天）→ 网络拉取
 * @param artistId MusicBrainz 艺术家 MBID
 * @param onProgress 进度回调（已确认官方作品集数, 总作品集数）
 * @param signal 中断信号：中止时停止拉取并抛 AbortError（调用方静默处理，结果不入缓存）
 * @returns 全量排序后的作品集（含各版本数据）与状态
 */
export const getArtistDiscography = async(artistId: string, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<MbzRangeResult> => {
  const cache = await loadDiscography(artistId, onProgress, signal)
  const groups = cache.aggregated.groups
  const incomplete = cache.failedPages > 0 || cache.failedOrphans > 0
  return {
    groups,
    groupTotal: groups.length,
    failedPages: cache.failedPages,
    failedOrphans: cache.failedOrphans,
    // 不完整时启动/复用自动补拉循环：done 在「补全成功」或「被取消」时 resolve，
    // action 端据此重读缓存收敛叹号/列表/summary；完整时直接 resolve
    refilled: incomplete ? startRefillLoop(artistId) : Promise.resolve(),
  }
}

/** 清理全部作品集缓存（内存 + 落盘，调试/手动重置用） */
export const clearMusicBrainzCache = async(): Promise<void> => {
  artistCache.clear()
  groupTracksCache.clear()
  pendingLoad.clear()
  cancelAllRefills()
  await cacheClearAll()
}

// 调试入口：devtools console 里执行 `await window.__clearMbzCache()` 即清空作品集缓存
// 模块仅在渲染进程被引入（window 恒存在），此处的存在性判断仅为防止未来被引入非浏览器环境时崩溃
if (typeof window != 'undefined') {
  ;(window as any).__clearMbzCache = clearMusicBrainzCache
}
