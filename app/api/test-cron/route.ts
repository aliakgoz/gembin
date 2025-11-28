import { NextResponse } from 'next/server';
import { binance, getBalance, calculateTotalBalanceUsdt, getTicker } from '@/lib/binance';
import { analyzeMarket } from '@/lib/strategy';
import { storage } from '@/lib/storage';
import { getStrategyConfig } from '@/lib/strategyConfig';
import { selectTradablePairs } from '@/lib/pairSelection';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    try {
        const debugLog: any[] = [];
        const log = (msg: string, data?: any) => debugLog.push({ msg, data });

        log("Starting Test Cron...");

        // 1. Check Settings
        const isEnabled = (await storage.getSettings('bot_enabled')) === 'true';
        log("Bot Enabled Status", isEnabled);

        // 2. Load Config
        const config = await getStrategyConfig();
        log("Strategy Config Loaded", config);

        const pairs = await selectTradablePairs(config);
        log("Selected Tradable Pairs", pairs);

        // 3. Check Balance
        const balance = await getBalance();
        const usdtBalance = Number((balance as any)?.total?.USDT ?? (balance as any)?.free?.USDT ?? 0);
        log("Current USDT Balance", usdtBalance);

        // 4. Analyze Each Pair
        const analysisResults = [];
        for (const symbol of pairs) {
            try {
                log(`Analyzing ${symbol}...`);
                const analysis = await analyzeMarket(symbol, config);

                const result: any = {
                    symbol,
                    analysis,
                    decision: 'HOLD',
                    reason: 'No action triggered'
                };

                if (analysis.confidence < config.regime.confidenceFloor) {
                    result.decision = 'SKIP';
                    result.reason = `Low confidence (${analysis.confidence} < ${config.regime.confidenceFloor})`;
                } else if (analysis.action === 'BUY') {
                    const riskPct = Math.min(Math.max(config.allocationPerTrade, config.risk.minRiskPerTrade), config.risk.maxRiskPerTrade);
                    const tradeAmountUSDT = usdtBalance * riskPct;

                    if (tradeAmountUSDT > config.minTradeUsd) {
                        result.decision = 'WOULD_BUY';
                        result.details = {
                            tradeAmountUSDT,
                            price: analysis.price,
                            amount: tradeAmountUSDT / analysis.price
                        };
                    } else {
                        result.decision = 'SKIP';
                        result.reason = `Insufficient funds for min trade (${tradeAmountUSDT.toFixed(2)} < ${config.minTradeUsd})`;
                    }
                } else if (analysis.action === 'SELL') {
                    const baseAsset = symbol.split('/')[0];
                    const assetBalance = Number((balance as any)?.total?.[baseAsset] ?? (balance as any)?.free?.[baseAsset] ?? 0);
                    const value = assetBalance * analysis.price;

                    if (value > config.minTradeUsd) {
                        result.decision = 'WOULD_SELL';
                        result.details = {
                            assetBalance,
                            value
                        };
                    } else {
                        result.decision = 'SKIP';
                        result.reason = `Asset value too low to sell (${value.toFixed(2)} < ${config.minTradeUsd})`;
                    }
                }

                analysisResults.push(result);

            } catch (e: any) {
                log(`Error analyzing ${symbol}`, e.message);
                analysisResults.push({ symbol, error: e.message });
            }
        }

        return NextResponse.json({
            success: true,
            debugLog,
            analysisResults
        });

    } catch (error: any) {
        return NextResponse.json({ error: error.message, stack: error.stack }, { status: 500 });
    }
}
