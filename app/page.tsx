import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Overview } from "@/components/dashboard/overview";
import { db } from "@/lib/db";
import { DollarSign, Activity, CreditCard, TrendingUp } from "lucide-react";

export const dynamic = 'force-dynamic';

async function getDashboardData() {
    // Fetch latest snapshot
    const snapshotRes = await db.query("SELECT * FROM portfolio_snapshots ORDER BY timestamp DESC LIMIT 1");
    const latestSnapshot = snapshotRes.rows[0] || { total_balance_usdt: 0 };

    // Fetch history for chart (last 24h)
    const historyRes = await db.query("SELECT * FROM portfolio_snapshots WHERE timestamp > NOW() - INTERVAL '24 hours' ORDER BY timestamp ASC");

    // Fetch recent trades
    const tradesRes = await db.query("SELECT * FROM trades ORDER BY timestamp DESC LIMIT 5");

    return {
        latestSnapshot,
        history: historyRes.rows,
        recentTrades: tradesRes.rows
    };
}

export default async function DashboardPage() {
    const { latestSnapshot, history, recentTrades } = await getDashboardData();

    return (
        <div className="flex-1 space-y-4 p-8 pt-6">
            <div className="flex items-center justify-between space-y-2">
                <h2 className="text-3xl font-bold tracking-tight">Dashboard</h2>
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
                        <div className="text-2xl font-bold">${Number(latestSnapshot.total_balance_usdt).toFixed(2)}</div>
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
