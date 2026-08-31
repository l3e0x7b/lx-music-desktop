/**
 * MusicBrainz 作品集数据持久化缓存（IndexedDB 落盘）
 * 搜索顺序：内存 → 落盘 → 网络；TTL 过期自动重拉；读写失败静默回退网络
 */

export const CACHE_TTL_MS = 7 * 24 * 3600 * 1000
/** 缓存数据结构版本，聚合逻辑变更时递增以废弃旧缓存。
 * 8→9（2026-08-31）：孤儿失败计数从 failedPages 拆分为独立字段 failedOrphans，
 * 并修正 8.32 孤儿全量检查的防御门槛与止损语义，旧缓存缺该字段，强制重拉。 */
export const CACHE_VERSION = 9

export declare interface MbzArtistCredit {
  name: string
  artist?: {
    id: string
  }
}

export declare interface MbzReleaseRaw {
  id: string
  title: string
  date?: string
  status?: string
  /** 数据质量标记（high/normal/low，官网绿标=high；供主版本选择优先） */
  quality?: string
  /** 发行地区代码（如 CN/TW） */
  country?: string
  /** 条码（官网 release 列表排序键之一） */
  barcode?: string
  /** 版本说明（如 Hant, iTunes TW）—— 8.25 补充三后展示规则改为版本标题原文，此字段仅旧缓存兼容，新数据不再参与派生 */
  disambiguation?: string
  /** 发行厂牌与目录号（如 杰威爾音樂有限公司 / 4711448406；catalog-number 可能为 "[none]"） */
  'label-info'?: Array<{
    label?: {
      name: string
    }
    'catalog-number'?: string
  }>
  'release-group'?: {
    id: string
    title?: string
    'primary-type'?: string
  }
  'artist-credit'?: MbzArtistCredit[]
  media?: Array<{
    /** 媒体格式（如 CD/DVD/VCD，曲目行 Format 标签与版本下拉选项展示用） */
    format?: string
    /** 媒体内曲目数（版本下拉选项展示用，如 "10+7"） */
    'track-count'?: number
    tracks?: Array<{
      /** 曲目在媒体内序号（版本差异补全排序用） */
      position?: number
      title?: string
      'artist-credit'?: MbzArtistCredit[]
      recording?: {
        id: string
        title: string
        length?: number | null
        video?: boolean | null
        'artist-credit'?: MbzArtistCredit[]
      }
    }>
  }>
}

export declare interface MbzGroupRaw {
  id: string
  title: string
  disambiguation?: string
  'first-release-date'?: string
  'primary-type'?: string
  /** 副类型（旧缓存可能缺失，读取时容错为空） */
  'secondary-types'?: string[]
  /** 别名（8.25 补充三后不再 `inc=aliases` 拉取，此字段仅旧缓存兼容，新数据不填充） */
  aliases?: Array<{ name: string, primary?: boolean | null }>
  /** 组级艺术家（孤儿组回退用；旧缓存可能缺失） */
  'artist-credit'?: MbzArtistCredit[]
}

export declare interface DiscographyPersist {
  artistId: string
  releases: MbzReleaseRaw[]
  groups: MbzGroupRaw[]
  orphanOfficial: string[]
  fetchedAt: number
  /** 缓存版本（由 cacheSave 写入，版本不符视为过期） */
  version?: number
  /** 拉取时的失败页数（>0 表示数据不完整；命中后展示并由后台静默补拉） */
  failedPages?: number
  /** 拉取时孤儿组检查失败的组数（>0 表示部分孤儿组缺失；命中后由后台补拉补齐，不阻断缓存准入） */
  failedOrphans?: number
}

const DB_NAME = 'lx-music-desktop'
const STORE_NAME = 'musicbrainz-discography'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase | null> | null = null

const openDB = async(): Promise<IDBDatabase | null> => {
  if (dbPromise) return dbPromise
  const promise = new Promise<IDBDatabase | null>(resolve => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'artistId' })
      }
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { resolve(null) }
    request.onblocked = () => { resolve(null) }
  })
  // 失败结果不入缓存：清空句柄让下次调用重新尝试，
  // 避免极低概率的 blocked/error 状态固化导致后续落盘读写永久静默失效
  void promise.then(db => {
    if (!db) dbPromise = null
  })
  return promise
}

const dbRequest = async <T,>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => { resolve(req.result) }
  req.onerror = () => { reject(req.error) }
})

const transactionDone = async(db: IDBDatabase, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => void): Promise<void> => new Promise((resolve, reject) => {
  const tx = db.transaction(STORE_NAME, mode)
  fn(tx.objectStore(STORE_NAME))
  tx.oncomplete = () => { resolve() }
  tx.onerror = () => { reject(tx.error) }
})

export const cacheGet = async(artistId: string): Promise<DiscographyPersist | null> => {
  try {
    const db = await openDB()
    if (!db) return null
    const data = await dbRequest<DiscographyPersist | undefined>(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(artistId))
    if (!data) return null
    if (data.version !== CACHE_VERSION) {
      await cacheDelete(artistId)
      return null
    }
    if (Date.now() - data.fetchedAt > CACHE_TTL_MS) {
      await cacheDelete(artistId)
      return null
    }
    return data
  } catch (error) {
    console.log(error)
    return null
  }
}

export const cacheSave = async(payload: DiscographyPersist): Promise<void> => {
  try {
    const db = await openDB()
    if (!db) return
    await transactionDone(db, 'readwrite', store => store.put({ ...payload, version: CACHE_VERSION }))
  } catch (error) {
    console.log(error)
  }
}

export const cacheDelete = async(artistId: string): Promise<void> => {
  try {
    const db = await openDB()
    if (!db) return
    await transactionDone(db, 'readwrite', store => store.delete(artistId))
  } catch (error) {
    console.log(error)
  }
}

/** 清空全部作品集落盘缓存（仅清空本对象存储，不整体删除数据库——避免未来同一数据库下的其他功能被误删） */
export const cacheClearAll = async(): Promise<void> => {
  try {
    const db = await openDB()
    if (!db) return
    await transactionDone(db, 'readwrite', store => store.clear())
  } catch (error) {
    console.log(error)
  }
}
