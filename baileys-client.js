'use strict';
/**
 * baileys-client.js — VexOS WhatsApp Service
 *
 * Baileys-based WhatsApp client with:
 *  - Pairing code authentication (one-time)
 *  - Persistent sessions via MongoDB
 *  - Auto-reconnect with exponential backoff
 *  - Message handling and command routing
 *  - Group message broadcasting
 */

const makeWASocket           = require('@whiskeysockets/baileys').default;
const { DisconnectReason, makeCacheableSignalKeyStore, Browsers } =
    require('@whiskeysockets/baileys');
const pino     = require('pino');
const qrcode   = require('qrcode-terminal');
const QRCode   = require('qrcode');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_BACKOFF_MS        = 5_000;
const MAX_BACKOFF_MS         = 300_000; // 5 min

const OWNER_PHONE = (process.env.WA_OWNER_PHONE || '').replace(/\D/g, '');
const USE_QR      = process.env.WA_USE_QR === 'true';

// Group IDs — set these as env vars on the WA service Railway deployment
const GROUP_IDS = {
    assist:  process.env.WA_GROUP_ASSIST  || '',
    general: process.env.WA_GROUP_GENERAL || '',
    errors:  process.env.WA_GROUP_ERRORS  || '',
    slot:    process.env.WA_GROUP_SLOT    || '',
    info:    process.env.WA_GROUP_INFO    || '',
    captcha: process.env.WA_GROUP_CAPTCHA || '',
};

// ─────────────────────────────────────────────────────────────────────────────
// BaileysClient
// ─────────────────────────────────────────────────────────────────────────────
class BaileysClient {
    constructor(sessionManager, bridgeClient) {
        this.sessionManager    = sessionManager;
        this.bridgeClient      = bridgeClient;
        this.sock              = null;
        this.ready             = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer    = null;
        this.lastPairCode      = null;
        this.lastPairCodeTime  = 0;
        this.lastQR            = null;
        this.messageHandlers   = [];
        this.logger            = pino({ level: process.env.LOG_LEVEL || 'silent' });
    }

    // ── Public: start connection ──────────────────────────────────────────────
    async start() {
        console.log('[BAILEYS] Starting WhatsApp client…');

        const { state, saveCreds } = await this.sessionManager.loadSession();

        try {
            this.sock = makeWASocket({
                auth: {
                    creds: state.creds,
                    keys:  makeCacheableSignalKeyStore(state.keys, this.logger),
                },
                logger:                      this.logger,
                printQRInTerminal:           false,
                browser:                     Browsers.ubuntu('VexOS'),
                syncFullHistory:             false,
                markOnlineOnConnect:         true,
                generateHighQualityLinkPreview: false,
                getMessage:                  async () => undefined,
            });

            this._registerHandlers(saveCreds);
            console.log('[BAILEYS] ✅ Socket created');
        } catch (err) {
            console.error('[BAILEYS] Start error:', err.message);
            this._scheduleReconnect();
        }
    }

    // ── Event handlers ────────────────────────────────────────────────────────
    _registerHandlers(saveCreds) {
        this.sock.ev.on('connection.update', update => this._handleConnectionUpdate(update));
        this.sock.ev.on('creds.update',      saveCreds);
        this.sock.ev.on('messages.upsert',   ({ messages }) => this._handleMessages(messages));
    }

