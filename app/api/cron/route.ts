import { NextResponse } from 'next/server';
import { binance, getBalance, calculateTotalBalanceUsdt, getTicker } from '@/lib/binance';
import { analyzeMarket, StrategyResult } from '@/lib/strategy';
import { storage } from '@/lib/storage';
import { autoTuneStrategy } from '@/lib/autoTune';
import { getStrategyConfig, StrategyConfig } from '@/lib/strategyConfig';
import { selectTradablePairs } from '@/lib/pairSelection';

export const dynamic = 'force-dynamic'; // static by default, unless reading the request

export async function GET(request: Request) {
    // Verify Cron Secret
    const authHeader = request.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Timeout Protection: Ensure we respond within 55s (Vercel limit is 60s)
    const TIMEOUT_MS = 55000;
    const timeoutPromise = new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error('Execution Timeout')), TIMEOUT_MS)
    );

    try {
        const logicPromise = (async () => {
            // 0. Heartbeat & Self-Healing
            await storage.updateHeartbeat();

            let isEnabled = (await storage.getSettings('bot_enabled')) === 'true';
            const expectedStatus = (await storage.getSettings('expected_status')) || 'running'; // Default to running if not set

            // Self-Healing: If stopped but expected to run, restart.
            if (!isEnabled && expectedStatus === 'running') {
                console.log("Self-Healing: Bot found stopped but expected to be running. Restarting...");
                await storage.setSettings('bot_enabled', 'true');
                await storage.addLog('info', 'Self-Healing: Bot restarted automatically.');
                isEnabled = true;
            }

            if (!isEnabled) return NextResponse.json({ message: 'Bot is disabled' });

            // --- MACRO SAFETY CHECK ---
            const safetyMode = await checkMacroSafety();
            if (safetyMode.active) {
                await storage.addLog('warn', `Safety Mode Active: ${safetyMode.reason}`, "Liquidating all positions.");
                // Liquidate all positions
                await liquidateAllPositions();
                return NextResponse.json({ message: `Safety Mode Active: ${safetyMode.reason}. Trading suspended.` });
            }

            // 1. Load Config & State
            const config = await getStrategyConfig();
            const pairs = await selectTradablePairs(config);

            // 2. Get Portfolio State
            const balance = await getBalance();
            const { totalUsdt, assets } = await calculateTotalBalanceUsdt(balance);
            let currentUsdt = Number((balance as any)?.total?.USDT ?? (balance as any)?.free?.USDT ?? 0);

            // Daily Drawdown Check
            const ddLimit = config.risk.maxDailyDrawdown;
            const dd = await computeDailyDrawdown();
            if (dd !== null && dd <= -ddLimit) {
                await storage.addLog('warn', 'Daily drawdown limit hit', JSON.stringify({ dd, limit: ddLimit }));
                return NextResponse.json({ message: 'Daily drawdown limit hit', dd });
            }

            // 3. Safety Check: Manage Open Positions (SL/TP/Trailing SL)
            // This runs first to protect capital
            await checkOpenPositions(config);

            // 4. Pass 1: Analyze All Pairs
            const analysisMap = new Map<string, StrategyResult>();
            const buySignals: StrategyResult[] = [];
            const sellSignals: StrategyResult[] = [];

            for (const symbol of pairs) {
                try {
                    const analysis = await analyzeMarket(symbol, config);
                    analysisMap.set(symbol, analysis);

                    if (analysis.action === 'BUY') {
                        buySignals.push(analysis);
                    } else if (analysis.action === 'SELL') {
                        sellSignals.push(analysis);
                    }
                } catch (e: any) {
                    console.error(`Error analyzing ${symbol}:`, e);
                }
            }

            const results = [];

            // 5. Pass 2: Execution

            // Step A: Execute SELL signals first to free up capital
            for (const analysis of sellSignals) {
                const baseAsset = analysis.symbol.split('/')[0];
                const assetData = assets.find(a => a.asset === baseAsset);

                if (assetData && assetData.usdtValue > config.minTradeUsd) {
                    try {
                        const order = await executeSell(analysis.symbol, assetData.amount, analysis.price, 'DynamicTrend');
                        currentUsdt += order.cost; // Update available USDT
                        results.push({ symbol: analysis.symbol, action: 'SELL', order });
                    } catch (e: any) {
                        results.push({ symbol: analysis.symbol, action: 'FAIL_SELL', error: e.message });
                    }
                }
            }

            // Step B: Execute BUY signals with Rebalancing
            // Sort buys by confidence (highest first)
            buySignals.sort((a, b) => b.confidence - a.confidence);

            for (const analysis of buySignals) {
                // Calculate target position size based on TOTAL Portfolio Value (not just free USDT)
                const targetSize = totalUsdt * config.allocationPerTrade;

                // Check if we already hold this asset
                const baseAsset = analysis.symbol.split('/')[0];
                const currentPosition = assets.find(a => a.asset === baseAsset);
                const currentVal = currentPosition ? currentPosition.usdtValue : 0;

                // If we already have enough, skip
                if (currentVal >= targetSize * 0.9) {
                    results.push({ symbol: analysis.symbol, action: 'HOLD', reason: 'Already at target allocation' });
                    continue;
                }

                let neededUsdt = targetSize - currentVal;
                // Clamp to max risk per trade if needed, though allocationPerTrade usually handles this

                if (neededUsdt < config.minTradeUsd) continue;

                // If we don't have enough USDT, try to liquidate weak positions
                if (currentUsdt < neededUsdt) {
                    // Find funding candidates: Assets we hold that are NOT in buySignals
                    // and have low confidence or HOLD signal
                    const candidates = assets.filter(a => {
                        if (a.asset === 'USDT') return false;
                        const sym = `${a.asset}/USDT`;
                        // Don't sell what we are trying to buy
                        if (sym === analysis.symbol) return false;
                        // Don't sell other strong buys
                        if (buySignals.find(b => b.symbol === sym)) return false;
                        return true;
                    });

                    // Sort candidates by confidence (lowest first) to sell junk first
                    // We need analysis for these assets. If not in 'pairs', we might not have analysis.
                    // For now, assume we only trade pairs in our list.
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
                        if (currentUsdt >= neededUsdt) break; // We have enough now

                        if (cand.asset.usdtValue > config.minTradeUsd) {
                            try {
                                // Sell this asset to fund the buy
                                const order = await executeSell(cand.symbol, cand.asset.amount, 0, 'Rebalance'); // 0 price = market
                                currentUsdt += order.cost;
                                results.push({ symbol: cand.symbol, action: 'LIQUIDATE', target: analysis.symbol, order });
                            } catch (e) {
                                console.error(`Failed to liquidate ${cand.symbol}`, e);
                            }
                        }
                    }
                }

                // Now check if we can buy
                // Use available USDT, capped by needed amount
                const amountToInvest = Math.min(currentUsdt, neededUsdt);

                if (amountToInvest > config.minTradeUsd) {
                    try {
                        const amount = amountToInvest / analysis.price;
                        const order = await executeBuy(analysis.symbol, amount, analysis.price, analysis.sl, analysis.tp, 'DynamicTrend');
                        currentUsdt -= order.cost;
                        results.push({ symbol: analysis.symbol, action: 'BUY', order });
                    } catch (e: any) {
                        results.push({ symbol: analysis.symbol, action: 'FAIL_BUY', error: e.message });
                    }
                } else {
                    results.push({ symbol: analysis.symbol, action: 'SKIP', reason: 'Insufficient funds after rebalance' });
                }
            }

            // 6. Snapshot & Auto-Tune
            await storage.addSnapshot({
                total_balance_usdt: totalUsdt,
                positions: JSON.stringify(assets)
            });

            const advisoryWindow = await pickAdvisoryWindow();
            const tuneResult = await autoTuneStrategy(advisoryWindow);

            // Update heartbeat again at the end
            await storage.updateHeartbeat();

            return NextResponse.json({ success: true, results, tuneResult });
        })();

        // Race against timeout
        return await Promise.race([logicPromise, timeoutPromise]) as NextResponse;

    } catch (error: any) {
        console.error('Cron failed:', error);
        // Try to log the error to storage if possible
        try { await storage.addLog('error', 'Cron execution failed', error.message); } catch { }

        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

// --- Helper Functions ---

async function checkMacroSafety() {
    const calendarStr = await storage.getSettings('economic_calendar');
    if (!calendarStr) return { active: false };

    try {
        const events = JSON.parse(calendarStr);
        if (!Array.isArray(events)) return { active: false };

        const now = new Date();
        const DANGER_PRE_HOURS = 4;
        const DANGER_POST_HOURS = 2;

        for (const ev of events) {
            if (ev.impact !== 'HIGH') continue;
            const eventTime = new Date(ev.date); // UTC
            if (isNaN(eventTime.getTime())) continue;

            const diffHours = (eventTime.getTime() - now.getTime()) / (1000 * 60 * 60);

            // If we are within [T-4h, T+2h]
            if (diffHours > -DANGER_POST_HOURS && diffHours < DANGER_PRE_HOURS) {
                return { active: true, reason: `High Impact Event: ${ev.event} at ${ev.date}` };
            }
        }
    } catch (e) {
        console.error("Error checking macro safety", e);
    }
    return { active: false };
}

async function liquidateAllPositions() {
    const openTrades = await storage.getOpenTrades();
    for (const trade of openTrades) {
        try {
            const ticker = await getTicker(trade.symbol);
            const currentPrice = ticker.last;
            if (!currentPrice) continue;

            await executeSell(trade.symbol, trade.amount, currentPrice, 'SafetyMode');
        } catch (e) {
            console.error(`Failed to liquidate ${trade.symbol}`, e);
        }
    }
}

// Helper functions for execution to keep main logic clean
async function executeBuy(symbol: string, amount: number, price: number, sl: number | undefined, tp: number | undefined, strategy: string) {
    const binanceOrder = await binance.createMarketBuyOrder(symbol, amount);
    const order = {
        id: binanceOrder.id,
        symbol,
        side: 'buy' as const,
        amount: binanceOrder.amount,
        price: binanceOrder.price || price,
        cost: binanceOrder.cost,
        status: 'open' as const
    };

    await storage.addTrade({
        symbol,
        side: 'buy',
        amount: order.amount,
        price: order.price,
        cost: order.cost,
        sl_price: sl,
        tp_price: tp,
        strategy,
        status: 'open',
        order_id: order.id
    });
    return order;
}

async function executeSell(symbol: string, amount: number, price: number, strategy: string) {
    const binanceOrder = await binance.createMarketSellOrder(symbol, amount);
    const order = {
        id: binanceOrder.id,
        symbol,
        side: 'sell' as const,
        amount: binanceOrder.amount,
        price: binanceOrder.price || price,
        cost: binanceOrder.cost,
        status: 'closed' as const
    };

    await storage.addTrade({
        symbol,
        side: 'sell',
        amount: order.amount,
        price: order.price,
        cost: order.cost,
        strategy,
        status: 'closed',
        order_id: order.id
    });

    await storage.updateTradeStatus(symbol, 'closed');
    return order;
}

async function computeDailyDrawdown(): Promise<number | null> {
    const snapshots = await storage.getSnapshotsSince(new Date(new Date().setHours(0, 0, 0, 0)));
    if (!snapshots.length) return null;
    const balances = snapshots.map((r: any) => Number(r.total_balance_usdt));
    const start = balances[0];
    let peak = start;
    let maxDD = 0;
    for (const b of balances) {
        if (b > peak) peak = b;
        const dd = peak ? (b - peak) / peak : 0;
        if (dd < maxDD) maxDD = dd;
    }
    return maxDD; // negative drawdown fraction
}

async function pickAdvisoryWindow(): Promise<"AM" | "PM" | "ADHOC"> {
    const now = new Date();
    const utc3Hour = (now.getUTCHours() + 3) % 24;
    const windowNow = utc3Hour >= 9 && utc3Hour <= 12 ? "AM" : utc3Hour >= 17 && utc3Hour <= 20 ? "PM" : null;

    const lastAm = await storage.getSettings('last_gpt_consult_am');
    const lastPm = await storage.getSettings('last_gpt_consult_pm');
    const amDone = isSameDay(lastAm);
    const pmDone = isSameDay(lastPm);

    if (windowNow === "AM" && !amDone) return "AM";
    if (windowNow === "PM" && !pmDone) return "PM";
    if (!amDone) return "AM";
    if (!pmDone) return "PM";
    return "ADHOC";
}

function isSameDay(dateStr?: string | null) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getUTCFullYear() === now.getUTCFullYear() &&
        d.getUTCMonth() === now.getUTCMonth() &&
        d.getUTCDate() === now.getUTCDate();
}

