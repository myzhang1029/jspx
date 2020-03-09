import * as path from './path.js'
import * as route from './route.js'
import * as urlx from './urlx.js'
import * as util from './util.js'
import * as cookie from './cookie.js'
import * as network from './network.js'
import * as MSG from './msg.js'
import * as jsfilter from './jsfilter.js'
import * as inject from './inject.js'
import {Signal} from './signal.js'
import {Database} from './database.js'


const CONF_UPDATE_TIMER = 1000 * 60 * 5

let mConf
const MAX_REDIR = 5

/** @type {ServiceWorkerGlobalScope} */
// @ts-ignore
const global = self
const clients = global.clients

let mUrlHandler


/**
 * @param {*} target 
 * @param {number} cmd 
 * @param {*=} val 
 */
function sendMsg(target, cmd, val) {
  if (target) {
    target.postMessage([cmd, val])
  } else {
    console.warn('invalid target', cmd, val)
  }
}


// 也可以用 clientId 关联，但兼容性不高
let pageCounter = 0

/** @type {Map<number, [Signal, number]>} */
const pageWaitMap = new Map()

function genPageId() {
  return ++pageCounter
}

/**
 * @param {number} pageId 
 */
function pageWait(pageId) {
  const s = new Signal()
  // 设置最大等待时间
  // 有些页面不会执行 JS（例如查看源文件），导致永久等待
  const timer = setTimeout(_ => {
    pageWaitMap.delete(pageId)
    s.notify(false)
  }, 2000)

  pageWaitMap.set(pageId, [s, timer])
  return s.wait()
}

/**
 * @param {number} id 
 * @param {boolean} isDone 
 */
function pageNotify(id, isDone) {
  const arr = pageWaitMap.get(id)
  if (!arr) {
    console.warn('[jsproxy] unknown page id:', id)
    return
  }
  const [s, timer] = arr
  if (isDone) {
    pageWaitMap.delete(id)
    s.notify(true)
  } else {
    // 页面已开始初始化，关闭定时器
    clearTimeout(timer)
  }
}


function makeHtmlRes(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
    }
  })
}


/**
 * @param {Response} res 
 * @param {ResponseInit} resOpt 
 * @param {URL} urlObj 
 */
function processHtml(res, resOpt, urlObj) {
  const reader = res.body.getReader()
  let injected = false

  const stream = new ReadableStream({
    async pull(controller) {
      if (!injected) {
        injected = true

        // 注入页面顶部的代码
        const pageId = genPageId()
        const buf = inject.getHtmlCode(urlObj, pageId)
        controller.enqueue(buf)

        // 留一些时间给页面做异步初始化
        const done = await pageWait(pageId)
        if (!done) {
          console.warn('[jsproxy] page wait timeout. id: %d url: %s',
            pageId, urlObj.href)
        }
      }
      const r = await reader.read()
      if (r.done) {
        controller.close()
      } else {
        controller.enqueue(r.value)
      }
    }
  })
  return new Response(stream, resOpt)
}


/**
 * @param {ArrayBuffer} buf 
 * @param {string} charset 
 */
function processJs(buf, charset) {
  const u8 = new Uint8Array(buf)
  const ret = jsfilter.parseBin(u8, charset) || u8
  return util.concatBufs([inject.getWorkerCode(), ret])
}


/**
 * @param {*} cmd 
 * @param {*} msg 
 * @param {string=} srcId
 */
async function sendMsgToPages(cmd, msg, srcId) {
  // 通知页面更新 Cookie
  const pages = await clients.matchAll({type: 'window'})

  for (const page of pages) {
    if (page.frameType !== 'top-level') {
      continue
    }
    if (srcId && page.id === srcId) {
      continue
    }
    sendMsg(page, cmd, msg)
  }
}


/** @type Map<string, string> */
const mIdUrlMap = new Map()

/**
 * @param {string} id 
 */
