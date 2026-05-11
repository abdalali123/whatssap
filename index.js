'use strict';
/**
 * index.js — VexOS WhatsApp Microservice
 *
 * Standalone Railway service. Runs Baileys (pure Node.js, no Chromium),
 * persists sessions in MongoDB, and communicates with the main VexOS server
 * via Railway private networking.
 *
 * ── Required env vars ────────────────────────────────────────────────────────
 *   MONGO_URI          MongoDB connection string (Atlas free tier works fine)
 *   WA_OWNER_PHONE     Phone number for pairing e.g. 212612345678 (no + or spaces)
 *   MAIN_SERVER_URL    Main Railway service private URL e.g. http://vexos.railway.internal:3000
 *
 * ── Optional env vars ────────────────────────────────────────────────────────
 *   PORT               HTTP port for this service (default 3001)
 *   WA_USE_QR          Set to "true" to use QR code instead of pairing code
 *   LOG_LEVEL          Baileys internal log level (default: silent)
 *   WA_GROUP_ASSIST    WhatsApp group JID for assist group
 *   WA_GROUP_GENERAL   WhatsApp group JID for general alerts
 *   WA_GROUP_ERRORS    WhatsApp group JID for error reports
 *   WA_GROUP_SLOT      WhatsApp group JID for slot alerts
 *   WA_GROUP_INFO      WhatsApp group JID for info messages
 *   WA_GROUP_CAPTCHA   WhatsApp group JID for captcha alerts
 */

require('dotenv').config();

const express          = require('express');
const { SessionManager } = require('./session-manager');
const { BaileysClient }  = require('./baileys-client');
const { BridgeClient }   = require('./bridge-client');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.PORT || '3001', 10);
const SERVICE_START    = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Components
// ─────────────────────────────────────────────────────────────────────────────
const sessionManager = new SessionManager('vexos-wa');
const bridgeClient   = new BridgeClient();
let   waClient       = null;

// ─────────────────────────────────────────────────────────────────────────────
// Express API
// ─────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Railway health check
app.get('/health', (req, res) => {
    const healthy = waClient?.ready === true;
    res.status(healthy ? 200 : 503).json({
        status:    healthy ? 'healthy' : 'unhealthy',
        whatsapp:  waClient?.ready ? 'connected' : 'disconnected',
        uptime:    Math.floor((Date.now() - SERVICE_START) / 1000),
        timestamp: new Date().toISOString(),
    });
});

// Detailed status
app.get('/status', async (req, res) => {
    const sessionInfo = await sessionManager.getSessionInfo();
    res.json({
        service:  'vexos-whatsapp',
        version:  '1.0.0',
        whatsapp: {
            connected:         waClient?.ready || false,
            reconnectAttempts: waClient?.reconnectAttempts || 0,
        },
        session: {
            persistent:  sessionInfo !== null,
            lastUpdated: sessionInfo?.updatedAt || null,
        },
        uptime:    Math.floor((Date.now() - SERVICE_START) / 1000),
        timestamp: new Date().toISOString(),
    });
});

// Send a message — called by main server to push alerts into WhatsApp
// Body: { to: "JID", text: "..." }  OR  { groups: ["general","slot"], text: "..." }
app.post('/api/send', async (req, res) => {
    if (!waClient?.ready) {
        return res.status(503).json({ error: 'WhatsApp not connected' });
    }

    const { to, text, groups } = req.body;
    if (!text) return res.status(400).json({ error: 'Missing "text" field' });

    try {
        if (groups && Array.isArray(groups)) {
            const results = await waClient.broadcast(text, groups);
            return res.json({ success: true, results });
        }
        if (to) {
            await waClient.sendMessage(to, text);
            return res.json({ success: true });
        }
        return res.status(400).json({ error: 'Provide "to" (JID) or "groups" (array)' });
    } catch (err) {
        console.error('[API] /api/send error:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// QR code image (only relevant when WA_USE_QR=true)
app.get('/qr', (req, res) => {
    if (!waClient?.lastQR) {
        return res.status(404).json({ error: 'No QR code available — connect first or set WA_USE_QR=true' });
    }
    res.json({ qr: waClient.lastQR });
});

// Force logout + clear session (useful for re-pairing)
app.post('/api/logout', async (req, res) => {
    try {
        if (waClient) await waClient.stop();
        await sessionManager.clearSession();
        res.json({ success: true, message: 'Logged out and session cleared — restart service to re-pair' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────
async function start() {
    console.log('═════════════════════════════════════════════');
    console.log('  🚀 VexOS WhatsApp Microservice');
    console.log('═════════════════════════════════════════════');

    // 1. MongoDB
    const mongoOk = await sessionManager.connect();
    if (!mongoOk) {
        console.warn('[STARTUP] ⚠️  MongoDB unavailable — sessions will not persist');
    }

    // 2. HTTP server
    await new Promise(resolve => {
        app.listen(PORT, () => {
            console.log(`[STARTUP] ✅ HTTP listening on :${PORT}`);
            console.log(`[STARTUP] Health : http://localhost:${PORT}/health`);
            console.log(`[STARTUP] Status : http://localhost:${PORT}/status`);
            resolve();
        });
    });

    // 3. WhatsApp
    waClient = new BaileysClient(sessionManager, bridgeClient);
    await waClient.start();

    console.log('═════════════════════════════════════════════');
    console.log('  ✅ Service ready');
    console.log('═════════════════════════════════════════════');
}

// ─────────────────────────────────────────────────────────────────────────────
// Process handlers
// ─────────────────────────────────────────────────────────────────────────────
process.on('unhandledRejection', err => console.error('[ERROR] Unhandled rejection:', err));
process.on('uncaughtException',  err => { console.error('[ERROR] Uncaught exception:', err); process.exit(1); });

process.on('SIGTERM', async () => {
    console.log('[SHUTDOWN] SIGTERM');
    if (waClient) await waClient.stop();
    process.exit(0);
});
process.on('SIGINT', async () => {
    console.log('[SHUTDOWN] SIGINT');
    if (waClient) await waClient.stop();
    process.exit(0);
});

start().catch(err => {
    console.error('[FATAL] Startup error:', err);
    process.exit(1);
});
