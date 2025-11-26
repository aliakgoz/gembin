import { binance } from './binance';
import { RSI, MACD, BollingerBands } from 'technicalindicators';
import { getStrategyConfig, StrategyConfig } from './strategyConfig';

export interface StrategyResult {
    action: 'BUY' | 'SELL' | 'HOLD';
    symbol: string;
    reason: string;
    price: number;
}

export async function analyzeMarket(symbol: string, config?: StrategyConfig): Promise<StrategyResult> {
    // Fetch config once per analysis if not provided by caller (cron batches reuse)
    const cfg = config || await getStrategyConfig();

    // Fetch recent candles (1h interval)
    const candles = await binance.fetchOHLCV(symbol, '1h', undefined, cfg.lookback);

    if (candles.length < 50) {
        return { action: 'HOLD', symbol, reason: 'Not enough data', price: 0 };
    }

    const closes = candles.map(c => c[4]).filter((c): c is number => c !== undefined);
    const currentPrice = closes[closes.length - 1];

    // Calculate Indicators
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const currentRSI = rsiValues[rsiValues.length - 1];

    const macdValues = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false,
    });
    const currentMACD = macdValues[macdValues.length - 1];

    const bbValues = BollingerBands.calculate({
        values: closes,
        period: cfg.bbPeriod,
        stdDev: cfg.bbStdDev,
    });
    const currentBB = bbValues[bbValues.length - 1];

    // Config-driven logic:
    // Buy if RSI is below configured buy threshold and price near/below lower band
    if (currentRSI < cfg.rsiBuy && currentPrice <= currentBB.lower * 1.01) {
        return { action: 'BUY', symbol, reason: `RSI < ${cfg.rsiBuy} (${currentRSI.toFixed(2)}) + Lower BB`, price: currentPrice };
    }

    // Sell if RSI is above configured sell threshold or price touches upper band
    if (currentRSI > cfg.rsiSell || currentPrice >= currentBB.upper) {
        return { action: 'SELL', symbol, reason: `RSI > ${cfg.rsiSell} (${currentRSI.toFixed(2)}) or Upper BB`, price: currentPrice };
    }

    return { action: 'HOLD', symbol, reason: 'No signal', price: currentPrice };
}