    async _handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            await this._handleAuth(qr);
        }

        if (connection === 'close') {
            const code           = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;
            console.log(`[BAILEYS] ❌ Connection closed. Code: ${code}. Reconnect: ${shouldReconnect}`);
            this.ready = false;

            if (shouldReconnect) {
                this._scheduleReconnect();
            } else {
                console.log('[BAILEYS] Logged out — clearing session');
                await this.sessionManager.clearSession();
                await this.bridgeClient.notifyStatus('logged_out').catch(() => {});
            }
        } else if (connection === 'open') {
            console.log('[BAILEYS] ✅ Connected to WhatsApp!');
            this.ready             = true;
            this.reconnectAttempts = 0;
            this.lastPairCode      = null;
            await this.bridgeClient.notifyStatus('connected').catch(() => {});
            await this._sendReadyMessage();
        } else if (connection === 'connecting') {
            console.log('[BAILEYS] 🔄 Connecting…');
        }
    }

    async _handleAuth(qr) {
        if (USE_QR) {
            console.log('[BAILEYS] QR Code:');
            qrcode.generate(qr, { small: true });
            try {
                this.lastQR = await QRCode.toDataURL(qr);
                console.log('[BAILEYS] QR image ready at /qr endpoint');
            } catch (err) {
                console.error('[BAILEYS] QR image generation error:', err.message);
            }
            return;
        }

        // Pairing code mode
        if (!OWNER_PHONE) {
            console.warn('[BAILEYS] WA_OWNER_PHONE not set — set it or use WA_USE_QR=true');
            return;
        }

        const now = Date.now();
        if (this.lastPairCode && now - this.lastPairCodeTime < 60_000) {
            console.log('[BAILEYS] Pairing code cooldown active');
            return;
        }

        try {
            const code = await this.sock.requestPairingCode(OWNER_PHONE);
            this.lastPairCode     = code;
            this.lastPairCodeTime = now;

            console.log('[BAILEYS] ═══════════════════════════════════');
            console.log('[BAILEYS] 🔐 PAIRING CODE:', code);
            console.log('[BAILEYS] ═══════════════════════════════════');
            console.log('[BAILEYS] WhatsApp → Linked Devices → Link a Device → Link with phone number');

            await this.bridgeClient.notifyPairingCode(code).catch(() => {});
        } catch (err) {
            console.error('[BAILEYS] Pairing code error:', err.message);
        }
    }

    // ── Reconnect backoff ─────────────────────────────────────────────────────
    _scheduleReconnect() {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

        this.reconnectAttempts++;

        if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            console.error('[BAILEYS] ❌ Max reconnect attempts reached');
            this.bridgeClient.notifyStatus('max_reconnects').catch(() => {});
            return;
        }

        const backoffMs = Math.min(
            BASE_BACKOFF_MS * Math.pow(2, this.reconnectAttempts - 1),
            MAX_BACKOFF_MS,
        );
        console.log(
            `[BAILEYS] Reconnecting in ${Math.round(backoffMs / 1000)}s ` +
            `(attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`
        );

        this.reconnectTimer = setTimeout(() => this.start(), backoffMs);
    }

    async _sendReadyMessage() {
        const msg = '✅ *VexOS WhatsApp Service Online*\n\nBaileys microservice ready.';
        for (const [name, gid] of Object.entries(GROUP_IDS)) {
            if (!gid) continue;
            try {
                await this.sendMessage(gid, msg);
            } catch (err) {
                console.warn(`[BAILEYS] Failed to send ready message to group ${name}:`, err.message);
            }
        }
    }

    // ── Incoming messages ─────────────────────────────────────────────────────
    async _handleMessages(messages) {
        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const text = msg.message?.conversation ||
                         msg.message?.extendedTextMessage?.text || '';
            if (!text) continue;

            const from    = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');

            console.log(`[BAILEYS] Message from ${from}: ${text.slice(0, 60)}`);

            if (text.startsWith('.') || text.startsWith('/')) {
                await this._handleCommand(from, text, msg, isGroup);
            }

            for (const handler of this.messageHandlers) {
                try { await handler(msg, text, from, isGroup); }
                catch (err) { console.error('[BAILEYS] Handler error:', err.message); }
            }
        }
    }

    async _handleCommand(from, text, msg, isGroup) {
        const cmd = text.split(' ')[0].toLowerCase();

        switch (cmd) {
            case '.ping':
            case '/ping':
                await this.sendMessage(from, '🏓 Pong! WhatsApp service is alive.');
                break;

            case '.status':
            case '/status': {
                const status = await this._getStatus();
                await this.sendMessage(from, status);
                break;
            }

            case '.setup':
                if (isGroup) {
                    await this.sendMessage(from,
                        `📋 *Group Setup*\n\nGroup ID:\n\`${from}\`\n\nSave this as the matching WA_GROUP_* env var on the WhatsApp service.`
                    );
                }
                break;

            default:
                // Forward unknown commands to main server for processing
                await this.bridgeClient.forwardCommand(from, text, isGroup).catch(() => {});
                break;
        }
    }

    async _getStatus() {
        const sessionInfo = await this.sessionManager.getSessionInfo();
        const uptime      = process.uptime();
        return [
            `📊 *WhatsApp Service Status*`,
            `Connection: ${this.ready ? '✅ Connected' : '❌ Disconnected'}`,
            `Uptime: ${Math.floor(uptime / 60)}m ${Math.floor(uptime % 60)}s`,
            `Session: ${sessionInfo ? '✅ Persistent (MongoDB)' : '⚠️ Memory-only'}`,
            `Last Updated: ${sessionInfo?.updatedAt ? new Date(sessionInfo.updatedAt).toLocaleString() : 'N/A'}`,
            `Reconnect Attempts: ${this.reconnectAttempts}`,
        ].join('\n');
    }

    // ── Send helpers ──────────────────────────────────────────────────────────
    async sendMessage(jid, text) {
        if (!this.sock || !this.ready) throw new Error('WhatsApp not connected');
        try {
            await this.sock.sendMessage(jid, { text });
            return true;
        } catch (err) {
            console.error('[BAILEYS] Send error:', err.message);
            throw err;
        }
    }

    async sendToGroup(groupName, text) {
        const gid = GROUP_IDS[groupName] || groupName;
        if (!gid) throw new Error(`Group "${groupName}" not configured`);
        return this.sendMessage(gid, text);
    }

    async broadcast(text, groups = ['general', 'assist']) {
        const results = [];
        for (const group of groups) {
            try {
                await this.sendToGroup(group, text);
                results.push({ group, success: true });
            } catch (err) {
                results.push({ group, success: false, error: err.message });
            }
        }
        return results;
    }

    onMessage(handler) {
        this.messageHandlers.push(handler);
    }

    async stop() {
        console.log('[BAILEYS] Stopping…');
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.sock) {
            try { await this.sock.logout(); } catch (_) {}
            this.sock = null;
        }
        this.ready = false;
        console.log('[BAILEYS] ✅ Stopped');
    }
}

module.exports = { BaileysClient, GROUP_IDS };