async function getUrlByClientId(id) {
  const client = await clients.get(id)
  if (!client) {
    return
  }
  const urlStr = urlx.decUrlStrAbs(client.url)
  mIdUrlMap.set(id, urlStr)
  return urlStr
}


/**
 * @param {string} jsonStr 
 * @param {number} status 
 * @param {URL} urlObj 
 */
function parseGatewayError(jsonStr, status, urlObj) {
  let ret = ''
  const {
    msg, addr, url
  } = JSON.parse(jsonStr)

  switch (status) {
  case 204:
    switch (msg) {
    case 'ORIGIN_NOT_ALLOWED':
      ret = '当前域名不在服务器外链白名单'
      break
    case 'CIRCULAR_DEPENDENCY':
      ret = '当前请求出现循环代理'
      break
    case 'SITE_MOVE':
      ret = `当前站点移动到: <a href="${url}">${url}</a>`
      break
    }
    break
  case 500:
    ret = '代理服务器内部错误'
    break
  case 502:
    if (addr) {
      ret = `代理服务器无法连接网站 ${urlObj.origin} (${addr})`
    } else {
      ret = `代理服务器无法解析域名 ${urlObj.host}`
    }
    break
  case 504:
    ret = `代理服务器连接网站超时 ${urlObj.origin}`
    if (addr) {
      ret += ` (${addr})`
    }
    break
  }
  return makeHtmlRes(ret)
}


/**
 * @param {Request} req 
 * @param {URL} urlObj
 * @param {URL} cliUrlObj 
 * @param {number} redirNum
 * @returns {Promise<Response>}
 */
