declare namespace LX {
  namespace Music {
    interface MusicQualityType { // {"type": "128k", size: "3.56M"}
      type: LX.Quality
      size: string | null
    }
    interface MusicQualityTypeKg { // {"type": "128k", size: "3.56M"}
      type: LX.Quality
      size: string | null
      hash: string
    }
    type _MusicQualityType = Partial<Record<Quality, {
      size: string | null
    }>>
    type _MusicQualityTypeKg = Partial<Record<Quality, {
      size: string | null
      hash: string
    }>>


    interface MusicInfoMetaBase {
      songId: string | number // 歌曲ID，mg源为copyrightId，local为文件路径
      albumName: string // 歌曲专辑名称
      picUrl?: string | null // 歌曲图片链接
      toggleMusicInfo?: MusicInfoOnline | null
      // —— 以下为 mbz 作品集搜索占位字段（组行/曲目行，非平台元数据）——
      mbzType?: string // 作品集主类型（Album/EP/Single/...）
      mbzTrackMbid?: string // 曲目 recording MBID
      mbzArtistMbid?: string // 艺术家 MBID
      mbzReleaseMbid?: string // 版本 release MBID（曲目行 meta 为选中版本字段）
      mbzReleaseCatalog?: string // 版本目录号（曲目行悬浮展示）
      mbzReleaseBarcode?: string // 版本条码（曲目行悬浮展示）
      mbzMediaFormat?: string // 曲目来源媒体格式（CD/DVD 等，曲目行标签展示）
      mbzGroupId?: string // 作品集 release group MBID
      mbzGroupIndex?: number // 作品集序号（从 1 计数，组行序号列展示，与曲目序号区分）
      mbzReleaseId?: string // 组行选中版本 release MBID（切换下拉时写入，缺省官网序第一行）
      mbzTrackIndex?: number // 曲目组内序号（从 1 计数，mbz 展开曲目行展示用）
      mbzGroup?: { // 组行占位：内嵌版本下拉数据
        id: string
        title: string
        /** 组级艺术家名列表（单曲合并后还原组行原貌用） */
        artists: string[]
        primaryType: string
        date: string | null
        releases: Array<{
          id: string
          date: string | null
          country: string | null
          format: string | null
          trackCount: string | null // 各媒体曲目数原始展示（如 "10+7"）
          label: string | null
          catalog: string | null
          barcode: string | null
          quality: string | null // 音质标记（"high" 高音质，下拉选项 ● 前缀）
        }>
      }
    }

    interface MusicInfoMeta_online extends MusicInfoMetaBase {
      qualitys: MusicQualityType[]
      _qualitys: _MusicQualityType
      albumId?: string | number // 歌曲专辑ID
    }

    interface MusicInfoMeta_local extends MusicInfoMetaBase {
      filePath: string
      ext: string
    }


    interface MusicInfoBase<S = LX.Source> {
      id: string
      name: string // 歌曲名
      singer: string // 艺术家名
      source: S // 源
      interval: string | null // 格式化后的歌曲时长，例：03:55
      meta: MusicInfoMetaBase
    }

    interface MusicInfoLocal extends MusicInfoBase<'local'> {
      meta: MusicInfoMeta_local
    }

    interface MusicInfo_online_common extends MusicInfoBase<'kw' | 'wy'> {
      meta: MusicInfoMeta_online
    }

    interface MusicInfoMeta_kg extends MusicInfoMeta_online {
      qualitys: MusicQualityTypeKg[]
      _qualitys: _MusicQualityTypeKg
      hash: string // 歌曲hash
      albumAudioId?: string // 专辑内歌曲ID(MixSongID)，用于歌词精确搜索
    }
    interface MusicInfo_kg extends MusicInfoBase<'kg'> {
      meta: MusicInfoMeta_kg
    }

    interface MusicInfoMeta_tx extends MusicInfoMeta_online {
      strMediaMid: string // 歌曲strMediaMid
      id?: number // 歌曲songId
      albumMid?: string // 歌曲albumMid
    }
    interface MusicInfo_tx extends MusicInfoBase<'tx'> {
      meta: MusicInfoMeta_tx
    }

    interface MusicInfoMeta_mg extends MusicInfoMeta_online {
      copyrightId: string // 歌曲copyrightId
      lrcUrl?: string // 歌曲lrcUrl
      mrcUrl?: string // 歌曲mrcUrl
      trcUrl?: string // 歌曲trcUrl
    }
    interface MusicInfo_mg extends MusicInfoBase<'mg'> {
      meta: MusicInfoMeta_mg
    }

    type MusicInfoOnline = MusicInfo_online_common | MusicInfo_kg | MusicInfo_tx | MusicInfo_mg
    type MusicInfo = MusicInfoOnline | MusicInfoLocal

    interface LyricInfo {
      // 歌曲歌词
      lyric: string
      // 翻译歌词
      tlyric?: string | null
      // 罗马音歌词
      rlyric?: string | null
      // 逐字歌词
      lxlyric?: string | null
    }

    interface LyricInfoSave {
      id: string
      lyrics: LyricInfo
    }

    interface MusicFileMeta {
      title: string
      artist: string | null
      album: string | null
      APIC: string | null
      lyrics: string | null
    }

    interface MusicUrlInfo {
      id: string
      url: string
    }

    interface MusicInfoOtherSourceSave {
      id: string
      list: MusicInfoOnline[]
    }

  }
}
