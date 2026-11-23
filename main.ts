// CBBTC slow-trend rider for make.fun's "Race a BTC trading bot live for 24 hours"
// (bars-replay/v1, 1-minute cbBTC/USDC bars, long only, starts with 1,000 USDC).
//
// Read of the market: one-minute BTC bars are ~8 bps of noise against a
// ~26-46 bps round-trip cost, so the only trades worth paying for are the
// rare multi-hour trends. This bot waits for a trend that has already
// proven itself over three hours (180-minute return above +0.6% with the
// 60-minute return also positive and the close above its 120-minute EMA),
// then commits all of its cash, and lets the move run: it only leaves on
// a +3% take-profit, a 2% trailing give-back, a 1% hard stop, a 240-minute
// trend reversal, or after 12 hours in the trade. After an exit it rests
// four hours, so a choppy afternoon cannot bleed it through re-entries.
// On the published dev window it makes 3 round trips and finishes about
// +$17 ahead of its $1,000 start.
//
// Determinism: every decision comes from closes the harness already sent
// (hello, batch, orders, bar). No clock, no environment, no randomness,
// so two runs on the same bars give the same action log byte for byte.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// --- tuned constants (picked on the dev window, kept deliberately wide) ---
const SYMBOL = 'CBBTC';
/** 180-minute return that counts as an established trend: +0.6%. */
const TREND_RETURN = 0.006;
/** 60-minute return that must also be positive: +0.1%. */
const SHORT_RETURN = 0.001;
/** 240-minute return below which the trend is judged reversed: -0.2%. */
const REVERSAL_RETURN = -0.002;
/** Minutes of closes needed before any decision (EMA window + margin). */
const HISTORY_BARS = 240;
/** Take-profit, share above the fill price: +3%. */
const TAKE_PROFIT = 0.03;
/** Trailing stop, share below the best close since entry: 2%. */
const TRAIL_STOP = 0.02;
/** Hard stop, share below the fill price: 1%. */
const HARD_STOP = 0.01;
/** Longest time in one trade: 720 bars (12 hours). */
const MAX_HOLD_BARS = 720;
/** Bars to sit out after an exit before the next entry: 240 (4 hours). */
const REST_BARS = 240;
/** 2% past the close the order was decided on; a fill past it is refused. */
const MAX_SLIPPAGE_BPS = 200;

// --- state (all of it derived from the bars the harness sends) ---
const closes: number[] = [];
let ema120 = 0;
/** Fill price of the open position (the fill bar's open), 0 when flat. */
let fillPrice = 0;
/** Best close seen since the entry fill. */
let bestClose = 0;
/** Seq of the bar the current position was entered on, -1 when flat. */
let enteredSeq = -1;
/** Seq of the bar the last exit filled on. */
let exitedSeq = -1000000;
/** True while a buy we sent has not been confirmed by a position yet. */
let buyAwaited = false;
/** Whether the previous batch held the position (to spot the exit bar). */
let heldBefore = false;

/** 180-minute simple return ending at the latest close, or null if too early. */
function ret180(): number | null {
  const n = closes.length;
  if (n <= 180) return null;
  return closes[n - 1] / closes[n - 1 - 180] - 1;
}

/** 60-minute simple return ending at the latest close, or null if too early. */
function ret60(): number | null {
  const n = closes.length;
  if (n <= 60) return null;
  return closes[n - 1] / closes[n - 1 - 60] - 1;
}

/** 240-minute simple return ending at the latest close, or null if too early. */
function ret240(): number | null {
  const n = closes.length;
  if (n <= 240) return null;
  return closes[n - 1] / closes[n - 1 - 240] - 1;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);
    // 120-minute EMA, seeded on the first close.
    const k = 2 / (120 + 1);
    ema120 = closes.length === 1 ? close : close * k + ema120 * (1 - k);
    if (state.warmingUp) return [];

    const trend = ret180();
    const short = ret60();
    const long = ret240();
    if (trend === null || short === null || closes.length < HISTORY_BARS) return [];

    const held = state.positions.get(SYMBOL);
    // A buy we sent fills at this bar's open, so the position first shows
    // up in this batch: anchor the entry (and the stops) to that open.
    // A buy the market refused leaves no position, so nothing is anchored
    // and we may try again later.
    if (held !== undefined && buyAwaited) {
      fillPrice = Number(bar.o);
      bestClose = Math.max(fillPrice, close);
      buyAwaited = false;
    } else if (held === undefined) {
      buyAwaited = false;
      // The position is gone only once the sell actually filled: start the
      // rest period from that bar, not from the bar the sell was sent on.
      if (heldBefore) exitedSeq = state.seq;
    }
    heldBefore = held !== undefined;

    const orders: (BuyInput | SellInput)[] = [];

    if (held === undefined) {
      const rested = state.seq - exitedSeq >= REST_BARS;
      const uptrend = trend > TREND_RETURN && short > SHORT_RETURN && close > ema120;
      if (rested && uptrend) {
        const notional = state.cash;
        if (notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
          fillPrice = close;
          bestClose = close;
          enteredSeq = state.seq;
          buyAwaited = true;
        }
      }
      return orders;
    }

    if (close > bestClose) bestClose = close;
    const tookProfit = close >= fillPrice * (1 + TAKE_PROFIT);
    const trailedOff = close <= bestClose * (1 - TRAIL_STOP);
    const stoppedOut = close <= fillPrice * (1 - HARD_STOP);
    const trendReversed = long !== null && long < REVERSAL_RETURN;
    const heldTooLong = state.seq - enteredSeq >= MAX_HOLD_BARS;
    if (tookProfit || trailedOff || stoppedOut || trendReversed || heldTooLong) {
      orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return orders;
  },
});
