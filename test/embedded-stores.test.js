import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari';
import throttl, { postgresStore, redisStore } from '../src/index.js';
import { redisScript } from '../src/redis.js';

// Serializes transactions over an embedded PostgreSQL engine for local SQL validation.
function embeddedPool(db) {
  let queue = Promise.resolve();
  return {
    query: async (sql, values = []) => {
      const result = await db.query(sql, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async connect() {
      const waiting = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await waiting;
      return { query: async (sql, values = []) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
        if (!values.length && sql.trim().split(';').filter(Boolean).length > 1) {
          await db.exec(sql); return { rows: [], rowCount: 0 };
        }
        const result = await db.query(sql, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      }, release };
    },
  };
}

test('PostgreSQL SQL supports v0.1 upgrade, all algorithms and stale-event cleanup', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile('migrations/001-initial.sql', 'utf8'));
    const pool = embeddedPool(db);
    const configs = [
      { limit: 5, windowMs: 60000 },
      { algorithm: 'token-bucket', capacity: 5, refillRate: 1, refillIntervalMs: 3600000 },
      { algorithm: 'gcra', limit: 5, windowMs: 3600000, burst: 5 },
      { algorithm: 'sliding-window-counter', limit: 5, windowMs: 3600000 },
    ];
    for (let index = 0; index < configs.length; index++) {
      const store = postgresStore({ pool, namespace: `embedded-${index}` });
      await store.migrate(); await store.migrate();
      const limiter = throttl({ ...configs[index], store });
      assert.equal((await limiter.check('u', { cost: 3 })).allowed, true);
      assert.equal((await limiter.check('u', { cost: 3 })).allowed, false);
      assert.equal((await limiter.check('u', { cost: 2 })).allowed, true);
      assert.equal(await store.reset('u'), true);
    }
    const store = postgresStore({ pool, namespace: 'clean', cleanupBatchSize: 1 });
    const limiter = throttl({ limit: 10, windowMs: 60000, store });
    await limiter.check('active');
    await pool.query("UPDATE throttl_window_events SET requested_at = clock_timestamp() - interval '2 minutes' WHERE namespace = 'clean'");
    assert.equal(await store.cleanup(), 0);
    assert.equal((await pool.query("SELECT * FROM throttl_window_events WHERE namespace = 'clean'")).rowCount, 0);
    await limiter.check('expired');
    await pool.query("UPDATE throttl_keys SET expires_at = clock_timestamp() - interval '1 second' WHERE namespace = 'clean'");
    assert.equal(await store.cleanup(), 1);
    assert.equal(await store.cleanup(), 1);
  } finally { await db.close(); }
});

// Executes the actual Redis Lua source against a deterministic Redis-command model.
function luaExecutor() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  let time = 1_000_000;
  const execute = async (script, keys, args) => {
    lua.lua_settop(L, 0);
    const bootstrap = `
      redis = {}
      local state = _state or {}; _state = state
      local expiry = _expiry or {}; _expiry = expiry
      for k, deadline in pairs(expiry) do if deadline <= _now then state[k] = nil; expiry[k] = nil end end
      local function tableFor(key) state[key] = state[key] or {}; return state[key] end
      redis.error_reply = function(message) error(message) end
      redis.call = function(command, key, ...)
        local a = {...}; local t
        if command == 'TIME' then return {string.format('%.0f', math.floor(_now / 1000)), string.format('%.0f', (_now % 1000) * 1000)} end
        if command == 'HGET' then return tableFor(key)[a[1]] or false end
        if command == 'HSET' then t = tableFor(key); for i=1,#a,2 do t[a[i]] = tostring(a[i+1]) end; return 1 end
        if command == 'HINCRBY' then t = tableFor(key); t[a[1]] = tostring(tonumber(t[a[1]] or '0') + a[2]); return tonumber(t[a[1]]) end
        if command == 'PEXPIRE' then expiry[key] = _now + a[1]; return 1 end
        if command == 'ZADD' then tableFor(key)[a[2]] = a[1]; return 1 end
        if command == 'DEL' then local n=0; for _,k in ipairs({key, ...}) do if state[k] then state[k]=nil; n=n+1 end end; return n end
        if command == 'ZRANGE' or command == 'ZRANGEBYSCORE' or command == 'ZREMRANGEBYSCORE' then
          t = tableFor(key); local ordered = {}
          for member, score in pairs(t) do table.insert(ordered, {member, score}) end
          table.sort(ordered, function(x,y) return x[2] < y[2] or (x[2] == y[2] and x[1] < y[1]) end)
          local result = {}; local removed=0
          for i,item in ipairs(ordered) do
            local include
            if command == 'ZRANGE' then
              local start = a[1] < 0 and #ordered+a[1] or a[1]
              local stop = a[2] < 0 and #ordered+a[2] or a[2]
              include = i-1 >= start and i-1 <= stop
            else include = (a[1] == '-inf' or item[2] >= tonumber(a[1])) and item[2] <= tonumber(a[2]) end
            if include then
              if command == 'ZREMRANGEBYSCORE' then t[item[1]]=nil; removed=removed+1 else
                table.insert(result,item[1]); if a[3] == 'WITHSCORES' then table.insert(result,tostring(item[2])) end
              end
            end
          end
          if command == 'ZREMRANGEBYSCORE' then return removed end
          return result
        end
        error('Unsupported command: ' .. command)
      end
    `;
    const encoded = value => JSON.stringify(value);
    const prefix = `KEYS={${keys.map(encoded).join(',')}}; ARGV={${args.map(encoded).join(',')}};`;
    const program = `_now=${time};\n${bootstrap}\n${prefix}\n${script}`;
    const status = lauxlib.luaL_dostring(L, to_luastring(program));
    if (status !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
    const result = [];
    if (lua.lua_istable(L, -1)) {
      for (let i = 1; i <= lua.lua_rawlen(L, -1); i++) {
        lua.lua_rawgeti(L, -1, i);
        result.push(to_jsstring(lua.lua_tostring(L, -1))); lua.lua_pop(L, 1);
      }
    }
    if (result.length) return result;
    return lua.lua_tonumber(L, -1);
  };
  execute.setTime = value => { time = value; };
  return execute;
}

