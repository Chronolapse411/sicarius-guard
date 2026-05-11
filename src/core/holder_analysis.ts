/**
 * SicariusGuard — Holder Concentration Analysis
 *
 * Detects rug risk by analyzing the distribution of token holders.
 * Uses Solana's getTokenLargestAccounts to check if supply is
 * concentrated in a few wallets (rug pull setup).
 *
 * @author Chronolapse411
 */

import { Connection, PublicKey } from '@solana/web3.js';

export interface HolderResult {
    concentrated: boolean;
    reason:       string;
    topHolders:   HolderInfo[];
    stats: {
        top1Pct:  number;
        top5Pct:  number;
        top10Pct: number;
        totalSupply: number;
    };
}

export interface HolderInfo {
    address:    string;
    amount:     number;
    pct:        number;
    decimals:   number;
}

/**
 * Analyze token holder concentration.
 *
 * @param connection  Solana RPC connection
 * @param mint        Token mint address
 * @returns           HolderResult with concentration flags and top holder details
 */
export async function analyzeHolders(
    connection: Connection,
    mint: string,
): Promise<HolderResult> {
    try {
        const mintPk = new PublicKey(mint);

        // Get the 20 largest token accounts for this mint
        const largestAccounts = await connection.getTokenLargestAccounts(mintPk);

        if (!largestAccounts.value || largestAccounts.value.length === 0) {
            return {
                concentrated: false,
                reason: 'No token accounts found',
                topHolders: [],
                stats: { top1Pct: 0, top5Pct: 0, top10Pct: 0, totalSupply: 0 },
            };
        }

        // Get total supply
        const supplyInfo = await connection.getTokenSupply(mintPk);
        const totalSupply = Number(supplyInfo.value.amount);
        const decimals = supplyInfo.value.decimals;

        if (totalSupply === 0) {
            return {
                concentrated: false,
                reason: 'Zero supply token',
                topHolders: [],
                stats: { top1Pct: 0, top5Pct: 0, top10Pct: 0, totalSupply: 0 },
            };
        }

        // Build holder list sorted by amount (descending)
        const holders: HolderInfo[] = largestAccounts.value
            .map(acct => ({
                address:  acct.address.toBase58(),
                amount:   Number(acct.amount),
                pct:      (Number(acct.amount) / totalSupply) * 100,
                decimals,
            }))
            .sort((a, b) => b.amount - a.amount);

        // Calculate concentration metrics
        const top1Pct  = holders[0]?.pct ?? 0;
        const top5Pct  = holders.slice(0, 5).reduce((s, h) => s + h.pct, 0);
        const top10Pct = holders.slice(0, 10).reduce((s, h) => s + h.pct, 0);

        // Concentration thresholds
        const isConcentrated =
            top1Pct > 50 ||   // Single holder owns >50%
            top5Pct > 80 ||   // Top 5 own >80%
            top10Pct > 90;    // Top 10 own >90%

        let reason: string;
        if (top1Pct > 50) {
            reason = `Top holder owns ${top1Pct.toFixed(1)}% — extreme concentration`;
        } else if (top5Pct > 80) {
            reason = `Top 5 holders own ${top5Pct.toFixed(1)}% — high concentration`;
        } else if (top10Pct > 90) {
            reason = `Top 10 holders own ${top10Pct.toFixed(1)}% — moderate concentration`;
        } else {
            reason = `Distribution OK — top holder ${top1Pct.toFixed(1)}%, top 5 ${top5Pct.toFixed(1)}%`;
        }

        return {
            concentrated: isConcentrated,
            reason,
            topHolders: holders.slice(0, 10), // return top 10
            stats: {
                top1Pct:  Math.round(top1Pct * 10) / 10,
                top5Pct:  Math.round(top5Pct * 10) / 10,
                top10Pct: Math.round(top10Pct * 10) / 10,
                totalSupply,
            },
        };

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            concentrated: false,
            reason: `Holder analysis error: ${msg}`,
            topHolders: [],
            stats: { top1Pct: 0, top5Pct: 0, top10Pct: 0, totalSupply: 0 },
        };
    }
}
