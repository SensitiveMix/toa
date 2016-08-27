'use strict'

var tman = require('tman')
var assert = require('assert')
var context = require('../context')

tman.suite('ctx.search=', function () {
  tman.it('should replace the search', function () {
    var ctx = context({
      url: '/store/shoes'
    })
    ctx.search = '?page=2&color=blue'
    assert.strictEqual(ctx.url, '/store/shoes?page=2&color=blue')
    assert.strictEqual(ctx.search, '?page=2&color=blue')
  })

  tman.it('should update ctx.querystring and ctx.query', function () {
    var ctx = context({
      url: '/store/shoes'
    })
    ctx.search = '?page=2&color=blue'
    assert.strictEqual(ctx.url, '/store/shoes?page=2&color=blue')
    assert.strictEqual(ctx.querystring, 'page=2&color=blue')
    assert.deepEqual(ctx.query, {
      page: '2',
      color: 'blue'
    })
  })

  tman.it('should change .url but not .originalUrl', function () {
    var ctx = context({
      url: '/store/shoes'
    })
    ctx.search = '?page=2&color=blue'
    assert.strictEqual(ctx.url, '/store/shoes?page=2&color=blue')
    assert.strictEqual(ctx.originalUrl, '/store/shoes')
    assert.strictEqual(ctx.request.originalUrl, '/store/shoes')
  })

  tman.suite('when missing', function () {
    tman.it('should return ""', function () {
      var ctx = context({
        url: '/store/shoes'
      })
      assert.strictEqual(ctx.search, '')
    })
  })
})
