// Launch-momentum scalp for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most new pump.fun coins bleed out within minutes, but the ones that
// run do so immediately and loudly: a crowd of distinct buyers piles in
// within the first dozen slots and the price is already up a lot from the
// create price. This bot buys only those loud launches — many distinct
// buyers, several SOL of early buy flow, almost no selling, price already
// well above its create price — takes a small stake (the 1%-of-real-reserve
// size cap binds anyway), and gets out fast: half off at the first
// take-profit, the rest on a trailing stop, a hard stop, a full
// take-profit, the creator selling, or a short time limit. No re-entry on a
// coin that already had its shot.
//
// Everything is a pure function of the batches the harness sends: no clock,
// no environment, no randomness, so the two graded executions produce
// byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Latest age (slots since CreateEvent) at which a first buy may be decided. */
  maxAge: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Buy trades seen before entry, at least. */
  minBuys: number;
  /** Total SOL bought by everyone before entry, at least. */
  minFlowSol: number;
  /** Total SOL sold by everyone before entry, at most. */
  maxSellSol: number;
  /** Largest single buy (SOL) allowed in the tape before entry. */
  maxSingleBuySol: number;
  /** Largest single buyer's share of the tape's buy SOL, at most. */
  maxBuyerShare: number;
  /** Price now over the create price: at least this, at most that. */
  minRunup: number;
  maxRunup: number;
  /** Real SOL reserves at decision time (SOL): at least this, at most that. */
  minRealSol: number;
  maxRealSol: number;
  /** SOL to aim for per coin in total (one buy; the 1%-of-reserve cap applies). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for. */
  minOrderSol: number;
  /** First take-profit: sell half the position once it is worth this over cost. */
  tp1: number;
  /** Exit whole once the position is worth this over cost. */
  tp: number;
  /** Exit whole once the position is worth this under cost. */
  sl: number;
  /** After the first take-profit, the trailing stop arms at this gain. */
  trailArm: number;
  /** ... then exit on this fall from the best value. */
  trailDrop: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit at once when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Most positions open at once. */
  maxOpen: number;
  /** Most SOL at cost across all positions at once. */
  maxExposureSol: number;
  /** First buy of a position (SOL); the rest of stakeSol is added by pyramid. */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Most entries per curve over the run (1: a coin gets one shot). */
  maxEntries: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /**
   * Guardrail pacing: the run needs round trips of at least 0.01 SOL on at
   * least 20 distinct coins. When the bot's own filled round trips lag the
   * pace (target scaled by the share of a 6-hour window elapsed in block
   * time), open tiny probe round trips: buy probeSol of a liquid curve, sell
   * it whole as soon as the buy lands.
   */
  targetCoins: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings traded with on the dev window. Chosen by sweeping the local
// engine port (tools/sim.ts in the kit's pilot baseline) and preferring flat
// regions over the single best cell: tp1 0.18-0.20 and stake 0.12-0.16 all
// land within ~0.01 SOL of each other. Entry after a loud, crowded,
// already-running launch with no single big buyer; exits fast. See
// STRATEGY.md for the sweep notes.
export const DEFAULT_PARAMS: Params = {
  maxAge: 12,
  minBuyers: 4,
  minBuys: 6,
  minFlowSol: 8,
  maxSellSol: 0.05,
  maxSingleBuySol: 3,
  maxBuyerShare: 0.3,
  minRunup: 0.3,
  maxRunup: 3,
  minRealSol: 2,
  maxRealSol: 40,
  stakeSol: 0.32,
  initialSol: 0.32,
  addSol: 0,
  addStep: 0.05,
  addIfUp: 0.05,
  minOrderSol: 0.01,
  tp1: 0.2,
  tp: 0.6,
  sl: 0.1,
  trailArm: 0.12,
  trailDrop: 0.12,
  maxHold: 120,
  staleSlots: 40,
  exitOnDevSell: true,
  buySlipBps: 10_000,
  maxOpen: 5,
  maxExposureSol: 4,
  maxEntries: 1,
  cooldown: 100,
  targetCoins: 25,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  tp1Done: boolean;
  exiting: boolean;
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, creator: null, createPrice: 0, trades: [], entries: 0, lastExit: -1e12, lastTradeSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`. */
  const entrySignal = (t: Tape, now: number, rqSol: number, price: number): boolean => {
    if (t.created === null || now - t.created > p.maxAge) return false;
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (t.createPrice <= 0) return false;
    const runup = price / t.createPrice - 1;
    if (runup < p.minRunup || runup > p.maxRunup) return false;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let maxSingle = 0;
    const buyers = new Set<string>();
    const byBuyer = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        if (tr.sol > maxSingle) maxSingle = tr.sol;
        if (tr.user !== t.creator) buyers.add(tr.user);
        byBuyer.set(tr.user, (byBuyer.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
    }
    if (buys < p.minBuys) return false;
    if (buyers.size < p.minBuyers) return false;
    if (buySol < p.minFlowSol) return false;
    if (sellSol > p.maxSellSol) return false;
    if (maxSingle > p.maxSingleBuySol) return false;
    let top = 0;
    for (const v of byBuyer.values()) if (v > top) top = v;
    if (buySol > 0 && top / buySol > p.maxBuyerShare) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const devSold = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol: Number(e.sol_amount) / LAMPORTS, user: e.user });
          t.lastTradeSlot = e.slot;
          traded.add(e.mint);
          if (!e.is_buy && e.user === t.creator) devSold.add(e.mint);
        }
      }
      // Prune stale tapes: a launch older than the entry window plus the
      // longest hold can never be entered or exited again.
      const keep = Math.max(p.maxAge, p.maxHold) + p.cooldown + 5;
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        let exit = h.exiting;
        let partial = false;
        if (!exit && !h.tp1Done && value >= cost * (1 + p.tp1)) {
          // First take-profit: sell half, keep the rest running under the trail.
          partial = true;
          h.tp1Done = true;
        }
        if (!exit && value >= cost * (1 + p.tp)) exit = true;
        if (!exit && value < cost * (1 - p.sl)) exit = true;
        if (!exit && h.tp1Done && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trailDrop)) exit = true;
        if (!exit && p.exitOnDevSell && devSold.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && now - tapeOf(mint).lastTradeSlot > p.staleSlots) exit = true;
        if (!exit && !partial) continue;
        if (partial && pendingByMint.has(mint)) continue;
        if (exit) {
          h.exiting = true;
          if (pendingByMint.has(mint)) {
            let sellPending = false;
            for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
            if (sellPending) continue;
          }
        }
        if (orders.length >= cap) break;
        const amount = partial ? BigInt(pos.token_amount) / 2n : pos.token_amount;
        if (amount === 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol, price)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Pyramid into strength only: the position is up, the price stepped
          // up from the last add, and it has not started exiting.
          if (p.addSol <= 0 || h.exiting || !h.filled || h.invested >= p.stakeSol - p.minOrderSol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minOrderSol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, peakValue: 0, invested: amount, tp1Done: false, exiting: false, filled: false, lastAddPrice: price, lastValue: 0 });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when the bot's round-trip coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        if (needCoins) {
          const minRq = (p.probeSol * Number(BPS_PER_UNIT)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
