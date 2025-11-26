import { NextResponse } from "next/server";
import { autoTuneStrategy } from "@/lib/autoTune";

export const dynamic = "force-dynamic";

export async function GET() {
    const result = await autoTuneStrategy();
    return NextResponse.json(result, { status: result.updated ? 200 : 500 });
}
