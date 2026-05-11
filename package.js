{
  "name": "vexos-whatsapp-service",
  "version": "1.0.0",
  "description": "VexOS WhatsApp Microservice — Baileys-based standalone service",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "dev": "node index.js"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.8",
    "axios": "^1.7.2",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "mongoose": "^8.4.0",
    "pino": "^9.1.0",
    "qrcode-terminal": "^0.12.0",
    "qrcode": "^1.5.4"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
