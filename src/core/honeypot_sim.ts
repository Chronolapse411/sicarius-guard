/**
 * SicariusGuard — Honeypot Detection via Jupiter Sell Simulation
 *
 * Detects honeypot tokens by simulating a sell order through Jupiter's Quote API.
 * If Jupiter can't find a route to sell the token back to SOL, it's likely a honeypot.
 *
 * Zero cost — only requests a quote, never executes a swap.
 *
 * @author Chronolapse411
 */

const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://api.jup.ag/swap/v1';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface HoneypotResult {
    isHoneypot:    boolean;
    sellable:      boolean;
    reason:        string;
    simulation?: {
        inputAmount:  string;
        outputAmount: string;
        priceImpact:  number | null;
        route:        string[];
    };
}

/**
 * Check if a token is a honeypot by simulating a sell via Jupiter.
 *
 * @param mint       Token mint address to check
 * @param amount     Amount in raw token units to simulate selling (default: 1000000)
 * @returns          HoneypotResult
 */
export async function checkHoneypot(
    mint: string,
    amount: string = '1000000',
): Promise<HoneypotResult> {
    try {
        // Simulate selling the token for SOL
        const params = new URLSearchParams({
            inputMint:   mint,
            outputMint:  SOL_MINT,
            amount:      amount,
            slippageBps: '500', // 5% slippage tolerance for illiquid tokens
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        let response: Response;
        try {
            response = await fetch(`${JUPITER_API_BASE}/quote?${params}`, {
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeout);
        }

        // No route found — can't sell this token
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            return {
                isHoneypot: true,
                sellable: false,
                reason: `Jupiter returned ${response.status}: ${errorText.slice(0, 200)}`,
            };
        }

        const quote = await response.json() as Record<string, unknown>;
        const outAmount = String(quote.outAmount ?? '0');

        // Zero output = can't actually sell
        if (outAmount === '0') {
            return {
                isHoneypot: true,
                sellable: false,
                reason: 'Jupiter returned outAmount = 0 — token cannot be sold',
            };
        }

        // Extract route info
        const routePlan = (quote.routePlan ?? []) as Array<Record<string, unknown>>;
        const route = routePlan.map(leg => {
            const swapInfo = leg.swapInfo as Record<string, unknown> | undefined;
            return String(swapInfo?.label ?? 'unknown');
        });

        const priceImpact = quote.priceImpactPct != null
            ? parseFloat(String(quote.priceImpactPct))
            : null;

        // Extreme price impact (>50%) is suspicious but not definitive
        const highImpact = priceImpact !== null && priceImpact > 50;

        return {
            isHoneypot: false,
            sellable: true,
            reason: highImpact
                ? `Sellable but extreme price impact (${priceImpact?.toFixed(1)}%)`
                : `Sellable via ${route.join(' → ')}`,
            simulation: {
                inputAmount: amount,
                outputAmount: outAmount,
                priceImpact,
                route,
            },
        };

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);

        if (msg.includes('abort') || msg.includes('timeout')) {
            return {
                isHoneypot: false,
                sellable: false,
                reason: 'Jupiter quote timed out — unable to determine (not conclusive)',
            };
        }

        return {
            isHoneypot: false,
            sellable: false,
            reason: `Honeypot check error: ${msg}`,
        };
    }
}