function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max);
}

async function checkOpenPositions(config: StrategyConfig) {
    const openTrades = await storage.getOpenTrades();

    for (const trade of openTrades) {
        try {
            const ticker = await getTicker(trade.symbol);
            const currentPrice = ticker.last;
            if (!currentPrice) continue;

            let action = null;
            let reason = '';

            // 1. Update Highest Price for Trailing SL
            let highest = trade.highest_price || trade.price;
            if (currentPrice > highest) {
                highest = currentPrice;
                // Update trade in memory for this run. 
                // Ideally we should persist this update to storage.
                // Since we don't have a direct updateTrade method exposed in this context easily without refactoring storage,
                // we will rely on the fact that if we don't sell, we continue holding.
                // BUT for Trailing SL to work across cron runs, we MUST persist 'highest_price'.
                // I will add a temporary hack to update it via a new storage method if possible, or just re-add the trade? No.
                // Let's assume for now we need to add `updateTrade` to storage.ts to make this persistent.
                // I will add `updateTrade` to storage.ts in a separate step if needed, but for now let's try to use what we have.
                // Actually, I can use `updateTradeStatus` if I modify it, or just add a new method.
                // For this step, I will assume I can't persist it yet and just log it, 
                // BUT I will add a TODO to implement `storage.updateTrade` properly.
                // Wait, I can just read the file, update, and write back using `storage` internal helpers if I was inside storage.ts.
                // Since I am in route.ts, I need a public method.
                // I will implement `storage.updateTrade` in the next step to ensure persistence.
                trade.highest_price = highest;
            }

            // 2. Check Trailing SL
            if (config.risk.trailingSlMultiplier) {
                // Simplified Trailing SL based on initial risk or fixed percentage
                // If we have an SL price, use the distance from entry to SL as 1R.
                // Trailing SL is usually set at X * R below highest price.

                const entryPrice = trade.price;
                const slPrice = trade.sl_price || (entryPrice * 0.95); // Default 5% risk if no SL
                const riskAmount = entryPrice - slPrice;

                // If trailingSlMultiplier is 2.0, we trail by 2 * RiskAmount
                // But usually Trailing SL is tighter. Let's use ATR based if possible.
                // If we don't have ATR, we use the config multiplier relative to the initial SL distance.
                // Let's say config.risk.trailingSlMultiplier is 2.0 (meaning 2 ATR).
                // And config.risk.slAtrMultiplier was 1.5.
                // So the trail distance is (2.0 / 1.5) * initial_risk_distance.

                const trailDistance = riskAmount * (config.risk.trailingSlMultiplier / config.risk.slAtrMultiplier);
                const trailingSlLevel = highest - trailDistance;

                // Only trigger if we are in profit significantly? 
                // Usually Trailing SL activates after some profit.
                // Let's say we only activate if highest > entry + riskAmount.
                // Or just always trail. Professional bots usually always trail if enabled.

                if (currentPrice < trailingSlLevel) {
                    action = 'sell';
                    reason = `Trailing SL Hit (High: ${highest.toFixed(4)}, Trail: ${trailingSlLevel.toFixed(4)})`;
                }
            }

            // 3. Check Fixed SL/TP
            if (!action) {
                if (trade.sl_price && currentPrice <= Number(trade.sl_price)) {
                    action = 'sell';
                    reason = 'Stop Loss Hit';
                }
                else if (trade.tp_price && currentPrice >= Number(trade.tp_price)) {
                    action = 'sell';
                    reason = 'Take Profit Hit';
                }
            }

            if (action === 'sell') {
                const amount = Number(trade.amount);
                const binanceOrder = await binance.createMarketSellOrder(trade.symbol, amount);

                const order = {
                    id: binanceOrder.id,
                    symbol: trade.symbol,
                    side: 'sell' as const,
                    amount: binanceOrder.amount,
                    price: binanceOrder.price || currentPrice,
                    cost: binanceOrder.cost,
                    status: 'closed' as const
                };

                await storage.addTrade({
                    symbol: trade.symbol,
                    side: 'sell',
                    amount: order.amount,
                    price: order.price,
                    cost: order.cost,
                    strategy: 'RiskManager',
                    status: 'closed',
                    order_id: order.id
                });

                await storage.closeTradeById(trade.id);
                await storage.addLog('info', `Risk Manager: ${reason} for ${trade.symbol}`, JSON.stringify({ trade, currentPrice, reason }));
            } else {
                // If we didn't sell, and highest_price changed, we should persist it.
                // I will call a new method `storage.updateTradeHighestPrice` which I will add next.
                if (trade.highest_price && trade.highest_price > (trade.price || 0)) {
                    await storage.updateTradeHighestPrice(trade.id, trade.highest_price);
                }
            }
        } catch (error: any) {
            console.error(`Error checking position for ${trade.symbol}`, error);
        }
    }
}
