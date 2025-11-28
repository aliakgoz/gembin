import { NextResponse } from 'next/server';
import { binance, getBalance, calculateTotalBalanceUsdt, getTicker } from '@/lib/binance';
import { analyzeMarket, StrategyResult } from '@/lib/strategy';
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

        // 5. Pass 1: Analyze All Pairs
        const analysisMap = new Map<string, StrategyResult>();
        const buySignals: StrategyResult[] = [];
        const sellSignals: StrategyResult[] = [];
        const analysisResults: any[] = [];

        for (const symbol of pairs) {
            try {
                log(`Analyzing ${symbol}...`);
                const analysis = await analyzeMarket(symbol, config);
                analysisMap.set(symbol, analysis);

                if (analysis.action === 'BUY') {
                    buySignals.push(analysis);
                } else if (analysis.action === 'SELL') {
                    sellSignals.push(analysis);
                }

                analysisResults.push({ symbol, analysis, decision: 'ANALYZED' });

            } catch (e: any) {
                log(`Error analyzing ${symbol}`, e.message);
                analysisResults.push({ symbol, error: e.message });
            }
        }

        // 6. Pass 2: Execution Simulation
        const executionPlan: any[] = [];

        // Step A: SELLs
        for (const analysis of sellSignals) {
            const baseAsset = analysis.symbol.split('/')[0];
            const assetData = (balance as any)?.total?.[baseAsset] || 0;

            executionPlan.push({ action: 'SELL', symbol: analysis.symbol, reason: 'Signal' });
        }

        // Step B: BUYs with Rebalancing
        buySignals.sort((a, b) => b.confidence - a.confidence);

        const { totalUsdt, assets } = await calculateTotalBalanceUsdt(balance);
        let simUsdt = usdtBalance;

        for (const analysis of buySignals) {
            const targetSize = totalUsdt * config.allocationPerTrade;
            const baseAsset = analysis.symbol.split('/')[0];
            const currentPosition = assets.find(a => a.asset === baseAsset);
            const currentVal = currentPosition ? currentPosition.usdtValue : 0;

            if (currentVal >= targetSize * 0.9) {
                executionPlan.push({ action: 'HOLD', symbol: analysis.symbol, reason: 'Already at target' });
                continue;
            }

            let neededUsdt = targetSize - currentVal;

            if (simUsdt < neededUsdt) {
                // Find funding candidates
                const candidates = assets.filter(a => {
                    if (a.asset === 'USDT') return false;
                    const sym = `${a.asset}/USDT`;
                    if (sym === analysis.symbol) return false;
                    if (buySignals.find(b => b.symbol === sym)) return false;
                    return true;
                });

                // Sort by confidence
                const scoredCandidates = candidates.map(c => {
                    const sym = `${c.asset}/USDT`;
                    const anal = analysisMap.get(sym);
                    return {
                        asset: c,
                        confidence: anal ? anal.confidence : 0,
                        symbol: sym
                    };
                }).sort((a, b) => a.confidence - b.confidence);

                for (const cand of scoredCandidates) {
                    if (simUsdt >= neededUsdt) break;
                    executionPlan.push({
                        action: 'LIQUIDATE',
                        symbol: cand.symbol,
                        target: analysis.symbol,
                        amount: cand.asset.amount,
                        value: cand.asset.usdtValue
                    });
                    simUsdt += cand.asset.usdtValue;
                }
            }

            if (simUsdt > config.minTradeUsd) {
                executionPlan.push({ action: 'BUY', symbol: analysis.symbol, amountUsd: Math.min(simUsdt, neededUsdt) });
                simUsdt -= Math.min(simUsdt, neededUsdt);
            } else {
                executionPlan.push({ action: 'SKIP', symbol: analysis.symbol, reason: 'Insufficient funds' });
            }
        }

        return NextResponse.json({
            success: true,
            debugLog,
            analysisResults,
            executionPlan,
            portfolio: { totalUsdt, assets }
        });

    } catch (error: any) {
        return NextResponse.json({ error: error.message, stack: error.stack }, { status: 500 });
    }
}