async function forward(req, urlObj, cliUrlObj, redirNum) {
  const r = await network.launch(req, urlObj, cliUrlObj)
  if (!r) {
    return makeHtmlRes('load fail')
  }
  let {
    res, status, headers, cookies
  } = r

  if (cookies) {
    sendMsgToPages(MSG.SW_COOKIE_PUSH, cookies)
  }

  if (!status) {
    status = res.status || 200
  }

  let headersMutable = true
  if (!headers) {
    headers = res.headers
    headersMutable = false
  }

  /**
   * @param {string} k 
   * @param {string} v 
   */
  const setHeader = (k, v) => {
    if (!headersMutable) {
      headers = new Headers(headers)
      headersMutable = true
    }
    headers.set(k, v)
  }

  // 网关错误
  const gwErr = headers.get('gateway-err--')
  if (gwErr) {
    return parseGatewayError(gwErr, status, urlObj)
  }

  /** @type {ResponseInit} */
  const resOpt = {status, headers}

  // 空响应
  // https://fetch.spec.whatwg.org/#statuses
  if (status === 101 ||
      status === 204 ||
      status === 205 ||
      status === 304
  ) {
    return new Response(null, resOpt)
  }

  // 处理重定向
  if (status === 301 ||
      status === 302 ||
      status === 303 ||
      status === 307 ||
      status === 308
  ) {
    const locStr = headers.get('location')
    const locObj = locStr && urlx.newUrl(locStr, urlObj)
    if (locObj) {
      // 跟随模式，返回最终数据
      if (req.redirect === 'follow') {
        if (++redirNum === MAX_REDIR) {
          return makeHtmlRes('重定向过多', 500)
        }
        return forward(req, locObj, cliUrlObj, redirNum)
      }
      // 不跟随模式（例如页面跳转），返回 30X 状态
      setHeader('location', urlx.encUrlObj(locObj))
    }

    // firefox, safari 保留内容会提示页面损坏
    return new Response(null, resOpt)
  }

  //
  // 提取 mime 和 charset（不存在则为 undefined）
  // 可能存在多个段，并且值可能包含引号。例如：
  // content-type: text/html; ...; charset="gbk"
  //
  const ctVal = headers.get('content-type') || ''
  const [, mime, charset] = ctVal
    .toLocaleLowerCase()
    .match(/([^;]*)(?:.*?charset=['"]?([^'"]+))?/)


  const type = req.destination
  if (type === 'script' ||
      type === 'worker' ||
      type === 'sharedworker'
  ) {
    const buf = await res.arrayBuffer()
    const ret = processJs(buf, charset)

    setHeader('content-type', 'text/javascript')
    return new Response(ret, resOpt)
  }

  if (req.mode === 'navigate' && mime === 'text/html') {
    return processHtml(res, resOpt, urlObj)
  }

  return new Response(res.body, resOpt)
}


async function proxy(e, urlObj) {
  // 使用 e.resultingClientId 有问题
  const id = e.clientId
  let cliUrlStr
  if (id) {
    cliUrlStr = mIdUrlMap.get(id) || await getUrlByClientId(id)
  }
  if (!cliUrlStr) {
    cliUrlStr = urlObj.href
  }
  const cliUrlObj = new URL(cliUrlStr)

  try {
    return await forward(e.request, urlObj, cliUrlObj, 0)
  } catch (err) {
    console.error(err)
    return makeHtmlRes('前端脚本错误<br><pre>' + err.stack + '</pre>', 500)
  }
}

/** @type {Database} */
let mDB

async function initDB() {
  mDB = new Database('.sys')
  await mDB.open({
    'url-cache': {
      keyPath: 'url'
    },
    'cookie': {
      keyPath: 'id'
    }
  })

  await network.setDB(mDB)
  await cookie.setDB(mDB)
}


/**
 * @param {FetchEvent} e 
 */
async function onFetch(e) {
  if (!mConf) {
    await initConf()
  }
  // TODO: 逻辑优化
  if (!mDB) {
    await initDB()
  }
  const req = e.request
  const urlStr = urlx.delHash(req.url)

  // 首页（例如 https://zjcqoo.github.io/）
  if (urlStr === path.ROOT || urlStr === path.HOME) {
    let indexPath = mConf.assets_cdn + mConf.index_path
    if (!mConf.index_path) {
      // 临时代码。防止配置文件未更新的情况下首页无法加载
      indexPath = mConf.assets_cdn + 'index_v3.html'
    }
    const res = await fetch(indexPath)
    return makeHtmlRes(res.body)
  }

  // 图标、配置（例如 https://zjcqoo.github.io/conf.js）
  if (urlStr === path.CONF || urlStr === path.ICON) {
    return fetch(urlStr)
  }

  // 注入页面的脚本（例如 https://zjcqoo.github.io/__sys__/helper.js）
  if (urlStr === path.HELPER) {
    return fetch(self['__FILE__'])
  }

  // 静态资源（例如 https://zjcqoo.github.io/__sys__/assets/ico/google.png）
  if (urlStr.startsWith(path.ASSETS)) {
    const filePath = urlStr.substr(path.ASSETS.length)
    return fetch(mConf.assets_cdn + filePath)
  }

  if (req.mode === 'navigate') {
    const newUrl = urlx.adjustNav(urlStr)
    if (newUrl) {
      return Response.redirect(newUrl, 301)
    }
  }

  let targetUrlStr = urlx.decUrlStrAbs(urlStr)
  
  const handler = mUrlHandler[targetUrlStr]
  if (handler) {
    const {
      redir,
      content,
      replace,
    } = handler

    if (redir) {
      return Response.redirect('/-----' + redir)
    }
    if (content) {
      return makeHtmlRes(content)
    }
    if (replace) {
      targetUrlStr = replace
    }
  }

  const targetUrlObj = urlx.newUrl(targetUrlStr)

  if (targetUrlObj) {
    return proxy(e, targetUrlObj)
  }
  return makeHtmlRes('invalid url: ' + targetUrlStr, 500)
}


function parseUrlHandler(handler) {
  const map = {}
  if (!handler) {
    return map
  }
  for (const [match, rule] of Object.entries(handler)) {
    // TODO: 支持通配符和正则
    map[match] = rule
  }
  return map
}

// TODO: 逻辑优化
function updateConf(conf, force) {
  if (!force && mConf) {
    if (conf.ver <= mConf.ver) {
      return
    }
    if (conf.node_map[mConf.node_default]) {
      conf.node_default = mConf.node_default
    } else {
      console.warn('default node %s -> %s',
        mConf.node_default, conf.node_default)
    }
    sendMsgToPages(MSG.SW_CONF_CHANGE, mConf)
  }
  inject.setConf(conf)
  route.setConf(conf)
  network.setConf(conf)

  mUrlHandler = parseUrlHandler(conf.url_handler)
  /*await*/ saveConf(conf)

  mConf = conf
}


async function readConf() {
  const cache = await caches.open('.sys')
  const req = new Request('/conf.json')
  const res = await cache.match(req)
  if (res) {
    return res.json()
  }
}

async function saveConf(conf) {
  const json = JSON.stringify(conf)
  const cache = await caches.open('.sys')
  const req = new Request('/conf.json')
  const res = new Response(json);
  return cache.put(req, res)
}

async function loadConf() {
  const res = await fetch('conf.js')
  const txt = await res.text()
  self['jsproxy_config'] = updateConf
  Function(txt)()
}


/** @type {Signal[]} */
let mConfInitQueue

async function initConf() {
  if (mConfInitQueue) {
    const s = new Signal()
    mConfInitQueue.push(s)
    return s.wait()
  }
  mConfInitQueue = []

  let conf
  try {
    conf = await readConf()
  } catch (err) {
    console.warn('load conf fail:', err)
  }
  if (!conf) {
    conf = self['__CONF__']
  }
  if (conf) {
    updateConf(conf)
  } else {
    conf = await loadConf()
  }

  // 定期更新配置
  setInterval(loadConf, CONF_UPDATE_TIMER)

  mConfInitQueue.forEach(s => s.notify())
  mConfInitQueue = null
}


global.addEventListener('fetch', e => {
  e.respondWith(onFetch(e))
})


global.addEventListener('message', e => {
  // console.log('sw msg:', e.data)
  const [cmd, val] = e.data
  const src = e.source

  switch (cmd) {
  case MSG.PAGE_COOKIE_PUSH:
    cookie.set(val)
    // @ts-ignore
    sendMsgToPages(MSG.SW_COOKIE_PUSH, [val], src.id)
    break

  case MSG.PAGE_INFO_PULL:
    // console.log('SW MSG.COOKIE_PULL:', src.id)
    sendMsg(src, MSG.SW_INFO_PUSH, {
      cookies: cookie.getNonHttpOnlyItems(),
      conf: mConf,
    })
    break

  case MSG.PAGE_INIT_BEG:
    // console.log('SW MSG.PAGE_INIT_BEG:', val)
    pageNotify(val, false)
    break

  case MSG.PAGE_INIT_END:
    // console.log('SW MSG.PAGE_INIT_END:', val)
    pageNotify(val, true)
    break

  case MSG.PAGE_CONF_GET:
    if (mConf) {
      sendMsg(src, MSG.SW_CONF_RETURN, mConf)
    } else {
      initConf().then(_ => {
        sendMsg(src, MSG.SW_CONF_RETURN, mConf)
      })
    }
    break

  case MSG.PAGE_CONF_SET:
    updateConf(val, true)
    sendMsgToPages(MSG.SW_CONF_CHANGE, mConf)
    break

  case MSG.PAGE_RELOAD_CONF:
    /*await*/ loadConf()
    break

  case MSG.PAGE_READY_CHECK:
    sendMsg(src, MSG.SW_READY)
    /*await*/ loadConf()
    break
  }
})


global.addEventListener('install', e => {
  console.log('oninstall:', e)
  e.waitUntil(global.skipWaiting())
})


global.addEventListener('activate', e => {
  console.log('onactivate:', e)
  sendMsgToPages(MSG.SW_READY, 1)

  e.waitUntil(clients.claim())
})


console.log('[jsproxy] sw inited')
