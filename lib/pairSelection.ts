import { binance, getBalance } from "./binance";
import { StrategyConfig } from "./strategyConfig";

type PairInfo = {
    symbol: string;
    volume: number;
    spread: number;
    volatility: number;
};

const DEFAULT_MAX_RESULTS = 12;

export async function selectTradablePairs(config: StrategyConfig): Promise<string[]> {
    try {
        const balance = await getBalance();
        const tickers = await binance.fetchTickers();
        const candidates: PairInfo[] = [];
        const heldPairs = new Set<string>();

        if (balance && (balance as any).total) {
            for (const [asset, amount] of Object.entries((balance as any).total as Record<string, number>)) {
                const qty = Number(amount);
                if (!qty || !Number.isFinite(qty)) continue;
                if (asset === "USDT") continue;
                const sym = `${asset}/USDT`;
                heldPairs.add(sym);
            }
        }

        for (const [symbol, ticker] of Object.entries(tickers)) {
            if (!symbol.endsWith("/USDT")) continue;
            const t: any = ticker;
            const volume = Number(t.quoteVolume ?? t.baseVolume ?? 0);
            if (!Number.isFinite(volume) || volume <= 0) continue;

            const bid = Number(t.bid ?? 0);
            const ask = Number(t.ask ?? 0);
            const last = Number(t.last ?? 0);
            if (!last || !Number.isFinite(bid) || !Number.isFinite(ask)) continue;

            const spread = last > 0 ? Math.abs(ask - bid) / last : 0;
            const high = Number(t.high ?? last);
            const low = Number(t.low ?? last);
            const volatility = last > 0 ? Math.abs(high - low) / last : 0;

            candidates.push({ symbol, volume, spread, volatility });
        }

        const volumeThresh = Number(process.env.PAIR_VOLUME_USDT_MIN || 5_000_000); // default $5m 24h
        const spreadThresh = Number(process.env.PAIR_SPREAD_MAX || 0.0025); // 0.25%
        const volLow = config.regime.volLow;
        const volHigh = config.regime.volHigh;

        const filtered = candidates
            .filter(c => c.volume >= volumeThresh)
            .filter(c => c.spread <= spreadThresh)
            .filter(c => c.volatility >= volLow && c.volatility <= volHigh * 2); // allow a bit above high

        const sorted = filtered.sort((a, b) => b.volume - a.volume);
        const limit = Math.min(config.risk.maxPairs, DEFAULT_MAX_RESULTS);

        // Start with held pairs so existing positions are always tradable
        const picked: string[] = Array.from(heldPairs);
        for (const c of sorted) {
            if (picked.length >= limit) break;
            if (!picked.includes(c.symbol)) picked.push(c.symbol);
        }

        if (picked.length > 0) return picked;
    } catch (error) {
        console.error("Pair selection failed, falling back to config.pairs", error);
    }

    return config.pairs;
}
