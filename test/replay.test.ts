import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/server.js';
import type { MarketEvent } from '../src/types.js';

const { app } = buildServer();
after(async () => { await app.close(); });

async function postEvent(event: MarketEvent): Promise<{ accepted: boolean; anomaly?: Record<string, unknown> }> {
  const reply = await app.inject({ method: 'POST', url: '/api/market-data/events', payload: event });
  assert.equal(reply.statusCode, 200);
  return reply.json();
}

async function createSession(symbol: string, tradingDay: string) {
  const reply = await app.inject({ method: 'POST', url: '/api/replay/sessions', payload: { symbol, tradingDay } });
  assert.equal(reply.statusCode, 200);
  return { session: reply.json(), id: (reply.json() as { id: string }).id };
}

const symbol = 'REPL';
const day1 = '2026-10-01';
const day2 = '2026-10-02';

async function seed() {
  const snap = (tradingDay: string, bid: number, ask: number): MarketEvent => ({
    id: `E-${tradingDay}-1`, symbol, tradingDay, timestamp: `${tradingDay}T09:30:00.000Z`, sequence: 1, type: 'snapshot',
    bids: [{ price: bid, quantity: 100 }], asks: [{ price: ask, quantity: 100 }],
  });
  const trade = (tradingDay: string): MarketEvent => ({
    id: `E-${tradingDay}-2`, symbol, tradingDay, timestamp: `${tradingDay}T09:30:01.000Z`, sequence: 2, type: 'trade',
    aggressorSide: 'buy', price: tradingDay === day1 ? 100.05 : 102.05, quantity: 25,
  });

  assert.deepEqual(await postEvent(snap(day1, 100, 100.05)), { accepted: true });
  assert.deepEqual(await postEvent(snap(day2, 102, 102.05)), { accepted: true });
  assert.equal((await postEvent(trade(day1))).accepted, true);
  assert.equal((await postEvent(trade(day2))).accepted, true);
  // 重投各日 seq=1：幂等拒收，不影响后续回放计数
  assert.equal((await postEvent(snap(day1, 100, 100.05))).accepted, false);
  assert.equal((await postEvent(snap(day2, 102, 102.05))).accepted, false);
}

test('跨日回放：replay session 只能看到创建时指定交易日的数据', async () => {
  await seed();

  const { session: s1, id: id1 } = await createSession(symbol, day1);
  assert.equal(s1.eventCount, 2);
  assert.equal(s1.tradingDay, day1);
  assert.equal(s1.nextEvent.sequence, 1);
  assert.equal(s1.nextEvent.tradingDay, day1);

  const { session: s2, id: id2 } = await createSession(symbol, day2);
  assert.equal(s2.eventCount, 2);
  assert.equal(s2.nextEvent.tradingDay, day2);
  assert.notEqual(id1, id2);

  // 跑完整 day1，事件与盘口只能来自 day1（day1 的成交价吃掉 100.05 卖一）
  const run1 = await app.inject({ method: 'POST', url: `/api/replay/sessions/${id1}/run`, payload: {} });
  const body1 = run1.json();
  assert.equal(body1.processed, 2);
  assert.equal(body1.status, 'completed');
  assert.equal(body1.cursor, 2);
  assert.equal(body1.event, undefined, '/run 保持现有返回结构（不返回 event）');

  const get1 = (await app.inject({ method: 'GET', url: `/api/replay/sessions/${id1}` })).json();
  assert.equal(get1.progress, 100);
  assert.equal(get1.currentEvent.tradingDay, day1);
  assert.equal(get1.currentEvent.sequence, 2);
  assert.equal(get1.nextEvent, undefined);

  // day2 的 session 仍停在开头，且未被 day1 回放污染（事件在 step/run 时才应用）
  const get2 = (await app.inject({ method: 'GET', url: `/api/replay/sessions/${id2}` })).json();
  assert.equal(get2.cursor, 0);
  assert.equal(get2.status, 'ready');
  assert.deepEqual(get2.book.bids, []);
  assert.deepEqual(get2.book.asks, []);

  // 单步 day2 只能拿到 day2 事件，盘口按 day2 的 snapshot 建立
  const step2 = (await app.inject({ method: 'POST', url: `/api/replay/sessions/${id2}/step` })).json();
  assert.equal(step2.event.tradingDay, day2);
  assert.equal(step2.event.sequence, 1);
  assert.equal(step2.status, 'paused');
  assert.equal(step2.book.bids[0].price, 102);
  assert.equal(step2.book.asks[0].price, 102.05);
});

test('空日查询：没有任何事件的交易日返回空 session，step/run 立即结束且结构不变', async () => {
  const emptyDay = '2026-09-01';
  const { session, id } = await createSession(symbol, emptyDay);
  assert.equal(session.eventCount, 0);
  assert.equal(session.tradingDay, emptyDay);
  assert.equal(session.cursor, 0);
  assert.equal(session.status, 'ready');
  assert.equal(session.nextEvent, undefined);
  assert.deepEqual(session.book.bids, []);
  assert.deepEqual(session.book.asks, []);

  const fetched = (await app.inject({ method: 'GET', url: `/api/replay/sessions/${id}` })).json();
  assert.equal(fetched.eventCount, 0);
  assert.equal(fetched.progress, 100);
  assert.equal(fetched.currentEvent, undefined);
  assert.equal(fetched.nextEvent, undefined);

  const step = (await app.inject({ method: 'POST', url: `/api/replay/sessions/${id}/step` })).json();
  assert.equal(step.done, true);
  assert.equal(step.status, 'completed');

  const run = (await app.inject({ method: 'POST', url: `/api/replay/sessions/${id}/run`, payload: {} })).json();
  assert.equal(run.processed, 0);
  assert.equal(run.done, true);
  assert.equal(run.status, 'completed');
});
