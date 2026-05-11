'use strict';
/**
 * bridge-client.js — VexOS WhatsApp Service
 *
 * HTTP client that communicates with the main Railway server.
 * Uses Railway's private networking (fast, free, secure internal traffic).
 *
 * Main server must expose these endpoints (added by whatsapp-api.js):
 *  POST /api/whatsapp/pairing-code
 *  POST /api/whatsapp/status
 *  POST /api/whatsapp/command
 */

const axios = require('axios');

class BridgeClient {
    constructor() {
        // Railway private network URL: http://<service-name>.railway.internal:<PORT>
        // Set MAIN_SERVER_URL in this service's env vars on Railway
        this.baseURL = process.env.MAIN_SERVER_URL || 'http://localhost:3000';
        this.timeout = 10_000;
        console.log(`[BRIDGE] Main server URL: ${this.baseURL}`);
    }

    async notifyPairingCode(code) {
        try {
            await axios.post(
                `${this.baseURL}/api/whatsapp/pairing-code`,
                { code },
                { timeout: this.timeout },
            );
            console.log('[BRIDGE] ✅ Pairing code sent to main server');
        } catch (err) {
            console.error('[BRIDGE] Pairing code notify failed:', err.message);
            throw err;
        }
    }

    async notifyStatus(status) {
        try {
            await axios.post(
                `${this.baseURL}/api/whatsapp/status`,
                { status, timestamp: Date.now() },
                { timeout: this.timeout },
            );
            console.log(`[BRIDGE] ✅ Status sent: ${status}`);
        } catch (err) {
            console.error('[BRIDGE] Status notify failed:', err.message);
            // Non-fatal: main server may be temporarily unreachable
        }
    }

    async forwardCommand(from, text, isGroup) {
        try {
            const response = await axios.post(
                `${this.baseURL}/api/whatsapp/command`,
                { from, text, isGroup, timestamp: Date.now() },
                { timeout: this.timeout },
            );
            console.log('[BRIDGE] ✅ Command forwarded');
            return response.data;
        } catch (err) {
            console.error('[BRIDGE] Command forward failed:', err.message);
            throw err;
        }
    }

    async healthCheck() {
        try {
            const response = await axios.get(`${this.baseURL}/health`, { timeout: 5_000 });
            return response.status === 200;
        } catch (err) {
            console.error('[BRIDGE] Main server health check failed:', err.message);
            return false;
        }
    }
}

module.exports = { BridgeClient };
