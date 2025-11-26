import { NextResponse } from 'next/server';
import { getBalance } from '@/lib/binance';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const balance = await getBalance();

        // Calculate total USDT balance
        // Note: This is a simplified calculation. Ideally, we should sum up (amount * price) for all assets.
        // For now, we'll assume 'total' in USDT if available, or just return the raw balance object for debugging.
        // Many exchanges provide a 'total' field in fetchBalance which is the estimated total in the quote currency or BTC.
        // Binance's fetchBalance usually returns 'total' and 'free' and 'used' for each coin.

        // We will try to find a total USDT value if provided, otherwise we might need to calculate it.
        // For this status check, returning success is the main goal.

        return NextResponse.json({
            status: 'connected',
            message: 'Successfully connected to Binance',
            balance: balance
        });
    } catch (error: any) {
        console.error("Binance connection error:", error);
        return NextResponse.json({
            status: 'error',
            message: error.message || 'Failed to connect to Binance',
            details: error.toString()
        }, { status: 500 });
    }
}
