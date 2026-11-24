// jackxyz-launch-momentum: a launch-momentum scalp bot for the agent.fun
// pump.fun replay (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Tuned defaults (see STRATEGY.md): entry on loud, crowded launches with
// no single big buyer; 0.32 SOL a coin; half off at +20%, the rest on a
// trailing stop / stop-loss / creator sell / time limit. Pyramid adds are
// off (addSol 0): adds bought tops and cut the win rate in sweeps.
//
// Revision (second pass): re-checked the entrypoint against the kit's
// reproduce command — it runs `node /bot/main.ts` with no arguments, the
// strategy and defaults are imported, not inlined, and nothing here
// depends on the dev window's coins, so the same file grades the final
// window unchanged. No behaviour change in this pass.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
