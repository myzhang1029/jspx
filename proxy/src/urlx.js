import * as util from './util.js'
import * as env from './env.js'
import * as path from './path.js'


const PREFIX = path.PREFIX
const PREFIX_LEN = PREFIX.length
const ROOT_LEN = path.ROOT.length

/**
 * @param {string} url 
 */
export function isHttpProto(url) {
  return /^https?:/.test(url)
}


/**
 * @param {string} url 
 */
function isInternalUrl(url) {
  return !isHttpProto(url) || url.startsWith(PREFIX)
}


/**
 * @param {string} url 
 * @param {string | URL=} baseUrl 
 */
export function newUrl(url, baseUrl) {
  try {
    // [safari] baseUrl 不能为空
    return baseUrl
      ? new URL(url, baseUrl)
      : new URL(url)
  } catch (err) {
  }
}


/**
 * @param {URL | Location} urlObj 
 */
export function encUrlObj(urlObj) {
  const fullUrl = urlObj.href
  if (isInternalUrl(fullUrl)) {
    return fullUrl
  }
  return PREFIX + fullUrl
}

const IS_SW = env.isSwEnv()
const IS_WORKER = env.isWorkerEnv()
const WORKER_URL = IS_WORKER && decUrlStrAbs(location.href)

/**
 * @param {string} url 
 * @param {*} relObj 
 */
export function encUrlStrRel(url, relObj) {
  let baseUrl

  if (IS_SW) {
    baseUrl = relObj
  } else if (IS_WORKER) {
    baseUrl = WORKER_URL
  } else {
    const {doc} = env.get(relObj)
    baseUrl = doc.baseURI
  }

  const urlObj = newUrl(url, baseUrl)
  if (!urlObj) {
    return url
  }
  return encUrlObj(urlObj)
}


/**
 * @param {string} url 
 */
export function encUrlStrAbs(url) {
  const urlObj = newUrl(url)
  if (!urlObj) {
    return url
  }
  return encUrlObj(urlObj)
}


/**
 * @param {URL | Location} urlObj 
 */
export function decUrlObj(urlObj) {
  const fullUrl = urlObj.href
  if (!fullUrl.startsWith(PREFIX)) {
    return fullUrl
  }
  return fullUrl.substr(PREFIX_LEN)
}


/**
 * @param {string} url 
 * @param {*} relObj 
 */
export function decUrlStrRel(url, relObj) {
  let baseUrl

  if (IS_WORKER) {
    baseUrl = WORKER_URL
  } else {
    const {doc} = env.get(relObj)
    baseUrl = doc.baseURI
  }

  const urlObj = newUrl(url, baseUrl)
  if (!urlObj) {
    return url
  }
  return decUrlObj(urlObj)
}


/**
 * @param {string} url 
 */
export function decUrlStrAbs(url) {
  const urlObj = newUrl(url)
  if (!urlObj) {
    return url
  }
  return decUrlObj(urlObj)
}



/**
 * @param {string} url 
 */
export function delHash(url) {
  const p = url.indexOf('#')
  return (p === -1) ? url : url.substr(0, p)
}


/**
 * @param {string} url 
 */
export function delScheme(url) {
  const p = url.indexOf('://')
  return (p === -1) ? url : url.substr(p + 3)
}


/**
 * @param {string} val 
 */
export function replaceHttpRefresh(val, relObj) {
  return val.replace(/(;\s*url=)(.+)/i, (_, $1, url) => {
    return $1 + encUrlStrRel(url, relObj)
  })
}


/**
 * URL 导航调整
 * 
 * 标准
 *  https://example.com/-----https://www.google.com/
 * 
 * 无路径
 *  https://example.com/-----https://www.google.com
 * 
 * 无协议
 *  https://example.com/-----www.google.com
 * 
 * 任意数量的分隔符
 *  https://example.com/---https://www.google.com
 *  https://example.com/---------https://www.google.com
 *  https://example.com/https://www.google.com
 * 
 * 重复
 *  https://example.com/-----https://example.com/-----https://www.google.com
 * 
 * 搜索
 *  https://example.com/search/xxx
 *  ->
 *  https://www.google.com/search?q=xxx
 */

const DEFAULT_SEARCH = 'https://www.google.com/search?q=%s'


/**
 * @param {string} part 
 */
function padUrl(part) {
  // TODO: HSTS
  const urlStr = isHttpProto(part) ? part : `https://${part}`
  const urlObj = newUrl(urlStr)
  if (!urlObj) {
    return
  }
  const {hostname} = urlObj

  return urlObj.href
}


/**
 * @param {string} urlStr
 */
export function adjustNav(urlStr) {
  // 分隔符 `-----` 之后的部分
  const rawUrlStr = urlStr.substr(PREFIX_LEN)
  const rawUrlObj = newUrl(rawUrlStr)

  if (rawUrlObj) {
    // 循环引用
    const m = rawUrlStr.match(/\/-----(https?:\/\/.+)$/)
    if (m) {
      return PREFIX + m[1]
    }
    // 标准格式（大概率）
    if (isHttpProto(rawUrlObj.protocol) &&
        PREFIX + rawUrlObj.href === urlStr
    ) {
      return
    }
  }

  const part = urlStr.substr(ROOT_LEN).replace(/^-*/, '')

  // 搜索
  if (part.substr(0,7) == "search/")
  const keyword = encodeURIComponent(part.substr(7))
  return PREFIX + DEFAULT_SEARCH.replace('%s', keyword)
 
  // 任意数量 `-` 之后的部分

  const ret = padUrl(part)
  if (ret) {
    return PREFIX + ret
  }

  const keyword = part.replace(/&/g, '%26')
  return PREFIX + DEFAULT_SEARCH.replace('%s', keyword)
}

