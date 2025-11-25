"use client"

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"

interface OverviewProps {
    data: any[];
}

export function Overview({ data }: OverviewProps) {
    return (
        <ResponsiveContainer width="100%" height={350}>
            <LineChart data={data}>
                <XAxis
                    dataKey="timestamp"
                    stroke="#888888"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                />
                <YAxis
                    stroke="#888888"
                    fontSize={12}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => `$${value}`}
                    domain={['auto', 'auto']}
                />
                <Tooltip
                    contentStyle={{ backgroundColor: '#1f2937', border: 'none' }}
                    labelFormatter={(value) => new Date(value).toLocaleString()}
                />
                <Line
                    type="monotone"
                    dataKey="total_balance_usdt"
                    stroke="#adfa1d"
                    strokeWidth={2}
                    activeDot={{
                        r: 8,
                        style: { fill: "#adfa1d" },
                    }}
                />
            </LineChart>
        </ResponsiveContainer>
    )
}
