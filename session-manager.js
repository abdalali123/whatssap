'use strict';
/**
 * session-manager.js — VexOS WhatsApp Service
 *
 * Handles persistent session storage in MongoDB so auth survives:
 *  - Railway restarts/redeploys
 *  - Container crashes
 *  - Network disconnects
 *
 * Session data (creds, keys) is serialised to MongoDB on every update,
 * then restored automatically on reconnect.
 */

const mongoose = require('mongoose');
const { initAuthCreds } = require('@whiskeysockets/baileys');

// ─────────────────────────────────────────────────────────────────────────────
// MongoDB Schema
// ─────────────────────────────────────────────────────────────────────────────
const AuthStateSchema = new mongoose.Schema({
    sessionId:  { type: String, required: true, unique: true, index: true },
    creds:      { type: Object, required: true },
    keys:       { type: Object, default: {} },
    updatedAt:  { type: Date, default: Date.now },
});
AuthStateSchema.index({ updatedAt: -1 });
const AuthState = mongoose.model('AuthState', AuthStateSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Session Manager
// ─────────────────────────────────────────────────────────────────────────────
class SessionManager {
    constructor(sessionId = 'vexos-wa') {
        this.sessionId = sessionId;
        this.connected = false;
    }

    async connect() {
        const uri = process.env.MONGO_URI;
        if (!uri) {
            console.error('[SESSION] MONGO_URI not set — sessions will NOT persist');
            return false;
        }
        try {
            await mongoose.connect(uri, {
                serverSelectionTimeoutMS: 10_000,
                socketTimeoutMS:          45_000,
            });
            this.connected = true;
            console.log('[SESSION] ✅ MongoDB connected');
            return true;
        } catch (err) {
            console.error('[SESSION] MongoDB connection failed:', err.message);
            this.connected = false;
            return false;
        }
    }

    /**
     * Load session from MongoDB or create fresh credentials.
     * Returns { state, saveCreds } compatible with Baileys makeWASocket.
     */
    async loadSession() {
        if (!this.connected) {
            console.warn('[SESSION] Not connected to MongoDB — using memory-only auth');
            return this._memoryOnlyAuth();
        }

        try {
            const existing = await AuthState.findOne({ sessionId: this.sessionId });

            if (existing) {
                console.log('[SESSION] ✅ Restored session from MongoDB');
                const state = { creds: existing.creds, keys: existing.keys || {} };
                return { state, saveCreds: () => this._saveCreds(state) };
            }

            console.log('[SESSION] No existing session — initialising new auth');
            const creds = initAuthCreds();
            const state = { creds, keys: {} };

            await AuthState.create({
                sessionId: this.sessionId,
                creds,
                keys: {},
                updatedAt: new Date(),
            });

            return { state, saveCreds: () => this._saveCreds(state) };
        } catch (err) {
            console.error('[SESSION] Load failed:', err.message);
            return this._memoryOnlyAuth();
        }
    }

    async _saveCreds(state) {
        if (!this.connected) return;
        try {
            await AuthState.updateOne(
                { sessionId: this.sessionId },
                { $set: { creds: state.creds, keys: state.keys, updatedAt: new Date() } },
                { upsert: true },
            );
            if (Math.random() < 0.05) {
                console.log('[SESSION] Credentials saved to MongoDB');
            }
        } catch (err) {
            console.error('[SESSION] Save failed:', err.message);
        }
    }

    _memoryOnlyAuth() {
        console.warn('[SESSION] ⚠️  Memory-only auth — session will NOT persist across restarts');
        const creds = initAuthCreds();
        const state = { creds, keys: {} };
        return { state, saveCreds: () => {} };
    }

    async clearSession() {
        if (!this.connected) return;
        try {
            await AuthState.deleteOne({ sessionId: this.sessionId });
            console.log('[SESSION] ✅ Session cleared from MongoDB');
        } catch (err) {
            console.error('[SESSION] Clear failed:', err.message);
        }
    }

    async getSessionInfo() {
        if (!this.connected) return null;
        try {
            const doc = await AuthState.findOne({ sessionId: this.sessionId });
            if (!doc) return null;
            return {
                sessionId:  doc.sessionId,
                updatedAt:  doc.updatedAt,
                hasKeys:    Object.keys(doc.keys || {}).length > 0,
            };
        } catch (err) {
            console.error('[SESSION] Info fetch failed:', err.message);
            return null;
        }
    }
}

module.exports = { SessionManager };
