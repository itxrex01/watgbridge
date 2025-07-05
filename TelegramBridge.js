const TelegramBot = require('node-telegram-bot-api');
const TelegramCommands = require('./commands');
const config = require('../config');
const logger = require('../Core/logger');
const { connectDb } = require('../utils/db');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const ffmpeg = require('fluent-ffmpeg');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const { exec } = require('child_process');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.commands = null;
        this.chatMappings = new Map();
        this.userMappings = new Map();
        this.contactMappings = new Map();
        this.profilePicCache = new Map();
        this.tempDir = path.join(__dirname, '../temp');
        this.isProcessing = false;
        this.activeCallNotifications = new Map();
        this.statusMessageMapping = new Map();
        this.messageIdMapping = new Map(); // Telegram msg ID -> WhatsApp msg key
        this.quotedMessages = new Map(); // Store quoted message references
        this.presenceTimeout = null;
        this.botChatId = null;
        this.db = null;
        this.collection = null;
        this.messageQueue = new Map();
        this.lastPresenceUpdate = new Map();
        this.topicVerificationCache = new Map();
        this.pollingRetries = 0;
        this.maxPollingRetries = 5;
        this.ephemeralSettings = new Map(); // Store ephemeral message settings
        this.groupParticipants = new Map(); // Cache group participants for @all mentions
        this.revokeButtons = new Map(); // Store revoke button mappings
        this.authorizedUsers = new Set(); // Authorized user IDs
        this.rateLimiter = new Map(); // Rate limiting per user
        this.blockedUsers = new Set(); // Blocked users
        this.messageReactions = new Map(); // Track message reactions
    }

    // ... rest of the code ...
}

module.exports = TelegramBridge;