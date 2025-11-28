import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Overview } from "@/components/dashboard/overview";
import { storage } from "@/lib/storage";
import { getBalance, calculateTotalBalanceUsdt } from "@/lib/binance";
import { DollarSign, Activity, CreditCard, TrendingUp, CheckCircle2, XCircle } from "lucide-react";
import { getStrategyConfig } from "@/lib/strategyConfig";
import { selectTradablePairs } from "@/lib/pairSelection";

export const dynamic = 'force-dynamic';

async function getDashboardData() {
    let connectionStatus = 'disconnected';
    let connectionError = '';
    let liveBalance = null;

    try {
        // 1. Try to fetch live balance from Binance
        const balance = await getBalance();
        connectionStatus = 'connected';

        // Calculate total USDT balance using real-time prices
        const { totalUsdt } = await calculateTotalBalanceUsdt(balance);

        liveBalance = totalUsdt;

        // 2. Save snapshot to DB
        await storage.addSnapshot({
            total_balance_usdt: totalUsdt,
            positions: JSON.stringify(balance)
        });

    } catch (error: any) {
        console.error("Failed to fetch live data:", error);
        connectionStatus = 'error';
        connectionError = error.message || 'Unknown error';
    }

    // 3. Fetch history and other data from DB
    const latestSnapshot = (await storage.getLatestSnapshot()) || { total_balance_usdt: 0 };

    const history = await storage.getSnapshotsSince(new Date(Date.now() - 24 * 60 * 60 * 1000));

    const recentTrades = await storage.getTrades(5);

    // Calculate 24h stats
    const trades24hList = await storage.getTradesSince(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const trades24h = trades24hList.length;

    // Calculate Win Rate (all time)
    const { wins, total: totalClosed } = await storage.getWinRateStats();
    const winRate = totalClosed > 0 ? Math.round((wins / totalClosed) * 100) : 0;

    const strategyConfig = await getStrategyConfig();

    const tradedPairCount = await storage.getUniqueTradedPairsCount(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    const tradablePairs = await selectTradablePairs(strategyConfig);
    const activePairs = tradedPairCount > 0 ? tradedPairCount : tradablePairs.length;

    const botEnabled = (await storage.getSettings('bot_enabled')) === 'true';

    const lastConsultAm = await storage.getSettings('last_gpt_consult_am');
    const lastConsultPm = await storage.getSettings('last_gpt_consult_pm');

    const todaySnapshots = await storage.getSnapshotsSince(new Date(new Date().setHours(0, 0, 0, 0)));
    const dailyDrawdown = computeDailyDrawdown(todaySnapshots);

    return {
        latestSnapshot,
        history: history,
        recentTrades: recentTrades,
        connectionStatus,
        connectionError,
        liveBalance,
        activeStrategy: strategyConfig.name,
        activePairs,
        botEnabled,
        trades24h,
        winRate,
        strategyConfig,
        lastConsultAm: lastConsultAm || null,
        lastConsultPm: lastConsultPm || null,
        dailyDrawdown,
        tradablePairs
    };
}

export default async function DashboardPage() {
    const {
        latestSnapshot,
        history,
        recentTrades,
        connectionStatus,
        connectionError,
        liveBalance,
        activeStrategy,
        activePairs,
        botEnabled,
        trades24h,
        winRate,
        strategyConfig,
        lastConsultAm,
        lastConsultPm,
        dailyDrawdown,
        tradablePairs
    } = await getDashboardData();

    // Use live balance if available, otherwise fallback to DB snapshot
    const displayBalance = liveBalance !== null ? liveBalance : latestSnapshot.total_balance_usdt;

    return (
        <div className="flex-1 space-y-4 p-8 pt-6">
            <div className="flex items-center justify-between space-y-2">
                <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
                <div className="flex items-center space-x-2">
                    {connectionStatus === 'connected' ? (
                        <span className="flex items-center text-sm text-green-500 bg-green-100 px-2 py-1 rounded-full">
                            <CheckCircle2 className="mr-1 h-4 w-4" /> Connected
                        </span>
                    ) : (
                        <div className="flex items-center space-x-2">
                            <span className="flex items-center text-sm text-red-500 bg-red-100 px-2 py-1 rounded-full">
                                <XCircle className="mr-1 h-4 w-4" /> Disconnected
                            </span>
                            {connectionError && (
                                <span className="text-xs text-red-500 max-w-[200px] truncate" title={connectionError}>
                                    {connectionError}
                                </span>
                            )}
                        </div>
                    )}
                </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">
                            Total Balance
                        </CardTitle>
                        <DollarSign className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">${Number(displayBalance).toFixed(2)}</div>
                        <p className="text-xs text-muted-foreground">
                            Portfolio Value
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">
                            Active Strategy
                        </CardTitle>
                        <Activity className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{activeStrategy}</div>
                        <p className="text-xs text-muted-foreground">
                            {botEnabled ? 'Running' : 'Stopped'} on {activePairs} pair{activePairs === 1 ? '' : 's'}
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Trades (24h)</CardTitle>
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{trades24h}</div>
                        <p className="text-xs text-muted-foreground">
                            Executed in last 24h
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">
                            Win Rate
                        </CardTitle>
                        <TrendingUp className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">{winRate}%</div>
                        <p className="text-xs text-muted-foreground">
                            All time performance
                        </p>
                    </CardContent>
                </Card>
            </div>
            <Card>
                <CardHeader>
                    <CardTitle>Strategy Settings</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid gap-4 md:grid-cols-3">
                        <div>
                            <p className="text-sm text-muted-foreground">Strategy</p>
                            <p className="text-lg font-semibold">{strategyConfig.name}</p>
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">Pairs</p>
                            <p className="text-lg font-semibold">{tradablePairs.join(', ')}</p>
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">Risk</p>
                            <p className="text-lg font-semibold">
                                {Math.round(strategyConfig.allocationPerTrade * 100)}% per trade • min ${strategyConfig.minTradeUsd}
                            </p>
                        </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-3 mt-4">
                        <div>
                            <p className="text-sm text-muted-foreground">RSI Thresholds</p>
                            <p className="text-lg font-semibold">Buy &lt; {strategyConfig.indicators.rsiBuy} | Sell &gt; {strategyConfig.indicators.rsiSell}</p>
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">Bollinger Bands</p>
                            <p className="text-lg font-semibold">Period {strategyConfig.indicators.bbPeriod} • StdDev {strategyConfig.indicators.bbStdDev}</p>
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">Lookback</p>
                            <p className="text-lg font-semibold">{strategyConfig.timeframe.lookback} candles ({strategyConfig.timeframe.high}/{strategyConfig.timeframe.mid}/{strategyConfig.timeframe.low})</p>
                        </div>
                    </div>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>Risk & Advisory</CardTitle>
                </CardHeader>
                <CardContent>
                    <div className="grid gap-4 md:grid-cols-3">
                        <div>
                            <p className="text-sm text-muted-foreground">Risk per Trade</p>
                            <p className="text-lg font-semibold">
                                {Math.round(strategyConfig.risk.minRiskPerTrade * 100)}% - {Math.round(strategyConfig.risk.maxRiskPerTrade * 100)}%
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">Daily Drawdown Limit</p>
                            <p className="text-lg font-semibold">
                                {Math.round(strategyConfig.risk.maxDailyDrawdown * 100)}% {dailyDrawdown !== null && `| Today ${Math.round(dailyDrawdown * 100)}%`}
                            </p>
                        </div>
                        <div>
                            <p className="text-sm text-muted-foreground">GPT Advisory</p>
                            <p className="text-lg font-semibold">
                                AM: {formatConsult(lastConsultAm)} • PM: {formatConsult(lastConsultPm)}
                            </p>
                        </div>
                    </div>
                </CardContent>
            </Card>
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
                <Card className="col-span-4">
                    <CardHeader>
                        <CardTitle>Portfolio Value</CardTitle>
                    </CardHeader>
                    <CardContent className="pl-2">
                        <Overview data={history} />
                    </CardContent>
                </Card>
                <Card className="col-span-3">
                    <CardHeader>
                        <CardTitle>Recent Trades</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-8">
                            {recentTrades.map((trade: any) => (
                                <div key={trade.id} className="flex items-center">
                                    <div className="ml-4 space-y-1">
                                        <p className="text-sm font-medium leading-none">{trade.symbol}</p>
                                        <p className="text-sm text-muted-foreground">
                                            {trade.side.toUpperCase()} @ {Number(trade.price).toFixed(2)}
                                        </p>
                                    </div>
                                    <div className="ml-auto font-medium">
                                        {trade.side === 'buy' ? '-' : '+'}${Number(trade.cost).toFixed(2)}
                                    </div>
                                </div>
                            ))}
                            {recentTrades.length === 0 && <p className="text-sm text-muted-foreground">No trades yet.</p>}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

function computeDailyDrawdown(rows: any[]): number | null {
    if (!rows || rows.length === 0) return null;
    const balances = rows.map((r: any) => Number(r.total_balance_usdt));
    const start = balances[0];
    let peak = start;
    let maxDD = 0;
    for (const b of balances) {
        if (b > peak) peak = b;
        const dd = peak ? (b - peak) / peak : 0;
        if (dd < maxDD) maxDD = dd;
    }
    return maxDD;
}

function formatConsult(value: string | null) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
