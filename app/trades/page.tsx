import { storage } from "@/lib/storage";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { format } from "date-fns";

export const dynamic = 'force-dynamic';

export default async function TradesPage() {
    const trades = await storage.getTrades(100);

    return (
        <div className="flex-1 space-y-4 p-8 pt-6">
            <div className="flex items-center justify-between space-y-2">
                <h2 className="text-3xl font-bold tracking-tight">Trade History</h2>
            </div>
            <div className="rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead>Symbol</TableHead>
                            <TableHead>Side</TableHead>
                            <TableHead>Price</TableHead>
                            <TableHead>Amount</TableHead>
                            <TableHead>Cost</TableHead>
                            <TableHead>Strategy</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {trades.map((trade: any) => (
                            <TableRow key={trade.id}>
                                <TableCell>{format(new Date(trade.timestamp), 'yyyy-MM-dd HH:mm:ss')}</TableCell>
                                <TableCell className="font-medium">{trade.symbol}</TableCell>
                                <TableCell className={trade.side === 'buy' ? 'text-green-500' : 'text-red-500'}>
                                    {trade.side.toUpperCase()}
                                </TableCell>
                                <TableCell>${Number(trade.price).toFixed(4)}</TableCell>
                                <TableCell>{Number(trade.amount).toFixed(4)}</TableCell>
                                <TableCell>${Number(trade.cost).toFixed(2)}</TableCell>
                                <TableCell>{trade.strategy}</TableCell>
                            </TableRow>
                        ))}
                        {trades.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={7} className="text-center">No trades found</TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </div>
        </div>
    );
}
