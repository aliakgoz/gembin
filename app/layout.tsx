import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Sidebar from '@/components/sidebar';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
    title: 'Binance Bot',
    description: 'Automated Trading System',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en" className="dark">
            <body className={inter.className}>
                <div className="flex h-screen overflow-hidden">
                    <Sidebar />
                    <main className="flex-1 overflow-y-auto bg-background p-8">
                        {children}
                    </main>
                </div>
            </body>
        </html>
    );
}
