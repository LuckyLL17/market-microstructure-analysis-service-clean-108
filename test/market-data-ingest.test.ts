import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/server.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const post = async (url: string, payload: unknown): Promise<any> => (await app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> })).json();
const get = async (url: string): Promise<any> => (await app.inject({ method: 'GET', url })).json();

before(async () => { await app.ready(); });

const day1 = '2026-10-01';
const day2 = '2026-10-02';

const gammaEvents = [
  { id: 'G-1', symbol: 'GAMMA', tradingDay: day1, timestamp: '2026-10-01T09:30:00.000Z', sequence: 1, type: 'snapshot', bids: [{ price: 100, quantity: 100 }, { price: 99.9, quantity: 50 }], asks: [{ price: 100.1, quantity: 100 }, { price: 100.2, quantity: 50 }] },
  { id: 'G-2', symbol: 'GAMMA', tradingDay: day1, timestamp: '2026-10-01T09:30:01.000Z', sequence: 2, type: 'new_order', orderId: 'GO-2', side: 'buy', price: 99.98, quantity: 25 },
  { id: 'G-3', symbol: 'GAMMA', tradingDay: day1, timestamp: '2026-10-01T09:30:02.000Z', sequence: 3, type: 'trade', aggressorSide: 'sell', price: 100, quantity: 40 },
  // 新交易日从 sequence=1 重新开始
  { id: 'G-4', symbol: 'GAMMA', tradingDay: day2, timestamp: '2026-10-02T09:30:00.000Z', sequence: 1, type: 'snapshot', bids: [{ price: 101, quantity: 200 }], asks: [{ price: 101.1, quantity: 200 }] },
  { id: 'G-5', symbol: 'GAMMA', tradingDay: day2, timestamp: '2026-10-02T09:30:01.000Z', sequence: 2, type: 'trade', aggressorSide: 'buy', price: 101.1, quantity: 50 },
];

test('同一交易日的重复投递保持幂等，不重复改变状态', async () => {
  const event = { id: 'BETA-1', symbol: 'BETA', tradingDay: day1, timestamp: '2026-10-01T09:30:00.000Z', sequence: 1, type: 'snapshot', bids: [{ price: 50, quantity: 10 }], asks: [{ price: 50.1, quantity: 10 }] };
  const first = await post('/api/market-data/events', event);
  assert.equal(first.accepted, true);
  assert.equal(first.anomaly, undefined);

  const metricsBefore = await get('/api/metrics?symbol=BETA');
  const bookBefore = await get('/api/orderbook/BETA');

  // 客户端重试同一条事件（连投两次）：必须被拒且状态不变
  for (let i = 0; i < 2; i++) {
    const retry = await post('/api/market-data/events', event);
    assert.equal(retry.accepted, false);
    assert.equal(retry.anomaly.type, 'duplicate_sequence');
    assert.equal(retry.anomaly.severity, 'medium');
    assert.equal(retry.anomaly.symbol, 'BETA');
    assert.equal(retry.anomaly.sequence, 1);
  }

  const metricsAfter = await get('/api/metrics?symbol=BETA');
  const bookAfter = await get('/api/orderbook/BETA');
  assert.equal(metricsAfter.eventCount, metricsBefore.eventCount);
  assert.deepEqual(bookAfter.bids, bookBefore.bids);
  assert.deepEqual(bookAfter.asks, bookBefore.asks);
  assert.deepEqual(bookAfter.stats, bookBefore.stats);

  // 异常记录仍然保留
  const anomalies = await get('/api/anomalies');
  assert.ok(anomalies.filter((a: any) => a.type === 'duplicate_sequence' && a.symbol === 'BETA').length >= 2);
});

test('不同 tradingDay 的相同 sequence 能正常进入各自历史', async () => {
  for (const event of gammaEvents) {
    const result = await post('/api/market-data/events', event);
    assert.equal(result.accepted, true, `${event.id} 应被接受`);
    assert.equal(result.anomaly, undefined);
  }
  // 跨日同序号不应产生 duplicate_sequence 异常
  const anomalies = await get('/api/anomalies');
  assert.equal(anomalies.filter((a: any) => a.type === 'duplicate_sequence' && a.symbol === 'GAMMA').length, 0);

  // 新日开场行情已作用于订单簿（day2 最后一笔：买 50 @ 101.1）
  const book = await get('/api/orderbook/GAMMA');
  assert.deepEqual(book.bids, [{ price: 101, quantity: 200 }]);
  assert.deepEqual(book.asks, [{ price: 101.1, quantity: 150 }]);
  assert.equal(book.stats.tradeCount, 2);
  assert.equal(book.stats.tradedQuantity, 90);
});

test('按交易日创建的 replay session 只看到属于该日的数据', async () => {
  // day1 回放：逐单步进
  const session1 = await post('/api/replay/sessions', { symbol: 'GAMMA', tradingDay: day1 });
  assert.equal(session1.eventCount, 3);
  assert.equal(session1.nextEvent.id, 'G-1');
  const seen: string[] = [];
  let step;
  do {
    step = await post(`/api/replay/sessions/${session1.id}/step`, {});
    if (step.event) {
      seen.push(step.event.id);
      assert.equal(step.event.tradingDay, day1);
    }
  } while (!step.done);
  assert.deepEqual(seen, ['G-1', 'G-2', 'G-3']);
  // day1 终态盘口：snapshot + 挂买 99.98x25 + 卖 40 吃掉 100 档
  assert.deepEqual(step.book.bids, [{ price: 100, quantity: 60 }, { price: 99.98, quantity: 25 }, { price: 99.9, quantity: 50 }]);
  assert.deepEqual(step.book.asks, [{ price: 100.1, quantity: 100 }, { price: 100.2, quantity: 50 }]);
  const state1 = await get(`/api/replay/sessions/${session1.id}`);
  assert.equal(state1.progress, 100);
  assert.equal(state1.currentEvent.id, 'G-3');
  assert.equal(state1.nextEvent, undefined);

  // day2 回放：一次跑完，book 只含 day2 数据（session 独立订单簿）
  const session2 = await post('/api/replay/sessions', { symbol: 'GAMMA', tradingDay: day2 });
  assert.equal(session2.eventCount, 2);
  assert.equal(session2.nextEvent.id, 'G-4');
  const run = await post(`/api/replay/sessions/${session2.id}/run`, {});
  assert.equal(run.processed, 2);
  assert.equal(run.done, true);
  assert.deepEqual(run.book.bids, [{ price: 101, quantity: 200 }]);
  assert.deepEqual(run.book.asks, [{ price: 101.1, quantity: 150 }]);
  const state2 = await get(`/api/replay/sessions/${session2.id}`);
  assert.equal(state2.currentEvent.id, 'G-5');
  assert.equal(state2.currentEvent.tradingDay, day2);
});

test('空交易日查询：eventCount 为 0 且立即完成', async () => {
  const session = await post('/api/replay/sessions', { symbol: 'GAMMA', tradingDay: '2099-01-01' });
  assert.equal(session.eventCount, 0);
  assert.equal(session.status, 'ready');
  assert.equal(session.nextEvent, undefined);

  const state = await get(`/api/replay/sessions/${session.id}`);
  assert.equal(state.progress, 100);
  assert.equal(state.currentEvent, undefined);
  assert.equal(state.nextEvent, undefined);

  const step = await post(`/api/replay/sessions/${session.id}/step`, {});
  assert.equal(step.done, true);
  assert.equal(step.status, 'completed');

  const run = await post(`/api/replay/sessions/${session.id}/run`, {});
  assert.equal(run.processed, 0);
  assert.equal(run.done, true);
});
