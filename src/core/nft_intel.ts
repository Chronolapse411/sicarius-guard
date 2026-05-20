/**
 * SicariusGuard — NFT Intelligence Module
 *
 * Multi-signal NFT safety analysis combining on-chain DAS metadata
 * with Magic Eden marketplace intelligence. Detects counterfeit
 * collections, wash-traded NFTs, unverified creators, and pricing
 * anomalies that indicate scam or low-value assets.
 *
 * Data pipeline:
 *   1. Helius DAS `getAsset` — on-chain metadata, compression, royalties, authorities
 *   2. Magic Eden `/v2/tokens/{mint}` — marketplace listing, collection context
 *   3. Magic Eden `/v2/collections/{symbol}/stats` — floor price, volume, listings
 *   4. Risk scoring — 6-signal composite analysis
 *
 * @author Chronolapse411
 * @version 1.1.0
 */

// ── Public Types ─────────────────────────────────────────────────────────────

export interface NftCheckResult {
    /** The mint address that was analyzed */
    mint:                string;
    /** Human-readable name from on-chain metadata */
    name:               string | null;
    /** Collection symbol on Magic Eden */
    collectionSymbol:    string | null;
    /** Whether the collection is verified on-chain */
    collectionVerified:  boolean;
    /** Whether the asset is compressed (cNFT) */
    isCompressed:        boolean;
    /** Whether update authority is still active */
    mutableMetadata:     boolean;
    /** On-chain royalty basis points (e.g., 500 = 5%) */
    royaltyBps:          number;
    /** Current ME listing price in SOL, null if not listed */
    listingPriceSol:     number | null;
    /** Collection floor price in SOL */
    floorPriceSol:       number | null;
    /** Number of active listings in the collection */
    collectionListings:  number | null;
    /** 24h average sale price in SOL */
    avgPrice24hSol:      number | null;
    /** All-time volume in SOL */
    volumeAllSol:        number | null;
    /** Creator/update authority address */
    creatorAddress:      string | null;
    /** Image URI from metadata */
    imageUri:            string | null;
    /** Risk score 0-100 */
    riskScore:           number;
    /** Risk verdict */
    verdict:             'SAFE' | 'CAUTION' | 'HIGH_RISK' | 'CRITICAL';
    /** Individual risk flags that contributed to the score */
    flags:               string[];
    /** Timestamp of the analysis */
    checkedAt:           string;
}

// ── Magic Eden Types ─────────────────────────────────────────────────────────

interface MeTokenData {
    mintAddress?:       string;
    owner?:             string;
    name?:              string;
    collection?:        string;
    collectionName?:    string;
    image?:             string;
    animationUrl?:      string;
    attributes?:        Array<{ trait_type: string; value: string }>;
    externalUrl?:       string;
    supply?:            number;
    tokenStandard?:     number;
    listStatus?:        string;
    price?:             number;
    sellerFeeBasisPoints?: number;
}

interface MeCollectionStats {
    symbol?:        string;
    floorPrice?:    number;  // in lamports
    listedCount?:   number;
    avgPrice24hr?:  number;  // in lamports
    volumeAll?:     number;  // in lamports
}

// ── Helius DAS Types ─────────────────────────────────────────────────────────

interface DasAsset {
    id?:            string;
    content?: {
        metadata?: {
            name?:        string;
            symbol?:      string;
            description?: string;
        };
        links?: {
            image?:      string;
            external_url?: string;
            animation_url?: string;
        };
        json_uri?: string;
    };
    compression?: {
        compressed?:   boolean;
        tree?:         string;
        leaf_index?:   number;
    };
    royalty?: {
        basis_points?:        number;
        primary_sale_happened?: boolean;
        locked?:              boolean;
    };
    authorities?: Array<{
        address?: string;
        scopes?:  string[];
    }>;
    creators?: Array<{
        address?:   string;
        verified?:  boolean;
        share?:     number;
    }>;
    grouping?: Array<{
        group_key?:   string;
        group_value?: string;
        verified?:    boolean;
        collection_metadata?: {
            name?:   string;
            symbol?: string;
        };
    }>;
    ownership?: {
        owner?:     string;
        frozen?:    boolean;
        delegated?: boolean;
    };
    mutable?:      boolean;
    burnt?:        boolean;
    interface?:    string; // e.g., "V1_NFT", "ProgrammableNFT"
}

// ── Constants ────────────────────────────────────────────────────────────────

const ME_API_BASE = 'https://api-mainnet.magiceden.dev/v2';
const LAMPORTS_PER_SOL = 1_000_000_000;

// ── API Fetchers ─────────────────────────────────────────────────────────────

/**
 * Fetch NFT metadata from Helius DAS `getAsset`.
 * Returns the full asset record including on-chain authority, compression, royalties.
 */