test('Redis Lua compiles and executes every algorithm with weighted checks', async () => {
  const configurations = [
    { limit: 10, windowMs: 60000 },
    { algorithm: 'token-bucket', capacity: 10, refillRate: 1, refillIntervalMs: 1000 },
    { algorithm: 'gcra', limit: 10, windowMs: 60000, burst: 10 },
    { algorithm: 'sliding-window-counter', limit: 10, windowMs: 60000 },
  ];
  for (const config of configurations) {
    const store = redisStore({ namespace: 'lua-test', execute: luaExecutor() });
    const limiter = throttl({ ...config, store });
    const result = await limiter.check('u', { cost: 3 });
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 7);
    assert.equal((await limiter.check('u', { cost: 8 })).allowed, false);
    assert.equal((await limiter.check('u', { cost: 7 })).allowed, true);
    assert.equal((await limiter.check('u')).allowed, false);
    assert.equal(await limiter.reset('u'), true);
    assert.equal((await limiter.check('u', { cost: 10 })).allowed, true);
  }
  assert.ok(redisScript.includes("redis.call('TIME')"));
});

test('Redis Lua matches memory decisions through weighted expiration and bucket boundaries', async () => {
  for (const config of [
    { limit: 10, windowMs: 1000 },
    { algorithm: 'token-bucket', capacity: 10, refillRate: 2, refillIntervalMs: 1000 },
    { algorithm: 'gcra', limit: 10, windowMs: 1000, burst: 10 },
    { algorithm: 'sliding-window-counter', limit: 10, windowMs: 1000 },
  ]) {
    let now = 1_800_000_000_000;
    const execute = luaExecutor();
    const local = throttl({ ...config, clock: () => now });
    const shared = throttl({ ...config, store: redisStore({ namespace: 'compare', execute }) });
    for (let index = 0; index < 80; index++) {
      now += [0, 10, 70, 120, 400][index % 5]; execute.setTime(now);
      const cost = index % 4 + 1;
      const expected = await local.check('u', { cost });
      const actual = await shared.check('u', { cost });
      assert.equal(actual.allowed, expected.allowed, `${config.algorithm ?? 'sliding-window'} check ${index}`);
      assert.equal(actual.remaining, expected.remaining);
      assert.ok(Math.abs(actual.retryAfterMs - expected.retryAfterMs) <= 1);
    }
  }
});

test('Redis Lua preserves high-rate GCRA burst precision and large exact costs', async () => {
  const execute = luaExecutor();
  execute.setTime(1_800_000_000_000);
  const gcra = throttl({ algorithm: 'gcra', limit: 1_000_000, windowMs: 1000, burst: 100,
    store: redisStore({ namespace: 'precision', execute }) });
  let accepted = 0;
  for (let index = 0; index < 150; index++) if ((await gcra.check('u')).allowed) accepted++;
  assert.equal(accepted, 100);
  const exact = throttl({ limit: 100_000_000_000_000, maxSlidingWindowLimit: 100_000_000_000_000,
    windowMs: 1000, store: redisStore({ namespace: 'large-cost', execute }) });
  assert.equal((await exact.check('u', { cost: 100_000_000_000_000 })).allowed, true);
  assert.equal((await exact.check('u')).allowed, false);
  execute.setTime(1_800_000_001_000);
  assert.equal((await exact.check('u')).allowed, true);
});
