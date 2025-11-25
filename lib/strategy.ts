import { binance } from './binance';
import { RSI, MACD, BollingerBands } from 'technicalindicators';

export interface StrategyResult {
    action: 'BUY' | 'SELL' | 'HOLD';
    symbol: string;
    reason: string;
    price: number;
}

export async function analyzeMarket(symbol: string): Promise<StrategyResult> {
    // Fetch recent candles (1h interval, 100 limit)
    const candles = await binance.fetchOHLCV(symbol, '1h', undefined, 100);

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
        period: 20,
        stdDev: 2,
    });
    const currentBB = bbValues[bbValues.length - 1];

    // Strategy Logic: Dynamic Trend Follower
    // BUY: RSI < 30 (Oversold) AND MACD Histogram > 0 (Momentum up) AND Price < Lower Band (Mean Reversion)
    // SELL: RSI > 70 (Overbought) OR Price > Upper Band

    // Simplified for robustness:
    // Buy if RSI is low and price is bouncing off lower band
    if (currentRSI < 35 && currentPrice <= currentBB.lower * 1.01) {
        return { action: 'BUY', symbol, reason: `RSI Oversold (${currentRSI.toFixed(2)}) + Lower BB`, price: currentPrice };
    }

    // Sell if RSI is high
    if (currentRSI > 70 || currentPrice >= currentBB.upper) {
        return { action: 'SELL', symbol, reason: `RSI Overbought (${currentRSI.toFixed(2)}) or Upper BB`, price: currentPrice };
    }

    return { action: 'HOLD', symbol, reason: 'No signal', price: currentPrice };
}
