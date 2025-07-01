const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../core/logger');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const mime = require('mime-types');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.topicMappings = new Map(); // Telegram Topic ID -> WhatsApp JID
        this.userMappings = new Map(); // WhatsApp User -> Contact Data
        this.messageIdPairs = new Map(); // WA Message ID -> TG Message ID
        this.profilePicCache = new Map(); // User -> Profile Pic URL
        this.tempDir = path.join(__dirname, '../temp');
        this.messageQueue = []; // Queue to prevent message skipping
        this.isProcessingQueue = false;
        this.activeCallNotifications = new Map();
        this.statusMessageIds = new Map();
        this.presenceTimeout = null;
        this.typingTimeouts = new Map(); // Track typing timeouts per chat
        this.lastContactSync = 0;
        this.contactSyncInterval = 3600000; // 1 hour
        this.unreadMessages = new Map(); // Track unread messages for read receipts
    }

    async initialize() {
        const token = config.get('telegram.botToken');
        const chatId = config.get('telegram.chatId');
        
        if (!token || token.includes('YOUR_BOT_TOKEN') || !chatId || chatId.includes('YOUR_CHAT_ID')) {
            logger.warn('⚠️ Telegram bot token or chat ID not configured properly');
            return;
        }

        try {
            await fs.ensureDir(this.tempDir);
            
            this.telegramBot = new TelegramBot(token, { 
                polling: true,
                onlyFirstMatch: true
            });
            
            await this.setupTelegramHandlers();
            this.startMessageQueueProcessor();
            this.startContactSyncScheduler();
            logger.info('✅ Telegram bridge initialized');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
        }
    }

    // Message queue processor to prevent skipping messages
    startMessageQueueProcessor() {
        setInterval(async () => {
            if (this.isProcessingQueue || this.messageQueue.length === 0) return;
            
            this.isProcessingQueue = true;
            const task = this.messageQueue.shift();
            
            try {
                await task();
            } catch (error) {
                logger.error('❌ Error processing queued message:', error);
            }
            
            this.isProcessingQueue = false;
        }, 100);
    }

    // Auto contact sync scheduler
    startContactSyncScheduler() {
        setInterval(async () => {
            const now = Date.now();
            if (now - this.lastContactSync > this.contactSyncInterval) {
                await this.syncContacts();
                await this.updateTopicNames();
            }
        }, 300000); // Check every 5 minutes
    }

    // Sync contacts from WhatsApp
    async syncContacts() {
        try {
            if (!this.whatsappBot.sock) return;

            logger.info('🔄 Syncing contacts from WhatsApp...');
            
            // Get all contacts from WhatsApp
            const contacts = await this.whatsappBot.sock.getContacts();
            let syncedCount = 0;

            for (const contact of contacts) {
                if (contact.id && contact.id.includes('@')) {
                    const jid = contact.id;
                    const name = contact.name || contact.notify || contact.verifiedName;
                    const phone = jid.split('@')[0];

                    // Update user mapping with contact info
                    this.userMappings.set(jid, {
                        name: name,
                        phone: phone,
                        pushName: contact.notify,
                        businessName: contact.verifiedName,
                        lastUpdated: Date.now()
                    });
                    syncedCount++;
                }
            }

            this.lastContactSync = Date.now();
            logger.info(`✅ Synced ${syncedCount} contacts from WhatsApp`);
            
            // Update topic names after sync
            await this.updateTopicNames();
            
        } catch (error) {
            logger.error('❌ Failed to sync contacts:', error);
        }
    }

    // Update topic names based on contact info
    async updateTopicNames() {
        try {
            const chatId = config.get('telegram.chatId');
            if (!chatId) return;

            for (const [whatsappJid, topicId] of this.chatMappings.entries()) {
                if (whatsappJid === 'status@broadcast' || whatsappJid === 'call@broadcast') continue;

                const isGroup = whatsappJid.endsWith('@g.us');
                let newName;

                if (isGroup) {
                    try {
                        const groupMeta = await this.whatsappBot.sock.groupMetadata(whatsappJid);
                        newName = groupMeta.subject;
                    } catch (error) {
                        continue; // Skip if can't get group info
                    }
                } else {
                    // For individual chats, use contact name or phone number
                    const userInfo = this.userMappings.get(whatsappJid);
                    const phone = whatsappJid.split('@')[0];
                    
                    if (userInfo && userInfo.name) {
                        newName = userInfo.name;
                    } else {
                        newName = `+${phone}`;
                    }
                }

                if (newName) {
                    try {
                        await this.telegramBot.editForumTopic(chatId, topicId, {
                            name: newName
                        });
                        logger.debug(`📝 Updated topic name: ${newName}`);
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limit
                    } catch (error) {
                        logger.debug('Failed to update topic name:', error);
                    }
                }
            }
        } catch (error) {
            logger.error('❌ Failed to update topic names:', error);
        }
    }

    async setupTelegramHandlers() {
        // Handle all types of messages
        this.telegramBot.on('message', this.wrapHandler(async (msg) => {
            if (msg.chat.type === 'supergroup' && msg.is_topic_message) {
                // Add to queue to prevent message skipping
                this.messageQueue.push(() => this.handleTelegramMessage(msg));
            }
        }));

        // Handle typing detection
        this.telegramBot.on('chat_action', this.wrapHandler(async (action) => {
            if (action.chat.type === 'supergroup' && action.message_thread_id) {
                const whatsappJid = this.topicMappings.get(action.message_thread_id);
                if (whatsappJid && action.action === 'typing') {
                    await this.sendPresence(whatsappJid, 'composing');
                }
            }
        }));

        this.telegramBot.on('polling_error', (error) => {
            logger.error('Telegram polling error:', error);
        });

        this.telegramBot.on('error', (error) => {
            logger.error('Telegram bot error:', error);
        });

        logger.info('📱 Telegram message handlers set up');
    }

    wrapHandler(handler) {
        return async (...args) => {
            try {
                await handler(...args);
            } catch (error) {
                logger.error('❌ Unhandled error in Telegram handler:', error);
            }
        };
    }

    async setReaction(chatId, messageId, emoji) {
        try {
            const token = config.get('telegram.botToken');
            await axios.post(`https://api.telegram.org/bot${token}/setMessageReaction`, {
                chat_id: chatId,
                message_id: messageId,
                reaction: [{ type: 'emoji', emoji }]
            });
        } catch (err) {
            logger.debug('❌ Failed to set reaction:', err?.response?.data?.description || err.message);
        }
    }

    async syncMessage(whatsappMsg, text) {
        if (!this.telegramBot || !config.get('telegram.enabled')) return;

        // Add to queue to prevent message skipping
        this.messageQueue.push(async () => {
            await this.processWhatsAppMessage(whatsappMsg, text);
        });
    }

    async processWhatsAppMessage(whatsappMsg, text) {
        try {
            const sender = whatsappMsg.key.remoteJid;
            const participant = whatsappMsg.key.participant || sender;
            const messageId = whatsappMsg.key.id;
            
            // Skip messages from me to prevent topic creation
            if (whatsappMsg.key.fromMe && sender !== 'status@broadcast') {
                // Only process if it's a status update from me
                return;
            }

            // Create/update user mapping
            await this.createOrUpdateUserMapping(participant, whatsappMsg);
            
            // Get or create topic for this chat
            const topicId = await this.getOrCreateTopic(sender, whatsappMsg);
            if (!topicId) return;

            // Track unread message for read receipts
            if (!whatsappMsg.key.fromMe) {
                if (!this.unreadMessages.has(sender)) {
                    this.unreadMessages.set(sender, []);
                }
                this.unreadMessages.get(sender).push({
                    id: messageId,
                    participant: participant,
                    timestamp: Date.now()
                });
            }

            // Handle different message types
            let sentMessageId = null;

            if (whatsappMsg.message?.imageMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'image', topicId);
            } else if (whatsappMsg.message?.videoMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'video', topicId);
            } else if (whatsappMsg.message?.audioMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'audio', topicId);
            } else if (whatsappMsg.message?.documentMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'document', topicId);
            } else if (whatsappMsg.message?.stickerMessage) {
                sentMessageId = await this.handleWhatsAppMedia(whatsappMsg, 'sticker', topicId);
            } else if (whatsappMsg.message?.locationMessage) {
                sentMessageId = await this.handleWhatsAppLocation(whatsappMsg, topicId);
            } else if (whatsappMsg.message?.contactMessage) {
                sentMessageId = await this.handleWhatsAppContact(whatsappMsg, topicId);
            } else if (whatsappMsg.message?.ptvMessage) {
                sentMessageId = await this.handleWhatsAppVideoNote(whatsappMsg, topicId);
            } else if (text) {
                sentMessageId = await this.sendSimpleMessage(topicId, text, sender, participant);
            }

            // Store message ID pair for replies and read receipts
            if (sentMessageId && messageId) {
                this.messageIdPairs.set(messageId, {
                    telegramMessageId: sentMessageId,
                    whatsappJid: sender,
                    participant: participant,
                    timestamp: Date.now()
                });
            }

        } catch (error) {
            logger.error('❌ Failed to process WhatsApp message:', error);
        }
    }

    async createOrUpdateUserMapping(participant, whatsappMsg) {
        const phone = participant.split('@')[0];
        let userName = null;
        
        // Get name from various sources
        if (whatsappMsg.pushName) {
            userName = whatsappMsg.pushName;
        } else if (whatsappMsg.verifiedBizName) {
            userName = whatsappMsg.verifiedBizName;
        }

        // Update or create user mapping
        const existingMapping = this.userMappings.get(participant);
        this.userMappings.set(participant, {
            name: userName || existingMapping?.name,
            phone: phone,
            pushName: whatsappMsg.pushName || existingMapping?.pushName,
            businessName: whatsappMsg.verifiedBizName || existingMapping?.businessName,
            lastUpdated: Date.now(),
            messageCount: (existingMapping?.messageCount || 0) + 1
        });

        logger.debug(`👤 Updated user mapping: ${userName || phone}`);
    }

    async getOrCreateTopic(chatJid, whatsappMsg) {
        if (this.chatMappings.has(chatJid)) {
            return this.chatMappings.get(chatJid);
        }

        const chatId = config.get('telegram.chatId');
        if (!chatId) {
            logger.error('❌ Telegram chat ID not configured');
            return null;
        }

        try {
            const isGroup = chatJid.endsWith('@g.us');
            const isStatus = chatJid === 'status@broadcast';
            const isCall = chatJid === 'call@broadcast';
            
            let topicName;
            let iconColor = 0x7ABA3C; // Default green
            
            if (isStatus) {
                topicName = `📊 Status Updates`;
                iconColor = 0xFF6B35; // Orange
            } else if (isCall) {
                topicName = `📞 Call Logs`;
                iconColor = 0xFF4757; // Red
            } else if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(chatJid);
                    topicName = groupMeta.subject;
                } catch (error) {
                    topicName = `Group Chat`;
                }
                iconColor = 0x6FB9F0; // Blue
            } else {
                // For individual chats - use contact name or phone number
                const userInfo = this.userMappings.get(chatJid);
                const phone = chatJid.split('@')[0];
                
                if (userInfo && userInfo.name) {
                    topicName = userInfo.name;
                } else {
                    topicName = `+${phone}`;
                }
            }

            // Create forum topic
            const topic = await this.telegramBot.createForumTopic(chatId, topicName, {
                icon_color: iconColor
            });

            const topicId = topic.message_thread_id;
            this.chatMappings.set(chatJid, topicId);
            this.topicMappings.set(topicId, chatJid);
            
            logger.info(`🆕 Created Telegram topic: ${topicName} (ID: ${topicId})`);
            
            // Send welcome message for non-broadcast chats
            if (!isStatus && !isCall) {
                await this.sendWelcomeMessage(topicId, chatJid, isGroup);
            }
            
            return topicId;
        } catch (error) {
            logger.error('❌ Failed to create Telegram topic:', error);
            return null;
        }
    }

    async sendWelcomeMessage(topicId, jid, isGroup) {
        try {
            const chatId = config.get('telegram.chatId');
            let welcomeText = '';
            
            if (isGroup) {
                try {
                    const groupMeta = await this.whatsappBot.sock.groupMetadata(jid);
                    welcomeText = `🏷️ **Group Information**\n\n` +
                                 `📝 **Name:** ${groupMeta.subject}\n` +
                                 `👥 **Participants:** ${groupMeta.participants.length}\n` +
                                 `🆔 **Group ID:** \`${jid}\`\n` +
                                 `📅 **Created:** ${new Date(groupMeta.creation * 1000).toLocaleDateString()}\n\n` +
                                 `💬 Messages from this group will appear here`;
                } catch (error) {
                    welcomeText = `🏷️ **Group Chat**\n\n💬 Messages from this group will appear here`;
                }
            } else {
                const userInfo = this.userMappings.get(jid);
                const phone = jid.split('@')[0];
                
                welcomeText = `👤 **Contact Information**\n\n` +
                             `📝 **Name:** ${userInfo?.name || 'Not available'}\n` +
                             `📱 **Phone:** +${phone}\n` +
                             `🆔 **WhatsApp ID:** \`${jid}\`\n` +
                             `📅 **First Contact:** ${new Date().toLocaleDateString()}\n\n` +
                             `💬 Messages with this contact will appear here`;
            }

            const sentMessage = await this.telegramBot.sendMessage(chatId, welcomeText, {
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            });

            // Pin the welcome message
            await this.telegramBot.pinChatMessage(chatId, sentMessage.message_id);

            // Send profile picture if available
            await this.sendProfilePicture(topicId, jid, false);

        } catch (error) {
            logger.error('❌ Failed to send welcome message:', error);
        }
    }

    async sendProfilePicture(topicId, jid, isUpdate = false) {
        try {
            const profilePicUrl = await this.whatsappBot.sock.profilePictureUrl(jid, 'image');
            
            if (profilePicUrl && profilePicUrl !== this.profilePicCache.get(jid)) {
                const caption = isUpdate ? '📸 Profile picture updated' : '📸 Profile Picture';
                
                await this.telegramBot.sendPhoto(config.get('telegram.chatId'), profilePicUrl, {
                    message_thread_id: topicId,
                    caption: caption
                });
                
                this.profilePicCache.set(jid, profilePicUrl);
            }
        } catch (error) {
            logger.debug('Could not send profile picture:', error);
        }
    }

    // Handle WhatsApp video note (PTV message)
    async handleWhatsAppVideoNote(whatsappMsg, topicId) {
        try {
            logger.info('📥 Processing video note from WhatsApp');
            
            const ptvMessage = whatsappMsg.message.ptvMessage;
            if (!ptvMessage) return null;

            const fileName = `video_note_${Date.now()}.mp4`;
            const caption = this.extractText(whatsappMsg);

            // Download video note from WhatsApp
            const stream = await downloadContentFromMessage(ptvMessage, 'video');
            const buffer = await this.streamToBuffer(stream);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send as video note to Telegram
            const chatId = config.get('telegram.chatId');
            const sentMessage = await this.telegramBot.sendVideoNote(chatId, filePath, {
                message_thread_id: topicId
            });

            // Clean up
            await fs.unlink(filePath).catch(() => {});
            
            logger.info('✅ Successfully sent video note to Telegram');
            return sentMessage.message_id;

        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp video note:', error);
            return null;
        }
    }

    async handleWhatsAppMedia(whatsappMsg, mediaType, topicId) {
        try {
            logger.info(`📥 Processing ${mediaType} from WhatsApp`);
            
            let mediaMessage;
            let fileName = `media_${Date.now()}`;
            let caption = this.extractText(whatsappMsg);
            
            switch (mediaType) {
                case 'image':
                    mediaMessage = whatsappMsg.message.imageMessage;
                    fileName += '.jpg';
                    break;
                case 'video':
                    mediaMessage = whatsappMsg.message.videoMessage;
                    fileName += '.mp4';
                    break;
                case 'audio':
                    mediaMessage = whatsappMsg.message.audioMessage;
                    fileName += '.ogg';
                    break;
                case 'document':
                    mediaMessage = whatsappMsg.message.documentMessage;
                    fileName = mediaMessage.fileName || `document_${Date.now()}`;
                    break;
                case 'sticker':
                    mediaMessage = whatsappMsg.message.stickerMessage;
                    fileName += '.webp';
                    break;
            }

            if (!mediaMessage) return null;

            // Download media from WhatsApp
            const stream = await downloadContentFromMessage(mediaMessage, mediaType === 'sticker' ? 'sticker' : mediaType);
            const buffer = await this.streamToBuffer(stream);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send to Telegram based on media type
            const chatId = config.get('telegram.chatId');
            let sentMessage;
            
            switch (mediaType) {
                case 'image':
                    sentMessage = await this.telegramBot.sendPhoto(chatId, filePath, {
                        message_thread_id: topicId,
                        caption: caption,
                        has_spoiler: mediaMessage.viewOnce
                    });
                    break;
                    
                case 'video':
                    if (mediaMessage.gifPlayback) {
                        sentMessage = await this.telegramBot.sendAnimation(chatId, filePath, {
                            message_thread_id: topicId,
                            caption: caption
                        });
                    } else {
                        sentMessage = await this.telegramBot.sendVideo(chatId, filePath, {
                            message_thread_id: topicId,
                            caption: caption,
                            has_spoiler: mediaMessage.viewOnce
                        });
                    }
                    break;
                    
                case 'audio':
                    if (mediaMessage.ptt) {
                        sentMessage = await this.telegramBot.sendVoice(chatId, filePath, {
                            message_thread_id: topicId
                        });
                    } else {
                        sentMessage = await this.telegramBot.sendAudio(chatId, filePath, {
                            message_thread_id: topicId,
                            caption: caption,
                            title: mediaMessage.title || 'Audio'
                        });
                    }
                    break;
                    
                case 'document':
                    sentMessage = await this.telegramBot.sendDocument(chatId, filePath, {
                        message_thread_id: topicId,
                        caption: caption
                    });
                    break;
                    
                case 'sticker':
                    try {
                        sentMessage = await this.telegramBot.sendSticker(chatId, filePath, {
                            message_thread_id: topicId
                        });
                    } catch (stickerError) {
                        // Convert to PNG if sticker fails
                        const pngPath = filePath.replace('.webp', '.png');
                        await sharp(filePath).png().toFile(pngPath);
                        
                        sentMessage = await this.telegramBot.sendPhoto(chatId, pngPath, {
                            message_thread_id: topicId,
                            caption: 'Sticker'
                        });
                        await fs.unlink(pngPath).catch(() => {});
                    }
                    break;
            }

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
            logger.info(`✅ Successfully sent ${mediaType} to Telegram`);
            return sentMessage?.message_id || null;

        } catch (error) {
            logger.error(`❌ Failed to handle WhatsApp ${mediaType}:`, error);
            return null;
        }
    }

    async handleWhatsAppLocation(whatsappMsg, topicId) {
        try {
            const locationMessage = whatsappMsg.message.locationMessage;
            const sentMessage = await this.telegramBot.sendLocation(
                config.get('telegram.chatId'), 
                locationMessage.degreesLatitude, 
                locationMessage.degreesLongitude, 
                {
                    message_thread_id: topicId
                }
            );
            return sentMessage.message_id;
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp location message:', error);
            return null;
        }
    }

    async handleWhatsAppContact(whatsappMsg, topicId) {
        try {
            const contactMessage = whatsappMsg.message.contactMessage;
            const vcard = contactMessage.vcard;
            const displayName = contactMessage.displayName || 'Unknown Contact';

            const sentMessage = await this.telegramBot.sendDocument(
                config.get('telegram.chatId'), 
                Buffer.from(vcard), 
                {
                    message_thread_id: topicId,
                    caption: `📇 Contact: ${displayName}`,
                    filename: `${displayName}.vcf`
                }
            );
            return sentMessage.message_id;
        } catch (error) {
            logger.error('❌ Failed to handle WhatsApp contact message:', error);
            return null;
        }
    }

    // Enhanced presence handling with typing status
    async sendPresence(jid, presence = 'available') {
        try {
            if (!this.whatsappBot.sock) return;
            
            await this.whatsappBot.sock.sendPresenceUpdate(presence, jid);
            
            // Clear previous timeout for this chat
            if (this.typingTimeouts.has(jid)) {
                clearTimeout(this.typingTimeouts.get(jid));
            }
            
            // Set presence back to available after delay
            if (presence === 'composing') {
                const timeout = setTimeout(async () => {
                    try {
                        await this.whatsappBot.sock.sendPresenceUpdate('available', jid);
                        this.typingTimeouts.delete(jid);
                    } catch (error) {
                        logger.debug('Failed to send available presence:', error);
                    }
                }, 10000);
                
                this.typingTimeouts.set(jid, timeout);
            }
            
        } catch (error) {
            logger.debug('Failed to send presence:', error);
        }
    }

    // Enhanced read receipt handling
    async markAsRead(jid, messageKeys) {
        try {
            if (!this.whatsappBot.sock || !messageKeys.length) return;
            
            // Mark messages as read in WhatsApp
            await this.whatsappBot.sock.readMessages(messageKeys);
            
            // Clear from unread messages
            if (this.unreadMessages.has(jid)) {
                const unreadList = this.unreadMessages.get(jid);
                const readIds = messageKeys.map(key => key.id);
                const remaining = unreadList.filter(msg => !readIds.includes(msg.id));
                
                if (remaining.length === 0) {
                    this.unreadMessages.delete(jid);
                } else {
                    this.unreadMessages.set(jid, remaining);
                }
            }
            
            logger.debug(`📖 Marked ${messageKeys.length} messages as read in ${jid}`);
        } catch (error) {
            logger.debug('Failed to mark messages as read:', error);
        }
    }

    async handleTelegramMessage(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.topicMappings.get(topicId);
            
            if (!whatsappJid) {
                logger.warn('⚠️ Could not find WhatsApp chat for Telegram message');
                return;
            }

            // Send presence when user is active
            await this.sendPresence(whatsappJid, 'available');

            let sendResult = null;

            // Handle different message types
            if (msg.photo) {
                sendResult = await this.handleTelegramMedia(msg, 'photo');
            } else if (msg.video) {
                sendResult = await this.handleTelegramMedia(msg, 'video');
            } else if (msg.video_note) {
                sendResult = await this.handleTelegramVideoNote(msg);
            } else if (msg.voice) {
                sendResult = await this.handleTelegramMedia(msg, 'voice');
            } else if (msg.audio) {
                sendResult = await this.handleTelegramMedia(msg, 'audio');
            } else if (msg.document) {
                sendResult = await this.handleTelegramMedia(msg, 'document');
            } else if (msg.sticker) {
                sendResult = await this.handleTelegramSticker(msg);
            } else if (msg.location) {
                sendResult = await this.handleTelegramLocation(msg);
            } else if (msg.contact) {
                sendResult = await this.handleTelegramContact(msg);
            } else if (msg.text) {
                // Handle status reply
                if (whatsappJid === 'status@broadcast' && msg.reply_to_message) {
                    await this.handleStatusReply(msg);
                    return;
                }

                // Send typing presence
                await this.sendPresence(whatsappJid, 'composing');

                // Send text message to WhatsApp
                const messageOptions = { text: msg.text };
                sendResult = await this.whatsappBot.sendMessage(whatsappJid, messageOptions);
            }

            // Handle success/failure reactions and read receipts
            if (sendResult?.key?.id) {
                await this.setReaction(msg.chat.id, msg.message_id, '👍');
                
                // Mark unread messages as read when sending from this topic
                const unreadList = this.unreadMessages.get(whatsappJid);
                if (unreadList && unreadList.length > 0) {
                    const messageKeys = unreadList.map(msg => ({
                        remoteJid: whatsappJid,
                        id: msg.id,
                        participant: msg.participant
                    }));
                    
                    setTimeout(async () => {
                        await this.markAsRead(whatsappJid, messageKeys);
                    }, 1000);
                }
            } else {
                await this.setReaction(msg.chat.id, msg.message_id, '❌');
            }

        } catch (error) {
            logger.error('❌ Failed to handle Telegram message:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    // Handle Telegram video note
    async handleTelegramVideoNote(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.topicMappings.get(topicId);
            
            if (!whatsappJid) return null;

            await this.sendPresence(whatsappJid, 'available');

            const fileId = msg.video_note.file_id;
            const fileName = `video_note_${Date.now()}.mp4`;

            // Download from Telegram
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send as PTV (video note) to WhatsApp
            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, {
                video: fs.readFileSync(filePath),
                ptv: true, // This makes it a video note
                mimetype: 'video/mp4'
            });

            // Clean up
            await fs.unlink(filePath).catch(() => {});
            
            return sendResult;

        } catch (error) {
            logger.error('❌ Failed to handle Telegram video note:', error);
            return null;
        }
    }

    // Enhanced sticker handling
    async handleTelegramSticker(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.topicMappings.get(topicId);
            
            if (!whatsappJid) return null;

            await this.sendPresence(whatsappJid, 'available');

            const fileId = msg.sticker.file_id;
            const isAnimated = msg.sticker.is_animated;
            const isVideo = msg.sticker.is_video;
            
            let fileName = `sticker_${Date.now()}`;
            if (isAnimated) {
                fileName += '.tgs';
            } else if (isVideo) {
                fileName += '.webm';
            } else {
                fileName += '.webp';
            }

            // Download from Telegram
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            let stickerBuffer;

            if (isAnimated) {
                // Convert TGS to WebP (you'll need to implement TGS conversion)
                // For now, send as document
                const sendResult = await this.whatsappBot.sendMessage(whatsappJid, {
                    document: buffer,
                    fileName: 'animated_sticker.tgs',
                    mimetype: 'application/json'
                });
                await fs.unlink(filePath).catch(() => {});
                return sendResult;
            } else if (isVideo) {
                // Convert video sticker to WebP animation
                const webpPath = filePath.replace('.webm', '.webp');
                try {
                    // Use ffmpeg or similar to convert (simplified here)
                    stickerBuffer = buffer; // Placeholder - implement proper conversion
                } catch (conversionError) {
                    logger.debug('Failed to convert video sticker, sending as GIF');
                    const sendResult = await this.whatsappBot.sendMessage(whatsappJid, {
                        video: buffer,
                        gifPlayback: true
                    });
                    await fs.unlink(filePath).catch(() => {});
                    return sendResult;
                }
            } else {
                stickerBuffer = buffer;
            }

            // Send as sticker to WhatsApp
            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, {
                sticker: stickerBuffer
            });

            await fs.unlink(filePath).catch(() => {});
            return sendResult;

        } catch (error) {
            logger.error('❌ Failed to handle Telegram sticker:', error);
            return null;
        }
    }

    async handleTelegramMedia(msg, mediaType) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.topicMappings.get(topicId);
            
            if (!whatsappJid) return null;

            await this.sendPresence(whatsappJid, 'available');

            let fileId, fileName, caption = msg.caption || '';
            
            switch (mediaType) {
                case 'photo':
                    fileId = msg.photo[msg.photo.length - 1].file_id;
                    fileName = `photo_${Date.now()}.jpg`;
                    break;
                case 'video':
                    fileId = msg.video.file_id;
                    fileName = `video_${Date.now()}.mp4`;
                    break;
                case 'voice':
                    fileId = msg.voice.file_id;
                    fileName = `voice_${Date.now()}.ogg`;
                    break;
                case 'audio':
                    fileId = msg.audio.file_id;
                    fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`;
                    break;
                case 'document':
                    fileId = msg.document.file_id;
                    fileName = msg.document.file_name || `document_${Date.now()}`;
                    break;
            }

            // Download from Telegram
            const fileLink = await this.telegramBot.getFileLink(fileId);
            const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            
            const filePath = path.join(this.tempDir, fileName);
            await fs.writeFile(filePath, buffer);

            // Send to WhatsApp based on media type
            let messageOptions = {};
            const hasMediaSpoiler = msg.has_media_spoiler;

            switch (mediaType) {
                case 'photo':
                    messageOptions = {
                        image: fs.readFileSync(filePath),
                        caption: caption,
                        viewOnce: hasMediaSpoiler
                    };
                    break;
                    
                case 'video':
                    const isGif = msg.video.mime_type === 'video/mp4' && 
                                  (msg.video.file_name?.toLowerCase().includes('gif') || msg.animation);
                    
                    messageOptions = {
                        video: fs.readFileSync(filePath),
                        caption: caption,
                        gifPlayback: isGif,
                        viewOnce: hasMediaSpoiler
                    };
                    break;
                    
                case 'voice':
                    messageOptions = {
                        audio: fs.readFileSync(filePath),
                        ptt: true,
                        mimetype: 'audio/ogg; codecs=opus'
                    };
                    break;
                    
                case 'audio':
                    messageOptions = {
                        audio: fs.readFileSync(filePath),
                        mimetype: mime.lookup(fileName) || 'audio/mp3',
                        fileName: fileName,
                        caption: caption
                    };
                    break;
                    
                case 'document':
                    messageOptions = {
                        document: fs.readFileSync(filePath),
                        fileName: fileName,
                        mimetype: mime.lookup(fileName) || 'application/octet-stream',
                        caption: caption
                    };
                    break;
            }

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, messageOptions);

            // Clean up temp file
            await fs.unlink(filePath).catch(() => {});
            
            return sendResult;

        } catch (error) {
            logger.error(`❌ Failed to handle Telegram ${mediaType}:`, error);
            return null;
        }
    }

    async handleTelegramLocation(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.topicMappings.get(topicId);

            if (!whatsappJid) return null;

            await this.sendPresence(whatsappJid, 'available');

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, { 
                location: { 
                    degreesLatitude: msg.location.latitude, 
                    degreesLongitude: msg.location.longitude
                } 
            });

            return sendResult;
        } catch (error) {
            logger.error('❌ Failed to handle Telegram location message:', error);
            return null;
        }
    }

    async handleTelegramContact(msg) {
        try {
            const topicId = msg.message_thread_id;
            const whatsappJid = this.topicMappings.get(topicId);

            if (!whatsappJid) return null;

            await this.sendPresence(whatsappJid, 'available');

            const firstName = msg.contact.first_name || '';
            const lastName = msg.contact.last_name || '';
            const phoneNumber = msg.contact.phone_number || '';
            const displayName = `${firstName} ${lastName}`.trim() || phoneNumber;

            const vcard = `BEGIN:VCARD\nVERSION:3.0\nN:${lastName};${firstName};;;\nFN:${displayName}\nTEL;TYPE=CELL:${phoneNumber}\nEND:VCARD`;

            const sendResult = await this.whatsappBot.sendMessage(whatsappJid, { 
                contacts: { 
                    displayName: displayName, 
                    contacts: [{ vcard: vcard }]
                } 
            });

            return sendResult;
        } catch (error) {
            logger.error('❌ Failed to handle Telegram contact message:', error);
            return null;
        }
    }

    async handleStatusReply(msg) {
        try {
            const originalStatusKey = this.statusMessageIds.get(msg.reply_to_message.message_id);
            if (!originalStatusKey) {
                await this.telegramBot.sendMessage(msg.chat.id, '❌ Cannot find original status message to reply to', {
                    message_thread_id: msg.message_thread_id
                });
                return;
            }

            const statusJid = originalStatusKey.participant || originalStatusKey.remoteJid;
            await this.whatsappBot.sendMessage(statusJid, { text: msg.text });

            await this.setReaction(msg.chat.id, msg.message_id, '✅');
            
        } catch (error) {
            logger.error('❌ Failed to handle status reply:', error);
            await this.setReaction(msg.chat.id, msg.message_id, '❌');
        }
    }

    async sendSimpleMessage(topicId, text, sender, participant) {
        if (!topicId) return null;

        const chatId = config.get('telegram.chatId');
        
        try {
            let messageText = text;
            
            // Format message based on sender
            if (sender === 'status@broadcast') {
                const userInfo = this.userMappings.get(participant);
                const senderName = userInfo?.name || `+${participant.split('@')[0]}`;
                messageText = `📱 Status from ${senderName}\n\n${text}`;
            } else if (sender.endsWith('@g.us')) {
                // Group message - add sender info
                const userInfo = this.userMappings.get(participant);
                const senderName = userInfo?.name || `+${participant.split('@')[0]}`;
                messageText = `👤 ${senderName}: ${text}`;
            }

            const sentMessage = await this.telegramBot.sendMessage(chatId, messageText, {
                message_thread_id: topicId
            });

            // Store status message ID for reply handling
            if (sender === 'status@broadcast') {
                this.statusMessageIds.set(sentMessage.message_id, {
                    remoteJid: sender,
                    participant: participant
                });
            }

            return sentMessage.message_id;
        } catch (error) {
            logger.error('❌ Failed to send message to Telegram:', error);
            return null;
        }
    }

    async streamToBuffer(stream) {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }

    extractText(msg) {
        return msg.message?.conversation ||
               msg.message?.extendedTextMessage?.text ||
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption ||
               msg.message?.documentMessage?.caption ||
               msg.message?.audioMessage?.caption ||
               '';
    }

    // Handle call notifications
    async handleCallNotification(callEvent) {
        if (!this.telegramBot) return;

        const callerId = callEvent.from;
        const callKey = `${callerId}_${callEvent.id}`;

        if (this.activeCallNotifications.has(callKey)) return;
        
        this.activeCallNotifications.set(callKey, true);
        setTimeout(() => {
            this.activeCallNotifications.delete(callKey);
        }, 30000);

        try {
            const userInfo = this.userMappings.get(callerId);
            const callerName = userInfo?.name || `+${callerId.split('@')[0]}`;
            
            const topicId = await this.getOrCreateTopic('call@broadcast', {
                key: { remoteJid: 'call@broadcast', participant: callerId }
            });

            const callMessage = `📞 ${callerName} 📱 ${new Date().toLocaleTimeString()}\n\nYou received a call`;

            await this.telegramBot.sendMessage(config.get('telegram.chatId'), callMessage, {
                message_thread_id: topicId
            });

            logger.debug(`📞 Sent call notification from ${callerName}`);
        } catch (error) {
            logger.error('❌ Error handling call notification:', error);
        }
    }

    // Setup WhatsApp event handlers
    setupWhatsAppHandlers() {
        if (!this.whatsappBot.sock) return;

        // Handle call events
        this.whatsappBot.sock.ev.on('call', async (calls) => {
            for (const call of calls) {
                await this.handleCallNotification(call);
            }
        });

        // Handle contact updates
        this.whatsappBot.sock.ev.on('contacts.update', async (contacts) => {
            for (const contact of contacts) {
                if (contact.id) {
                    await this.createOrUpdateUserMapping(contact.id, {
                        pushName: contact.name || contact.notify,
                        verifiedBizName: contact.verifiedName
                    });
                }
            }
            // Update topic names after contact updates
            await this.updateTopicNames();
        });

        // Handle presence updates
        this.whatsappBot.sock.ev.on('presence.update', async (presence) => {
            // Handle presence updates if needed
        });

        logger.info('📱 WhatsApp event handlers set up for Telegram bridge');
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;

        const logChannel = config.get('telegram.logChannel');
        if (!logChannel || logChannel.includes('YOUR_LOG_CHANNEL')) {
            return;
        }

        try {
            const logMessage = `🤖 *${title}*\n\n${message}\n\n⏰ ${new Date().toLocaleString()}`;
            
            await this.telegramBot.sendMessage(logChannel, logMessage, {
                parse_mode: 'Markdown'
            });
        } catch (error) {
            logger.debug('Could not send log to Telegram:', error.message);
        }
    }

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;

        // Sync contacts on connection
        await this.syncContacts();

        await this.logToTelegram('🤖 WhatsApp Bot Connected', 
            `✅ Bot: ${config.get('bot.name')} v${config.get('bot.version')}\n` +
            `📱 WhatsApp: Connected\n` +
            `🔗 Telegram Bridge: Active\n` +
            `🚀 Ready to bridge messages!`);
    }

    async shutdown() {
        logger.info('🛑 Shutting down Telegram bridge...');
        
        // Clear all timeouts
        if (this.presenceTimeout) {
            clearTimeout(this.presenceTimeout);
        }
        
        for (const timeout of this.typingTimeouts.values()) {
            clearTimeout(timeout);
        }
        this.typingTimeouts.clear();
        
        if (this.telegramBot) {
            try {
                await this.telegramBot.stopPolling();
                logger.info('📱 Telegram bot polling stopped.');
            } catch (error) {
                logger.debug('Error stopping Telegram polling:', error);
            }
        }
        
        // Clean up temp directory
        try {
            await fs.emptyDir(this.tempDir);
            logger.info('🧹 Temp directory cleaned.');
        } catch (error) {
            logger.debug('Could not clean temp directory:', error);
        }
        
        logger.info('✅ Telegram bridge shutdown complete.');
    }
}

module.exports = TelegramBridge;