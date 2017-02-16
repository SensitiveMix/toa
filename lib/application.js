'use strict'
// **Github:** https://github.com/toajs/toa
//
// **License:** MIT

const util = require('util')
const http = require('http')
const Stream = require('stream')
const thunks = require('thunks')
const accepts = require('accepts')
const Cookies = require('cookies')
const statuses = require('statuses')
const EventEmitter = require('events')

const contextProto = require('./context')
const requestProto = require('./request')
const responseProto = require('./response')
const packageInfo = require('../package.json')

const ENDED = Symbol('Context#ended')
const FINISHED = Symbol('Context#finished')
const AFTER_HOOKS = Symbol('Context#afterHooks')
const ON_ERROR_HEADER_REG = /^(accept|allow|retry-after|warning|vary|access-control-allow-)/i

module.exports = Toa
Toa.Toa = Toa
Toa.NAME = packageInfo.name
Toa.VERSION = packageInfo.version
Toa.AUTHORS = packageInfo.authors

// Will change to `function Toa (server, options) {}` in v3.x
function Toa (server, lastHandler, options) {
  if (!(this instanceof Toa)) return new Toa(server, lastHandler, options)
  const app = this

  this.server = server && isFn(server.listen) ? server : null
  if (this.server !== server) {
    options = lastHandler
    lastHandler = server
  }

  if (!isFn(lastHandler)) {
    options = lastHandler
    lastHandler = null
  }

  options = options || {}
  this.lastHandler = lastHandler

  if (isFn(options)) this.errorHandler = options
  else this.errorHandler = isFn(options.onerror) ? options.onerror : null

  this.middleware = []
  this.request = Object.create(requestProto)
  this.response = Object.create(responseProto)
  this.context = Object.create(contextProto, {
    onerror: {
      enumerable: true,
      value: function (err) {
        // if error trigger by context, try to respond
        if (err != null && this instanceof Context) {
          this.thunk.cancel()
          err = onResError.call(this, err)
        }
        if (err != null) app.onerror(err)
      }
    },
    after: {
      enumerable: true,
      value: function (hook) {
        if (!this[AFTER_HOOKS].length) {
          throw new Error("Can't add hook after middleware process.")
        }
        return this[AFTER_HOOKS].push(toThunkable(hook))
      }
    },
    ended: {
      enumerable: true,
      get: function () { return this[ENDED] === true }
    },
    finished: {
      enumerable: true,
      get: function () { return this[FINISHED] === true }
    },
    closed: {
      enumerable: true,
      get: function () { return this[FINISHED] === false }
    },
    onPreEnd: { // deprecated
      get: function () { return [] },
      set: function (hook) { this.after(hook) }
    }
  })

  function Request (ctx) {
    this.ctx = ctx
    this.req = ctx.req
    this.res = ctx.res
    this.accept = accepts(ctx.req)
    this.originalUrl = ctx.req.url
  }
  Request.prototype = app.request
  Request.prototype.constructor = Request

  function Response (ctx) {
    this.ctx = ctx
    this.req = ctx.req
    this.res = ctx.res
  }
  Response.prototype = app.response
  Response.prototype.constructor = Response

  function Context (req, res) {
    EventEmitter.call(this)

    this.req = req
    this.res = res
    this.request = new Request(this)
    this.response = new Response(this)

    this.accept = this.request.accept
    this.originalUrl = this.request.originalUrl
    this.config = Object.create(app.config)
    this.cookies = new Cookies(req, res, {
      keys: app.keys,
      secure: this.request.secure
    })
    this.state = {}
    this.thunk = null
    this.seq = null
    this.respond = true
    this[ENDED] = false // false | true
    this[FINISHED] = null // null | false | true
    this[AFTER_HOOKS] = [nextTick] // this will improve concurrency performance

    this.on('error', this.onerror)
    // socket error should be handled by server's 'clientError' listener then destroy
    res.on('finish', () => {
      if (this[FINISHED] == null) {
        this[FINISHED] = true // context finished successfully
        this.emit('finish')
      }
    })
    // Maybe no 'close' event on res, we should listen req.
    req.on('close', () => {
      if (this[FINISHED] == null) {
        this.thunk.cancel() // cancel async process
        this[FINISHED] = false // context finished unexpectedly
        this.emit('close')
      }
    })
  }
  Context.prototype = app.context
  Context.prototype.constructor = Context
  this.Context = Context

  const config = {
    proxy: false,
    poweredBy: 'Toa',
    subdomainOffset: 2,
    env: process.env.NODE_ENV || 'development'
  }

  Object.defineProperty(this, 'config', {
    enumerable: true,
    get: () => config,
    set: (obj) => {
      for (let key of Object.keys(obj)) config[key] = obj[key]
    }
  })
}

/**
 * A [Keygrip](https://github.com/expressjs/keygrip) object or an array of keys,
 * will be passed to Cookies to enable cryptographic signing.
 */
Toa.prototype.keys = null

/**
 * Use the given middleware `fn`.
 *
 * @param {Function} fn
 * @return {this}
 * @api public
 */
Toa.prototype.use = function (fn) {
  this.middleware.push(toThunkable(fn))
  return this
}

/**
 * start server
 *
 * @param {Mixed} ...
 * @return {this}
 * @api public
 */
Toa.prototype.listen = function () {
  if (!this.server) this.server = http.createServer()
  return this.server
    .on('request', this.toListener())
    .listen.apply(this.server, arguments)
}

