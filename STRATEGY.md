# Strategy notes — jackxyz launch-momentum scalp

## Idea

Most new pump.fun coins bleed out within minutes, but the ones that run do
so immediately and loudly. This bot buys only loud launches and gets out
fast:

- **Entry** (within 12 slots of the CreateEvent): at least 4 distinct
  non-creator buyers, at least 6 buy trades, at least 8 SOL of buy flow,
  at most 0.05 SOL sold, price at least +30% over the create price, real
  SOL reserves 2–40, no single buy over 3 SOL, no single buyer over 30%
  of the buy flow.
- **Size**: 0.32 SOL per coin (the harness's 1%-of-real-reserve cap binds
  first on most entries), at most 5 positions open, at most 4 SOL at cost.
- **Exits**: sell half at +20% (first take-profit), the rest on a trailing
  stop (arms at +12% from cost, exits on a 12% fall from the peak), a full
  take-profit at +60%, a hard stop at −10%, an exit when the creator sells,
  a stale exit (no trade for 40 slots), or a 120-slot time limit.

## Why these filters

The dev window (24 h, 1,222 universe mints) was analyzed before tuning:
buying the average launch loses money (mean price 200 slots after entry is
0.71× the entry price), so the entry filter has to do all the work. Two
things mattered most in sweeps on the local engine port:

- **No single big buyer** (`maxSingleBuySol` 3, `maxBuyerShare` 0.3):
  coins whose early flow is one wallet buying 3–6 SOL in a single slot get
  dumped by that wallet a few slots later (−60% in one slot — no stop can
  catch it). Capping single buys and buyer share removed the four worst
  trips (−0.04…−0.05 SOL each) and took the bot from −0.23 to ~0.
- **Take-profit at +20%**: selling the first half at +12% left too much on
  the table; +20% is the flat top of the sweep (0.18–0.25 all within
  ~0.03 SOL).

Pyramiding into winners was tried and dropped: adds bought tops and cut
the win rate from 25% to 19%.

## Backtest (dev window, `grade-local --driver process`)

- Net PnL **+0.460 SOL** (+4.6% on 10 SOL capital), 90% interval
  +0.098…+0.881 SOL — the whole interval is positive.
- 135 fills over 61 coins, 61 round trips, win rate 32.8%, max drawdown
  0.86%. Guardrails met (61 distinct coins ≥ 20, drawdown < 50%).
- Top 3 coins made 42% of the gains; without them net PnL is still
  +0.16 SOL.
- Fees: 0.141 SOL curve + 0.014 SOL tx; at 2× fees net PnL is still
  +0.30 SOL.
- Two graded executions reproduced byte for byte (deterministic: no clock,
  no environment, no randomness).

## Stress

`grade-local --stress` rebuilds the dev window from other coins' recorded
flow. A first 20-copy run was cut short by the local timeout after 2
copies, both positive (+0.23, +0.03 SOL); a 5-copy run is reported in the
final handoff. The dev score leans on a few winners, so the final window
(a fresh 24 h) is the real test — the rules above were picked in flat
regions of the sweep, not at single best cells.

## Files

- `main.ts` — entrypoint, runs the strategy through the kit SDK shim.
- `strategy.ts` — the whole strategy (entry signal, exits, probes).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored
  byte for byte; it owns the replay wire protocol.
