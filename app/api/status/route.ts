import { NextResponse } from 'next/server';
import { getBalance, calculateTotalBalanceUsdt } from '@/lib/binance';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const balance = await getBalance();
        const { totalUsdt, assets } = await calculateTotalBalanceUsdt(balance);

        return NextResponse.json({
            status: 'connected',
            message: 'Successfully connected to Binance',
            balance: balance,
            totalUsdt,
            assets
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