/**
 * Return a request listener
 * for node's native http server.
 *
 * @return {Function}
 * @api public
 */
Toa.prototype.toListener = function () {
  const Context = this.Context
  const errorHandler = this.errorHandler || noOp

  const middleware = this.middleware.slice()
  if (this.lastHandler) {
    middleware.push(toThunkable(this.lastHandler))
    this.onerror(new Error('"mainFn" will be deprecated in next version, please move it to middleware'))
  }

  function * runner () {
    for (let fn of middleware) yield fn
    for (let fn of consumeHooks(this[AFTER_HOOKS])) yield fn
  }

  return function requestListener (req, res) {
    let ctx = new Context(req, res)
    // Misdirected request, http://tools.ietf.org/html/rfc7540#section-9.1.2
    // The request was directed at a server that is not able to produce a response.
    res.statusCode = 421
    ctx.thunk = thunks(new Scope(ctx, errorHandler))
    ctx.seq = ctx.thunk.seq
    ctx.thunk(runner)(respond)
  }
}

/**
 * Default system error handler.
 *
 * @param {Error} err
 * @api private
 */
Toa.prototype.onerror = function (err) {
  // ignore null and response error
  if (err.expose || (err.status && err.status < 500)) return
  if (!util.isError(err)) err = new Error('non-error thrown: ' + util.inspect(err))
  let msg = err.stack || err.toString()
  console.error(msg.replace(/^/gm, '  '))
}

/**
 * Scope of context.thunk.
 *
 * @api private
 */
class Scope extends thunks.Scope {
  constructor (ctx, errorHandler) {
    super()
    this.ctx = ctx
    this.errorHandler = errorHandler
  }
  onstop (sig) {
    let ctx = this.ctx
    ctx.seq(consumeHooks(ctx[AFTER_HOOKS]))(respond)
  }
  onerror (err) {
    let ctx = this.ctx
    if (err == null) return
    try {
      err = this.errorHandler.call(ctx, err) || err
    } catch (error) {
      err = error
    }
    // if err === true, ignore err and response to client
    if (err === true) respond.call(ctx)
    else ctx.onerror(err)
  }
}

/**
 * Response middleware.
 */
function respond () {
  let res = this.res
  let body = this.body
  let code = this.status

  if (this.respond === false) return endContext(this)
  if (res.headersSent || this[FINISHED] != null) return
  if (this.config.poweredBy) this.set('x-powered-by', this.config.poweredBy)
  // ignore body
  if (statuses.empty[code]) {
    // strip headers
    this.body = null
    res.end()
  } else if (this.method === 'HEAD') {
    if (isJSON(body)) this.length = Buffer.byteLength(JSON.stringify(body))
    res.end()
  } else if (body == null) {
    // status body
    this.type = 'text'
    body = this.message || String(code)
    this.length = Buffer.byteLength(body)
    res.end(body)
  } else if (typeof body === 'string' || Buffer.isBuffer(body)) {
    res.end(body)
  } else if (body instanceof Stream) {
    body.pipe(res)
    // to ensure `res.headersSent === true` before `context.emit("end")`
    // if "error" occured before "data", it will goto `onResError(error)`
    body.once('data', () => endContext(this))
    return
  } else {
    // body: json
    body = JSON.stringify(body)
    this.length = Buffer.byteLength(body)
    res.end(body)
  }
  endContext(this)
}

/**
 * Default response error handler.
 *
 * @param {Error} err
 * @api private
 */
function onResError (err) {
  // nothing we can do here other
  // than delegate to the app-level
  // handler and log.
  if (this.headerSent || this[FINISHED] != null) {
    err.headerSent = this.headerSent
    err.context = this.toJSON()
    return err
  }
  // support JSON error object: {name: 'BadRequest', status: 400, message: 'Some bad request'}
  if (!util.isError(err)) {
    this.body = err
    if (err.status) this.status = err.status
    respond.call(this)
    return
  }
  // unset headers
  let _headers = this.res._headers
  if (_headers) {
    // retain headers on error
    for (let key of Object.keys(_headers)) {
      if (!ON_ERROR_HEADER_REG.test(key)) delete _headers[key]
    }
  }
  // force text/plain
  this.type = 'text'
  // support ENOENT to 404, default to 500
  if (err.code === 'ENOENT') this.status = 404
  else if (typeof err.status !== 'number' || !statuses[err.status]) this.status = 500
  else this.status = err.status

  this.set('x-content-type-options', 'nosniff')
  this.body = err.expose ? err.message : statuses[this.status]
  respond.call(this)
  return err
}

function noOp () {}

function nextTick (done) { setImmediate(done) }

function isFn (fn) { return typeof fn === 'function' }

function toThunkable (fn) {
  if (typeof fn === 'function') {
    if (thunks.isThunkableFn(fn)) return fn
    return function (done) { this.thunk(fn.call(this))(done) }
  }
  if (fn && typeof fn.toThunk === 'function') return fn.toThunk()
  throw new TypeError(`${fn} is not a function or "toThunk" object`)
}

// means that application' work delivered
function endContext (ctx) {
  if (!ctx[ENDED]) {
    ctx[ENDED] = true
    ctx.emit('end')
  }
}

function isJSON (body) {
  return body && typeof body !== 'string' && !Buffer.isBuffer(body) &&
    !(body instanceof Stream)
}

function consumeHooks (hooks) {
  let res = hooks.slice()
  hooks.length = 0
  return res.reverse() // execute hooks in LIFO order
}
