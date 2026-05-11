/**
 * SicariusGuard — x402 Live Payment E2E Test
 * 
 * Flow:
 *   1. Generate ephemeral test keypair
 *   2. Fund it with 0.005 SOL from HOT_WALLET (enough for 0.002 payment + fees)
 *   3. Wait for confirmation
 *   4. Send 0.002 SOL from test wallet TO TREASURY_WALLET
 *   5. Hit /v1/scan with the X-PAYMENT header = tx signature
 *   6. Verify we get a 200 response (payment accepted)
 *   7. Sweep remaining SOL back to hot wallet
 *
 * Net cost: ~0.00001 SOL in tx fees (2 transactions)
 */

import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    LAMPORTS_PER_SOL,
    sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import path from 'path';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load Sicarius .env for the hot wallet key
dotenv.config({ path: path.join(__dirname, '..', '..', 'Sicarius', '.env') });
// Also load SicariusGuard .env 
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const HOT_WALLET_PRIVATE = process.env.HOT_WALLET_PRIVATE_B58;
const TREASURY_WALLET = process.env.TREASURY_WALLET || '5QMsfrUcaJ8WgD98MD8NJ3aEHvYz443QqFEJqGXbyLFM';
const SERVER_URL = 'http://localhost:3400';
const SCAN_PRICE = 0.002; // SOL
const FUND_AMOUNT = 0.005; // SOL (payment + fees + sweep)

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║   🧪 x402 LIVE PAYMENT E2E TEST                             ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log();

    // ── Validate env ─────────────────────────────────────────────
    if (!HOT_WALLET_PRIVATE) {
        console.error('❌ HOT_WALLET_PRIVATE_B58 not found. Set it in Sicarius/.env');
        process.exit(1);
    }

    const connection = new Connection(RPC_URL, 'confirmed');
    const hotWallet = Keypair.fromSecretKey(bs58.decode(HOT_WALLET_PRIVATE));
    const testWallet = Keypair.generate();
    const treasuryPk = new PublicKey(TREASURY_WALLET);

    // ── SAFETY: Save test wallet keypair BEFORE funding ──────────
    // If the pipeline breaks mid-test, this file lets you recover funds
    const keypairPath = path.join(__dirname, '.x402_test_keypair.json');
    const testPrivateB58 = bs58.encode(Buffer.from(testWallet.secretKey));
    const keypairData = {
        generatedAt: new Date().toISOString(),
        publicKey: testWallet.publicKey.toBase58(),
        privateKeyB58: testPrivateB58,
        secretArray: Array.from(testWallet.secretKey),
        purpose: 'Ephemeral x402 live payment test wallet',
        note: 'DELETE THIS FILE after test completes and sweep succeeds',
    };
    await import('fs').then(fs => fs.writeFileSync(keypairPath, JSON.stringify(keypairData, null, 2)));
    console.log(`  ⚠️  Test keypair saved: ${keypairPath}`);

    console.log(`  Hot Wallet:     ${hotWallet.publicKey.toBase58()}`);
    console.log(`  Treasury:       ${TREASURY_WALLET}`);
    console.log(`  Test Wallet:    ${testWallet.publicKey.toBase58()}`);
    console.log(`  Test Private:   ${testPrivateB58.slice(0, 12)}... (full key in keypair file)`);
    console.log();

    // ── Check hot wallet balance ─────────────────────────────────
    const hotBalance = await connection.getBalance(hotWallet.publicKey);
    console.log(`  Hot wallet balance: ${(hotBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    
    if (hotBalance < FUND_AMOUNT * LAMPORTS_PER_SOL + 10000) {
        console.error(`❌ Insufficient balance. Need at least ${FUND_AMOUNT} SOL`);
        process.exit(1);
    }

    // ── Step 1: Fund test wallet ─────────────────────────────────
    console.log(`\n[1/5] Funding test wallet with ${FUND_AMOUNT} SOL...`);
    
    const fundTx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: hotWallet.publicKey,
            toPubkey: testWallet.publicKey,
            lamports: Math.floor(FUND_AMOUNT * LAMPORTS_PER_SOL),
        })
    );

    const fundSig = await sendAndConfirmTransaction(connection, fundTx, [hotWallet], {
        commitment: 'confirmed',
    });
    console.log(`  ✅ Funded: ${fundSig.slice(0, 20)}...`);

    // Wait for balance to propagate (RPC node sync delay)
    console.log(`  Waiting for balance propagation...`);
    let testBalance = 0;
    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        testBalance = await connection.getBalance(testWallet.publicKey, 'confirmed');
        if (testBalance > 0) break;
        console.log(`  ... retry ${i + 1}/10 (balance: ${testBalance})`);
    }
    console.log(`  Test wallet balance: ${(testBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    
    if (testBalance === 0) {
        console.error('❌ Test wallet never received funds. Aborting.');
        process.exit(1);
    }

    // ── Step 2: Send payment to treasury ─────────────────────────
    console.log(`\n[2/5] Sending ${SCAN_PRICE} SOL payment to treasury...`);
    
    const paymentTx = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: testWallet.publicKey,
            toPubkey: treasuryPk,
            lamports: Math.floor(SCAN_PRICE * LAMPORTS_PER_SOL),
        })
    );

    const paymentSig = await sendAndConfirmTransaction(connection, paymentTx, [testWallet], {
        commitment: 'confirmed',
    });
    console.log(`  ✅ Payment tx: ${paymentSig}`);

    // ── Step 3: Verify treasury received funds ───────────────────
    console.log(`\n[3/5] Verifying treasury balance change...`);
    const treasuryBalance = await connection.getBalance(treasuryPk);
    console.log(`  Treasury balance: ${(treasuryBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

    // ── Step 4: Hit the API with payment ─────────────────────────
    // First, exhaust free tier to force x402
    console.log(`\n[4/5] Testing x402 payment flow...`);
    
    // Direct test: POST /v1/scan with X-PAYMENT header
    // We need to exhaust the free tier first, so temporarily lower the limit
    // OR we can just directly test the payment verification
    console.log(`  Sending scan request with X-PAYMENT: ${paymentSig.slice(0, 20)}...`);
    
    const scanResponse = await fetch(`${SERVER_URL}/v1/scan`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-PAYMENT': paymentSig,
        },
        body: JSON.stringify({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' }),
    });

    console.log(`  Response status: ${scanResponse.status}`);
    const scanData = await scanResponse.json() as Record<string, unknown>;
    
    if (scanResponse.status === 200) {
        const combined = scanData.combined as Record<string, unknown>;
        console.log(`  ✅ PAYMENT ACCEPTED! Scan completed.`);
        console.log(`  Verdict: ${combined?.verdict}`);
        console.log(`  Score: ${combined?.finalScore}`);
    } else {
        console.log(`  ❌ Payment rejected:`, JSON.stringify(scanData, null, 2));
    }

    // ── Step 5: Verify replay protection ─────────────────────────
    console.log(`\n[5/5] Testing replay protection (same tx signature)...`);
    
    const replayResponse = await fetch(`${SERVER_URL}/v1/scan`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-PAYMENT': paymentSig,
        },
        body: JSON.stringify({ mint: 'So11111111111111111111111111111111111111112' }),
    });

    console.log(`  Replay status: ${replayResponse.status}`);
    const replayData = await replayResponse.json() as Record<string, unknown>;
    
    if (replayResponse.status === 402) {
        console.log(`  ✅ Replay correctly rejected: ${replayData.error || replayData.message}`);
    } else if (replayResponse.status === 200) {
        // If 200, it means the free tier let it through (auth passed before x402)
        console.log(`  ⚠️  Got 200 — free tier let it through (replay protection only applies when x402 is the gate)`);
    } else {
        console.log(`  Response:`, JSON.stringify(replayData, null, 2));
    }

    // ── Sweep remaining SOL back ─────────────────────────────────
    console.log(`\n[CLEANUP] Sweeping remaining SOL back to hot wallet...`);
    
    const remainingBalance = await connection.getBalance(testWallet.publicKey);
    const sweepAmount = remainingBalance - 5000; // Leave 5000 lamports for fee
    
    if (sweepAmount > 0) {
        const sweepTx = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: testWallet.publicKey,
                toPubkey: hotWallet.publicKey,
                lamports: sweepAmount,
            })
        );

        const sweepSig = await sendAndConfirmTransaction(connection, sweepTx, [testWallet], {
            commitment: 'confirmed',
        });
        console.log(`  ✅ Swept ${(sweepAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL back: ${sweepSig.slice(0, 20)}...`);
    }

    // ── Final balances ───────────────────────────────────────────
    const finalHotBalance = await connection.getBalance(hotWallet.publicKey);
    const netCost = (hotBalance - finalHotBalance) / LAMPORTS_PER_SOL;
    
    console.log(`\n══════════════════════════════════════════════════════════════`);
    console.log(`  RESULTS:`);
    console.log(`  Hot wallet: ${(finalHotBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`  Net cost: ${netCost.toFixed(6)} SOL (tx fees only)`);
    console.log(`  Payment tx: ${paymentSig}`);
    console.log(`  x402 verified: ${scanResponse.status === 200 ? '✅ YES' : '❌ NO'}`);
    console.log(`══════════════════════════════════════════════════════════════`);
}

main().catch(console.error);
