import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketEngine } from '../src/engine.js';
import type { MarketEvent } from '../src/types.js';

function event(partial: Partial<MarketEvent> & Pick<MarketEvent, 'symbol' | 'tradingDay' | 'sequence' | 'timestamp' | 'type'>): MarketEvent {
  return { id: `E-${partial.symbol}-${partial.tradingDay}-${partial.sequence}`, ...partial };
}

function snapshot(symbol: string, tradingDay: string, sequence: number, timestamp: string): MarketEvent {
  return event({
    symbol, tradingDay, sequence, timestamp, type: 'snapshot',
    bids: [{ price: 100, quantity: 100 }],
    asks: [{ price: 100.05, quantity: 100 }],
  });
}

test('同一交易日的重复投递保持幂等：拒收但不重复改变状态，异常与返回结构保留', () => {
  const engine = new MarketEngine();
  const symbol = 'DUP';
  const first = snapshot(symbol, '2026-10-01', 1, '2026-10-01T09:30:00.000Z');

  const accepted = engine.ingest(first);
  assert.deepEqual(accepted, { accepted: true });

  const eventsAfterAccept = engine.eventsForDay(symbol, '2026-10-01');
  assert.equal(eventsAfterAccept.length, 1);

  // 客户端重试同一条事件：必须拒收（幂等），不重复入列、不重复应用到订单簿
  const retried = engine.ingest({ ...first });
  assert.equal(retried.accepted, false);
  assert.ok(retried.anomaly, '重复投递仍需记录异常');
  assert.equal(retried.anomaly?.type, 'duplicate_sequence');
  assert.equal(retried.anomaly?.symbol, symbol);
  assert.equal(retried.anomaly?.sequence, 1);

  // 再次重试结果一致
  const retriedAgain = engine.ingest({ ...first });
  assert.equal(retriedAgain.accepted, false);
  assert.equal(retriedAgain.anomaly?.type, 'duplicate_sequence');

  assert.equal(engine.eventsForDay(symbol, '2026-10-01').length, 1);
  const dupAnomalies = engine.anomalies.filter(a => a.type === 'duplicate_sequence' && a.symbol === symbol);
  assert.equal(dupAnomalies.length, 2, '每次重复投递都保留一条异常记录');

  const book = engine.book(symbol).snapshot(10);
  assert.deepEqual(book.bids, [{ price: 100, quantity: 100 }]);
  assert.deepEqual(book.asks, [{ price: 100.05, quantity: 100 }]);
  assert.equal(engine.book(symbol).getStats().tradeCount, 0);
});

test('不同 tradingDay 的相同 sequence 各自独立进入历史，互不视为重复', () => {
  const engine = new MarketEngine();
  const symbol = 'CROSS';

  const dayA = snapshot(symbol, '2026-10-01', 1, '2026-10-01T09:30:00.000Z');
  const dayB = snapshot(symbol, '2026-10-02', 1, '2026-10-02T09:30:00.000Z');
  // 改一下新日盘口，确认新日 snapshot 确实被应用到订单簿
  dayB.bids = [{ price: 101, quantity: 200 }];
  dayB.asks = [{ price: 101.05, quantity: 200 }];

  assert.deepEqual(engine.ingest(dayA), { accepted: true });
  // 修复前：这里会因 symbol:sequence 键冲突被拒收
  assert.deepEqual(engine.ingest(dayB), { accepted: true });

  assert.equal(engine.eventsForDay(symbol, '2026-10-01').length, 1);
  assert.equal(engine.eventsForDay(symbol, '2026-10-02').length, 1);

  const bookA = engine.book(symbol).snapshot(10);
  assert.deepEqual(bookA.bids, [{ price: 101, quantity: 200 }]);
  assert.deepEqual(bookA.asks, [{ price: 101.05, quantity: 200 }]);
  assert.equal(bookA.sequence, 1);

  // 新日内继续 sequence=2 正常接入，且不会因跨日对比误报 gap
  const trade = event({ symbol, tradingDay: '2026-10-02', sequence: 2, timestamp: '2026-10-02T09:30:01.000Z', type: 'trade', aggressorSide: 'buy', price: 101.05, quantity: 50 });
  assert.deepEqual(engine.ingest(trade), { accepted: true });
  assert.equal(engine.eventsForDay(symbol, '2026-10-02').length, 2);
  assert.equal(engine.book(symbol).getStats().tradeCount, 1);

  assert.ok(!engine.anomalies.some(a => a.type === 'sequence_gap' && a.symbol === symbol), '跨日同序号不应产生 sequence_gap');
  // 两天各自再重投 sequence=1 仍按当日重复幂等拒收
  assert.equal(engine.ingest({ ...dayA }).accepted, false);
  assert.equal(engine.ingest({ ...dayB }).accepted, false);
  assert.equal(engine.eventsForDay(symbol, '2026-10-01').length, 1);
  assert.equal(engine.eventsForDay(symbol, '2026-10-02').length, 2);
});
