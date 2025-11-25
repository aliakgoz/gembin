import { NextResponse } from 'next/server';
import { binance, getBalance } from '@/lib/binance';
import { analyzeMarket } from '@/lib/strategy';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic'; // static by default, unless reading the request

export async function GET(request: Request) {
    // Verify Cron Secret (optional but recommended)
    const authHeader = request.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // 1. Check if Bot is Enabled
        const settingsRes = await db.query("SELECT value FROM settings WHERE key = 'bot_enabled'");
        const isEnabled = settingsRes.rows[0]?.value === 'true';

        if (!isEnabled) {
            console.log('Bot is disabled');
            return NextResponse.json({ message: 'Bot is disabled' });
        }

        // 2. Get Active Pairs
        // Default to top pairs if not set
        const pairs = ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT', 'XRP/USDT'];

        const results = [];

        // 3. Analyze & Execute
        for (const symbol of pairs) {
            try {
                const analysis = await analyzeMarket(symbol);

                if (analysis.action === 'BUY') {
                    // Check Balance
                    const balance = await getBalance();
                    const usdtBalance = balance['USDT']?.free || 0;

                    // Use 10% of available USDT per trade (Simple Risk Management)
                    const tradeAmountUSDT = usdtBalance * 0.1;

                    if (tradeAmountUSDT > 10) { // Min trade size usually $10
                        const amount = tradeAmountUSDT / analysis.price;
                        // Execute Market Buy
                        // const order = await binance.createMarketBuyOrder(symbol, amount);
                        // For safety, we'll just log it as a "Paper Trade" for now until verified
                        const order = { id: 'paper_' + Date.now(), symbol, side: 'buy', amount, price: analysis.price, cost: tradeAmountUSDT, status: 'closed' };

                        await db.query(
                            "INSERT INTO trades (symbol, side, amount, price, cost, strategy, status, order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                            [symbol, 'buy', amount, analysis.price, tradeAmountUSDT, 'DynamicTrend', 'closed', order.id]
                        );
                        results.push({ symbol, action: 'BUY', order });
                    } else {
                        results.push({ symbol, action: 'SKIP', reason: 'Insufficient funds' });
                    }

                } else if (analysis.action === 'SELL') {
                    // Check Asset Balance
                    const baseAsset = symbol.split('/')[0];
                    const balance = await getBalance();
                    const assetBalance = balance[baseAsset]?.free || 0;

                    if (assetBalance * analysis.price > 10) {
                        // Execute Market Sell (Sell all)
                        // const order = await binance.createMarketSellOrder(symbol, assetBalance);
                        const order = { id: 'paper_' + Date.now(), symbol, side: 'sell', amount: assetBalance, price: analysis.price, cost: assetBalance * analysis.price, status: 'closed' };

                        await db.query(
                            "INSERT INTO trades (symbol, side, amount, price, cost, strategy, status, order_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                            [symbol, 'sell', assetBalance, analysis.price, assetBalance * analysis.price, 'DynamicTrend', 'closed', order.id]
                        );
                        results.push({ symbol, action: 'SELL', order });
                    }
                } else {
                    results.push({ symbol, action: 'HOLD' });
                }

            } catch (e: any) {
                console.error(`Error processing ${symbol}:`, e);
                await db.query("INSERT INTO logs (level, message, meta) VALUES ($1, $2, $3)", ['error', `Error processing ${symbol}`, JSON.stringify({ error: e.message })]);
            }
        }

        // 4. Take Snapshot
        const totalBalance = await getBalance();
        // Calculate total USDT value (approx)
        let totalUSDT = totalBalance['USDT']?.total || 0;
        // Add other assets value (simplified)
        // In production, fetch prices for all assets. For now, just USDT.

        await db.query("INSERT INTO portfolio_snapshots (total_balance_usdt, positions) VALUES ($1, $2)", [totalUSDT, JSON.stringify(totalBalance)]);

        return NextResponse.json({ success: true, results });

    } catch (error: any) {
        console.error('Cron failed:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