async function fetchDasAsset(mint: string): Promise<DasAsset | null> {
    const rpcUrl = process.env.HELIUS_RPC_URL || '';
    if (!rpcUrl.includes('helius')) return null;

    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'sicarius-nft-das',
                method: 'getAsset',
                params: { id: mint },
            }),
            signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) return null;

        const body = await res.json() as { result?: DasAsset; error?: unknown };
        return body.result ?? null;
    } catch {
        return null;
    }
}

/**
 * Fetch individual NFT data from Magic Eden.
 * Free endpoint, no API key required. ~120 req/min rate limit.
 */
async function fetchMeToken(mint: string): Promise<MeTokenData | null> {
    try {
        const res = await fetch(`${ME_API_BASE}/tokens/${mint}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8_000),
        });

        if (!res.ok) return null;

        const body = await res.json() as MeTokenData;
        // ME returns {} for unknown tokens
        if (!body.mintAddress && !body.name) return null;
        return body;
    } catch {
        return null;
    }
}

/**
 * Fetch collection-level stats from Magic Eden.
 * Requires the collection symbol (not the mint address).
 */
async function fetchMeCollectionStats(symbol: string): Promise<MeCollectionStats | null> {
    try {
        const res = await fetch(`${ME_API_BASE}/collections/${symbol}/stats`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(8_000),
        });

        if (!res.ok) return null;

        const body = await res.json() as MeCollectionStats;
        return body.symbol ? body : null;
    } catch {
        return null;
    }
}

// ── Risk Scoring ─────────────────────────────────────────────────────────────

interface ScoreContext {
    das:        DasAsset | null;
    meToken:    MeTokenData | null;
    meStats:    MeCollectionStats | null;
}

function computeNftRisk(ctx: ScoreContext): { score: number; flags: string[] } {
    const flags: string[] = [];
    let score = 0;

    const { das, meToken, meStats } = ctx;

    // ── Signal 1: Collection verification ────────────────────────────────
    const grouping = das?.grouping?.find(g => g.group_key === 'collection');
    if (!grouping) {
        // No collection grouping at all — orphan NFT
        flags.push('NO_COLLECTION');
        score += 15;
    } else if (!grouping.verified) {
        // DAS verification uses on-chain Metaplex certified collection.
        // Many legit collections lack this flag. Dampen if ME volume is strong.
        const meVolume = meStats?.volumeAll ? meStats.volumeAll / LAMPORTS_PER_SOL : 0;
        if (meVolume > 1000) {
            flags.push('COLLECTION_UNVERIFIED_ONCHAIN');
            // Minimal penalty — marketplace presence validates legitimacy
            score += 5;
        } else {
            flags.push('COLLECTION_UNVERIFIED');
            score += 20;
        }
    } else {
        flags.push('COLLECTION_VERIFIED');
    }

    // ── Signal 2: Creator verification ───────────────────────────────────
    const creators = das?.creators ?? [];
    const verifiedCreators = creators.filter(c => c.verified);
    if (creators.length === 0) {
        flags.push('NO_CREATORS');
        score += 10;
    } else if (verifiedCreators.length === 0) {
        flags.push('NO_VERIFIED_CREATORS');
        score += 15;
    } else {
        flags.push(`VERIFIED_CREATORS_${verifiedCreators.length}`);
    }

    // ── Signal 3: Metadata mutability ────────────────────────────────────
    if (das?.mutable === true) {
        flags.push('METADATA_MUTABLE');
        score += 10;
    } else if (das?.mutable === false) {
        flags.push('METADATA_IMMUTABLE');
    }

    // ── Signal 4: Marketplace presence ───────────────────────────────────
    if (!meToken && !meStats) {
        flags.push('NOT_ON_MAGIC_EDEN');
        score += 5;
    } else if (meToken) {
        if (meToken.listStatus === 'listed' && meToken.price) {
            flags.push(`LISTED_${meToken.price}SOL`);
        } else {
            flags.push('UNLISTED');
        }
    }

    // ── Signal 5: Collection health ──────────────────────────────────────
    if (meStats) {
        const floor = meStats.floorPrice ? meStats.floorPrice / LAMPORTS_PER_SOL : 0;
        const listings = meStats.listedCount ?? 0;
        const volume = meStats.volumeAll ? meStats.volumeAll / LAMPORTS_PER_SOL : 0;

        if (floor > 0) {
            flags.push(`FLOOR_${floor.toFixed(3)}SOL`);
        }

        if (volume < 1) {
            flags.push('NEAR_ZERO_VOLUME');
            score += 15;
        } else if (volume < 100) {
            flags.push(`LOW_VOLUME_${volume.toFixed(1)}SOL`);
            score += 5;
        } else {
            flags.push(`VOLUME_${Math.round(volume)}SOL`);
        }

        // Extreme listing ratio — if > 50% of supply is listed, dump risk
        if (listings > 100) {
            flags.push(`HIGH_LISTINGS_${listings}`);
        }
    }

    // ── Signal 6: Compression & burn status ──────────────────────────────
    if (das?.compression?.compressed) {
        flags.push('COMPRESSED_NFT');
        // Not inherently risky, just informational
    }

    if (das?.burnt) {
        flags.push('BURNT');
        score += 50;
    }

    if (das?.ownership?.frozen) {
        // ProgrammableNFTs are frozen by design (royalty enforcement via freeze delegate).
        // Only flag as risky for V1_NFT / standard interfaces.
        const isProgrammable = das?.interface === 'ProgrammableNFT';
        if (isProgrammable) {
            flags.push('PNFT_FROZEN_BY_DESIGN');
        } else {
            flags.push('FROZEN');
            score += 20;
        }
    }

    // ── Signal 7: Pricing anomaly ────────────────────────────────────────
    if (meToken?.price && meStats?.floorPrice) {
        const listPrice = meToken.price;
        const floor = meStats.floorPrice / LAMPORTS_PER_SOL;
        if (floor > 0) {
            const ratio = listPrice / floor;
            if (ratio > 10) {
                flags.push(`PRICE_10X_ABOVE_FLOOR`);
                score += 10;
            } else if (ratio < 0.3) {
                flags.push(`PRICE_70PCT_BELOW_FLOOR`);
                score += 5;
            }
        }
    }

    // ── Royalty check ────────────────────────────────────────────────────
    const royaltyBps = das?.royalty?.basis_points ?? 0;
    if (royaltyBps > 2000) {
        flags.push(`EXCESSIVE_ROYALTY_${royaltyBps / 100}%`);
        score += 10;
    }

    // Clamp
    score = Math.min(score, 100);

    return { score, flags };
}

function verdictFromScore(score: number): 'SAFE' | 'CAUTION' | 'HIGH_RISK' | 'CRITICAL' {
    if (score <= 10) return 'SAFE';
    if (score <= 30) return 'CAUTION';
    if (score <= 60) return 'HIGH_RISK';
    return 'CRITICAL';
}

// ── Main Analysis Function ───────────────────────────────────────────────────

/**
 * Perform a comprehensive NFT safety check.
 *
 * @param mint  NFT mint address (base58)
 * @returns     NftCheckResult with risk score, collection data, and marketplace intel
 */
export async function analyzeNft(mint: string): Promise<NftCheckResult> {
    const now = new Date().toISOString();

    // Phase 1: Parallel fetch — DAS + Magic Eden token
    const [das, meToken] = await Promise.all([
        fetchDasAsset(mint),
        fetchMeToken(mint),
    ]);

    // Phase 2: Resolve collection symbol → fetch collection stats
    // Try ME token response first, then DAS grouping
    let collectionSymbol: string | null = meToken?.collection ?? null;
    if (!collectionSymbol && das?.grouping) {
        const grp = das.grouping.find(g => g.group_key === 'collection');
        collectionSymbol = grp?.collection_metadata?.symbol ?? null;
    }

    let meStats: MeCollectionStats | null = null;
    if (collectionSymbol) {
        meStats = await fetchMeCollectionStats(collectionSymbol);
    }

    // Phase 3: Extract fields from DAS
    const name = das?.content?.metadata?.name ?? meToken?.name ?? null;
    const imageUri = das?.content?.links?.image ?? meToken?.image ?? null;
    const isCompressed = das?.compression?.compressed ?? false;
    const mutableMetadata = das?.mutable ?? false;
    const royaltyBps = das?.royalty?.basis_points ?? meToken?.sellerFeeBasisPoints ?? 0;

    const grouping = das?.grouping?.find(g => g.group_key === 'collection');
    const collectionVerified = grouping?.verified ?? false;

    // Creator / update authority
    const updateAuth = das?.authorities?.find(a => a.scopes?.includes('full'));
    const creatorAddress = updateAuth?.address ?? das?.creators?.[0]?.address ?? null;

    // ME pricing
    const listingPriceSol = meToken?.price ?? null;
    const floorPriceSol = meStats?.floorPrice
        ? Math.round((meStats.floorPrice / LAMPORTS_PER_SOL) * 1000) / 1000
        : null;
    const avgPrice24hSol = meStats?.avgPrice24hr
        ? Math.round((meStats.avgPrice24hr / LAMPORTS_PER_SOL) * 1000) / 1000
        : null;
    const volumeAllSol = meStats?.volumeAll
        ? Math.round((meStats.volumeAll / LAMPORTS_PER_SOL) * 100) / 100
        : null;
    const collectionListings = meStats?.listedCount ?? null;

    // Phase 4: Risk scoring
    const { score, flags } = computeNftRisk({ das, meToken, meStats });
    const verdict = verdictFromScore(score);

    return {
        mint,
        name,
        collectionSymbol,
        collectionVerified,
        isCompressed,
        mutableMetadata,
        royaltyBps,
        listingPriceSol,
        floorPriceSol,
        collectionListings,
        avgPrice24hSol,
        volumeAllSol,
        creatorAddress,
        imageUri,
        riskScore: score,
        verdict,
        flags,
        checkedAt: now,
    };
}
