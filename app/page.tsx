import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Overview } from "@/components/dashboard/overview";
import { db } from "@/lib/db";
import { getBalance } from "@/lib/binance";
import { DollarSign, Activity, CreditCard, TrendingUp, CheckCircle2, XCircle } from "lucide-react";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"

export const dynamic = 'force-dynamic';

async function getDashboardData() {
    let connectionStatus = 'disconnected';
    let connectionError = '';
    let liveBalance = null;

    try {
        // 1. Try to fetch live balance from Binance
        const balance = await getBalance();
        connectionStatus = 'connected';

        // Calculate total USDT balance (simplified approximation)
        let totalUsdt = 0;
        if (balance.total) {
            // @ts-ignore
            totalUsdt = balance.total['USDT'] || balance.total['USD'] || 0;
        }

        liveBalance = totalUsdt;

        // 2. Save snapshot to DB
        await db.query(
            "INSERT INTO portfolio_snapshots (total_balance_usdt, positions) VALUES ($1, $2)",
            [totalUsdt, JSON.stringify(balance)]
        );

    } catch (error: any) {
        console.error("Failed to fetch live data:", error);
        connectionStatus = 'error';
        connectionError = error.message || 'Unknown error';
    }

    // 3. Fetch history and other data from DB as before
    const snapshotRes = await db.query("SELECT * FROM portfolio_snapshots ORDER BY timestamp DESC LIMIT 1");
    const latestSnapshot = snapshotRes.rows[0] || { total_balance_usdt: 0 };

    const historyRes = await db.query("SELECT * FROM portfolio_snapshots WHERE timestamp > NOW() - INTERVAL '24 hours' ORDER BY timestamp ASC");

    const tradesRes = await db.query("SELECT * FROM trades ORDER BY timestamp DESC LIMIT 5");

    return {
        latestSnapshot,
        history: historyRes.rows,
        recentTrades: tradesRes.rows,
        connectionStatus,
        connectionError,
        liveBalance
    };
}

export default async function DashboardPage() {
    const { latestSnapshot, history, recentTrades, connectionStatus, connectionError, liveBalance } = await getDashboardData();

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
                            +20.1% from last month
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
                        <div className="text-2xl font-bold">Dynamic Trend</div>
                        <p className="text-xs text-muted-foreground">
                            Running on 5 pairs
                        </p>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <CardTitle className="text-sm font-medium">Trades (24h)</CardTitle>
                        <CreditCard className="h-4 w-4 text-muted-foreground" />
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">+{recentTrades.length}</div>
                        <p className="text-xs text-muted-foreground">
                            +19% from yesterday
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
                        <div className="text-2xl font-bold">65%</div>
                        <p className="text-xs text-muted-foreground">
                            +2% from last week
                        </p>
                    </CardContent>
                </Card>
            </div>
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
