const logger = require('../Core/logger');
const config = require('../config');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
    }

    async handleCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        // Check authorization
        if (!this.bridge.isAuthorized(msg.from.id)) {
            await this.bridge.telegramBot.sendMessage(msg.chat.id, 
                '❌ You are not authorized to use this bot.', 
                { parse_mode: 'Markdown' });
            return;
        }

        const [command, ...args] = text.split(' ');

        try {
            switch (command.toLowerCase()) {
                case '/start':
                    await this.handleStart(msg.chat.id);
                    break;
                case '/status':
                    await this.handleStatus(msg.chat.id);
                    break;
                case '/send':
                    await this.handleSend(msg.chat.id, args);
                    break;
                case '/sync':
                    await this.handleSync(msg.chat.id);
                    break;
                case '/contacts':
                    await this.handleContacts(msg.chat.id, args);
                    break;
                case '/searchcontact':
                    await this.handleSearchContact(msg.chat.id, args);
                    break;
                case '/groups':
                    await this.handleGroups(msg.chat.id);
                    break;
                case '/block':
                    await this.handleBlock(msg.chat.id, args);
                    break;
                case '/unblock':
                    await this.handleUnblock(msg.chat.id, args);
                    break;
                case '/mute':
                    await this.handleMute(msg.chat.id, args);
                    break;
                case '/unmute':
                    await this.handleUnmute(msg.chat.id, args);
                    break;
                case '/ephemeral':
                    await this.handleEphemeral(msg.chat.id, args);
                    break;
                case '/presence':
                    await this.handlePresence(msg.chat.id, args);
                    break;
                case '/logs':
                    await this.handleLogs(msg.chat.id, args);
                    break;
                case '/stats':
                    await this.handleStats(msg.chat.id);
                    break;
                case '/backup':
                    await this.handleBackup(msg.chat.id);
                    break;
                case '/restore':
                    await this.handleRestore(msg.chat.id, args);
                    break;
                case '/authorize':
                    await this.handleAuthorize(msg.chat.id, args);
                    break;
                case '/unauthorize':
                    await this.handleUnauthorize(msg.chat.id, args);
                    break;
                case '/broadcast':
                    await this.handleBroadcast(msg.chat.id, args);
                    break;
                case '/updatetopics':
                    await this.handleUpdateTopics(msg.chat.id);
                    break;
                case '/help':
                    await this.handleHelp(msg.chat.id);
                    break;
                default:
                    await this.handleMenu(msg.chat.id);
            }
        } catch (error) {
            logger.error(`❌ Error handling command ${command}:`, error);
            await this.bridge.telegramBot.sendMessage(
                msg.chat.id,
                `❌ Command error: ${error.message}`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleStart(chatId) {
        const isReady = !!this.bridge.telegramBot;
        const uptime = process.uptime();
        const uptimeStr = this.formatUptime(uptime);
        
        const welcome = `🤖 *WhatsApp-Telegram Bridge Bot*\n\n` +
            `Status: ${isReady ? '✅ Ready' : '⏳ Initializing...'}\n` +
            `⏱️ Uptime: ${uptimeStr}\n` +
            `💬 Linked Chats: ${this.bridge.chatMappings.size}\n` +
            `📞 Contacts: ${this.bridge.contactMappings.size}\n` +
            `👥 Users: ${this.bridge.userMappings.size}\n\n` +
            `Use /help to see all available commands.`;
        
        await this.bridge.telegramBot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const waConnected = !!this.bridge.whatsappBot?.sock;
        const waUser = this.bridge.whatsappBot?.sock?.user;
        const uptime = process.uptime();
        const uptimeStr = this.formatUptime(uptime);
        
        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${waConnected ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 User: ${waUser?.name || 'Unknown'}\n` +
            `📱 Phone: ${waUser?.id?.split('@')[0] || 'Unknown'}\n` +
            `⏱️ Uptime: ${uptimeStr}\n` +
            `💬 Chats: ${this.bridge.chatMappings.size}\n` +
            `👥 Users: ${this.bridge.userMappings.size}\n` +
            `📞 Contacts: ${this.bridge.contactMappings.size}\n` +
            `🔄 Message Queue: ${Array.from(this.bridge.messageQueue.values()).reduce((a, b) => a + b.length, 0)}\n` +
            `💾 Memory Usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`;
        
        await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /send <number> <message>\n' +
                'Example: /send 1234567890 Hello!\n' +
                'Example: /send 1234567890@g.us Hello group!',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        const message = args.slice(1).join(' ');

        try {
            let jid;
            if (number.includes('@')) {
                jid = number;
            } else if (number.includes('-')) {
                jid = `${number}@g.us`; // Group
            } else {
                jid = `${number}@s.whatsapp.net`; // Individual
            }

            const result = await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            
            if (result?.key?.id) {
                await this.bridge.telegramBot.sendMessage(chatId,
                    `✅ Message sent to ${number}\nMessage ID: \`${result.key.id}\``,
                    { parse_mode: 'Markdown' });
            } else {
                await this.bridge.telegramBot.sendMessage(chatId,
                    `⚠️ Message sent but no confirmation received`,
                    { parse_mode: 'Markdown' });
            }
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error sending: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing contacts and data...', { parse_mode: 'Markdown' });
        
        try {
            await this.bridge.syncContacts();
            await this.bridge.syncGroupParticipants();
            await this.bridge.updateTopicNames();
            
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Sync completed!\n` +
                `📞 Contacts: ${this.bridge.contactMappings.size}\n` +
                `💬 Chats: ${this.bridge.chatMappings.size}\n` +
                `👥 Users: ${this.bridge.userMappings.size}`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Failed to sync: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleContacts(chatId, args) {
        try {
            const page = parseInt(args[0]) || 1;
            const pageSize = 20;
            const contacts = [...this.bridge.contactMappings.entries()];
            
            if (contacts.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, '📞 No contacts found', { parse_mode: 'Markdown' });
                return;
            }

            const totalPages = Math.ceil(contacts.length / pageSize);
            const startIndex = (page - 1) * pageSize;
            const endIndex = startIndex + pageSize;
            const pageContacts = contacts.slice(startIndex, endIndex);

            const contactList = pageContacts
                .map(([phone, name], index) => `${startIndex + index + 1}. 📱 ${name || 'Unknown'} (+${phone})`)
                .join('\n');

            const message = `📞 *Contacts (Page ${page}/${totalPages})*\n\n${contactList}\n\n` +
                           `Total: ${contacts.length} contacts`;

            await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Failed to list contacts:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSearchContact(chatId, args) {
        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /searchcontact <name or phone>\nExample: /searchcontact John',
                { parse_mode: 'Markdown' });
            return;
        }

        const query = args.join(' ').toLowerCase();
        try {
            const contacts = [...this.bridge.contactMappings.entries()];
            const matches = contacts.filter(([phone, name]) =>
                name?.toLowerCase().includes(query) || phone.includes(query)
            );

            if (matches.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, 
                    `❌ No contacts found for "${query}"`, 
                    { parse_mode: 'Markdown' });
                return;
            }

            const result = matches
                .slice(0, 20) // Limit to 20 results
                .map(([phone, name], index) => `${index + 1}. 📱 ${name || 'Unknown'} (+${phone})`)
                .join('\n');

            const message = `🔍 *Search Results for "${query}"*\n\n${result}` +
                           (matches.length > 20 ? `\n\n... and ${matches.length - 20} more` : '');

            await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Failed to search contacts:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleGroups(chatId) {
        try {
            if (!this.bridge.whatsappBot?.sock) {
                await this.bridge.telegramBot.sendMessage(chatId, '❌ WhatsApp not connected', { parse_mode: 'Markdown' });
                return;
            }

            const groups = await this.bridge.whatsappBot.sock.groupFetchAllParticipating();
            const groupList = Object.values(groups);

            if (groupList.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, '👥 No groups found', { parse_mode: 'Markdown' });
                return;
            }

            const groupText = groupList
                .slice(0, 20) // Limit to 20 groups
                .map((group, index) => {
                    const participantCount = group.participants?.length || 0;
                    return `${index + 1}. 👥 ${group.subject}\n   📱 ${group.id}\n   👤 ${participantCount} members`;
                })
                .join('\n\n');

            const message = `👥 *WhatsApp Groups*\n\n${groupText}` +
                           (groupList.length > 20 ? `\n\n... and ${groupList.length - 20} more` : '');

            await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Failed to list groups:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleBlock(chatId, args) {
        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /block <number>\nExample: /block 1234567890',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            await this.bridge.whatsappBot.sock.updateBlockStatus(jid, 'block');
            
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Blocked ${number}`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error blocking: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleUnblock(chatId, args) {
        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /unblock <number>\nExample: /unblock 1234567890',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            await this.bridge.whatsappBot.sock.updateBlockStatus(jid, 'unblock');
            
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Unblocked ${number}`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error unblocking: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleMute(chatId, args) {
        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /mute <number> [duration]\nExample: /mute 1234567890 8h',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        const duration = args[1] || '8h'; // Default 8 hours
        
        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            const muteTime = this.parseDuration(duration);
            
            await this.bridge.whatsappBot.sock.chatModify({ mute: muteTime }, jid);
            
            await this.bridge.telegramBot.sendMessage(chatId,
                `🔇 Muted ${number} for ${duration}`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error muting: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleUnmute(chatId, args) {
        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /unmute <number>\nExample: /unmute 1234567890',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            await this.bridge.whatsappBot.sock.chatModify({ mute: null }, jid);
            
            await this.bridge.telegramBot.sendMessage(chatId,
                `🔊 Unmuted ${number}`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error unmuting: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleEphemeral(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /ephemeral <number> <on|off> [timer]\n' +
                'Example: /ephemeral 1234567890 on 7d\n' +
                'Timer options: 24h, 7d, 90d',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        const action = args[1].toLowerCase();
        const timer = args[2] || '7d';

        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            
            if (action === 'on') {
                const timerSeconds = this.parseEphemeralTimer(timer);
                await this.bridge.whatsappBot.sock.sendMessage(jid, {
                    disappearingMessagesInChat: timerSeconds
                });
                
                // Save to bridge settings
                this.bridge.ephemeralSettings.set(jid, {
                    enabled: true,
                    timer: timerSeconds
                });
                
                await this.bridge.telegramBot.sendMessage(chatId,
                    `⏰ Enabled ephemeral messages for ${number} (${timer})`,
                    { parse_mode: 'Markdown' });
            } else if (action === 'off') {
                await this.bridge.whatsappBot.sock.sendMessage(jid, {
                    disappearingMessagesInChat: false
                });
                
                this.bridge.ephemeralSettings.delete(jid);
                
                await this.bridge.telegramBot.sendMessage(chatId,
                    `⏰ Disabled ephemeral messages for ${number}`,
                    { parse_mode: 'Markdown' });
            } else {
                throw new Error('Action must be "on" or "off"');
            }
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error setting ephemeral: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handlePresence(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /presence <number> <available|unavailable|composing|recording>\n' +
                'Example: /presence 1234567890 available',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        const presence = args[1].toLowerCase();

        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            await this.bridge.whatsappBot.sock.sendPresenceUpdate(presence, jid);
            
            await this.bridge.telegramBot.sendMessage(chatId,
                `👁️ Set presence to ${presence} for ${number}`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error setting presence: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleLogs(chatId, args) {
        const lines = parseInt(args[0]) || 50;
        
        try {
            // This would need to be implemented based on your logging system
            await this.bridge.telegramBot.sendMessage(chatId,
                `📋 *Recent Logs (${lines} lines)*\n\n` +
                `Feature not implemented yet. Check server logs directly.`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error getting logs: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleStats(chatId) {
        try {
            const uptime = process.uptime();
            const uptimeStr = this.formatUptime(uptime);
            const memUsage = process.memoryUsage();
            
            const stats = `📊 *Bot Statistics*\n\n` +
                `⏱️ Uptime: ${uptimeStr}\n` +
                `💾 Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB\n` +
                `📱 Node.js: ${process.version}\n` +
                `🔄 CPU Usage: ${Math.round(process.cpuUsage().user / 1000)}ms\n\n` +
                `💬 Active Chats: ${this.bridge.chatMappings.size}\n` +
                `📞 Contacts: ${this.bridge.contactMappings.size}\n` +
                `👥 Users: ${this.bridge.userMappings.size}\n` +
                `🔄 Message Queue: ${Array.from(this.bridge.messageQueue.values()).reduce((a, b) => a + b.length, 0)}\n` +
                `👁️ Presence Updates: ${this.bridge.lastPresenceUpdate.size}\n` +
                `📸 Profile Pic Cache: ${this.bridge.profilePicCache.size}`;

            await this.bridge.telegramBot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error getting stats: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleBackup(chatId) {
        try {
            await this.bridge.telegramBot.sendMessage(chatId,
                '💾 Creating backup...',
                { parse_mode: 'Markdown' });

            const backupData = {
                timestamp: new Date().toISOString(),
                chatMappings: Array.from(this.bridge.chatMappings.entries()),
                contactMappings: Array.from(this.bridge.contactMappings.entries()),
                userMappings: Array.from(this.bridge.userMappings.entries()),
                ephemeralSettings: Array.from(this.bridge.ephemeralSettings.entries())
            };

            const backupJson = JSON.stringify(backupData, null, 2);
            const backupBuffer = Buffer.from(backupJson, 'utf8');

            await this.bridge.telegramBot.sendDocument(chatId, backupBuffer, {
                caption: `💾 Bridge backup created at ${new Date().toLocaleString()}`,
                filename: `bridge-backup-${Date.now()}.json`
            });

        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, 
                `❌ Error creating backup: ${error.message}`, 
                { parse_mode: 'Markdown' });
        }
    }

    async handleRestore(chatId, args) {
        // Only allow owner to restore
        const ownerId = config.get('telegram.ownerId');
        if (chatId !== ownerId) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Only the owner can restore backups',
                { parse_mode: 'Markdown' });
            return;
        }

        await this.bridge.telegramBot.sendMessage(chatId,
            '📥 To restore a backup, send the backup JSON file as a document with caption "/restore"',
            { parse_mode: 'Markdown' });
    }

    async handleAuthorize(chatId, args) {
        // Only allow owner to authorize
        const ownerId = config.get('telegram.ownerId');
        if (chatId !== ownerId) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Only the owner can authorize users',
                { parse_mode: 'Markdown' });
            return;
        }

        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /authorize <user_id>\nExample: /authorize 123456789',
                { parse_mode: 'Markdown' });
            return;
        }

        const userId = parseInt(args[0]);
        if (isNaN(userId)) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Invalid user ID',
                { parse_mode: 'Markdown' });
            return;
        }

        this.bridge.authorizedUsers.add(userId);
        await this.bridge.telegramBot.sendMessage(chatId,
            `✅ Authorized user ${userId}`,
            { parse_mode: 'Markdown' });
    }

    async handleUnauthorize(chatId, args) {
        // Only allow owner to unauthorize
        const ownerId = config.get('telegram.ownerId');
        if (chatId !== ownerId) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Only the owner can unauthorize users',
                { parse_mode: 'Markdown' });
            return;
        }

        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /unauthorize <user_id>\nExample: /unauthorize 123456789',
                { parse_mode: 'Markdown' });
            return;
        }

        const userId = parseInt(args[0]);
        if (isNaN(userId)) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Invalid user ID',
                { parse_mode: 'Markdown' });
            return;
        }

        this.bridge.authorizedUsers.delete(userId);
        await this.bridge.telegramBot.sendMessage(chatId,
            `❌ Unauthorized user ${userId}`,
            { parse_mode: 'Markdown' });
    }

    async handleBroadcast(chatId, args) {
        // Only allow owner to broadcast
        const ownerId = config.get('telegram.ownerId');
        if (chatId !== ownerId) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Only the owner can send broadcasts',
                { parse_mode: 'Markdown' });
            return;
        }

        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /broadcast <message>\nExample: /broadcast Hello everyone!',
                { parse_mode: 'Markdown' });
            return;
        }

        const message = args.join(' ');
        let sentCount = 0;
        let failedCount = 0;

        await this.bridge.telegramBot.sendMessage(chatId,
            '📢 Sending broadcast...',
            { parse_mode: 'Markdown' });

        for (const [jid] of this.bridge.chatMappings) {
            if (jid === 'status@broadcast' || jid === 'call@broadcast') continue;
            
            try {
                await this.bridge.whatsappBot.sendMessage(jid, { text: message });
                sentCount++;
                await new Promise(resolve => setTimeout(resolve, 1000)); // Rate limiting
            } catch (error) {
                failedCount++;
                logger.debug(`Failed to send broadcast to ${jid}:`, error);
            }
        }

        await this.bridge.telegramBot.sendMessage(chatId,
            `📢 Broadcast completed!\n✅ Sent: ${sentCount}\n❌ Failed: ${failedCount}`,
            { parse_mode: 'Markdown' });
    }

    async handleUpdateTopics(chatId) {
        try {
            await this.bridge.telegramBot.sendMessage(chatId,
                '📝 Updating topic names...',
                { parse_mode: 'Markdown' });

            await this.bridge.updateTopicNames();

            await this.bridge.telegramBot.sendMessage(chatId,
                '✅ Topic names updated successfully!',
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Error updating topics: ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async handleHelp(chatId) {
        const helpMessage = `🤖 *WhatsApp-Telegram Bridge Commands*\n\n` +
            `*Basic Commands:*\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/help - Show this help message\n\n` +
            
            `*Messaging:*\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/broadcast <msg> - Send to all chats (owner only)\n\n` +
            
            `*Contacts & Groups:*\n` +
            `/contacts [page] - View WhatsApp contacts\n` +
            `/searchcontact <query> - Search contacts\n` +
            `/groups - List WhatsApp groups\n` +
            `/sync - Sync contacts and data\n` +
            `/updatetopics - Update topic names\n\n` +
            
            `*Chat Management:*\n` +
            `/block <number> - Block contact\n` +
            `/unblock <number> - Unblock contact\n` +
            `/mute <number> [duration] - Mute chat\n` +
            `/unmute <number> - Unmute chat\n\n` +
            
            `*Advanced:*\n` +
            `/ephemeral <number> <on|off> [timer] - Ephemeral messages\n` +
            `/presence <number> <status> - Set presence\n` +
            `/stats - Show bot statistics\n` +
            `/logs [lines] - Show recent logs\n` +
            `/backup - Create backup\n` +
            `/restore - Restore from backup\n\n` +
            
            `*Admin (Owner Only):*\n` +
            `/authorize <user_id> - Authorize user\n` +
            `/unauthorize <user_id> - Unauthorize user\n\n` +
            
            `*Examples:*\n` +
            `• \`/send 1234567890 Hello!\`\n` +
            `• \`/mute 1234567890 8h\`\n` +
            `• \`/ephemeral 1234567890 on 7d\`\n` +
            `• \`/updatetopics\``;

        await this.bridge.telegramBot.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
    }

    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `Use /help for detailed command list\n\n` +
            `*Quick Commands:*\n` +
            `/start - Bot info\n` +
            `/status - Bridge status\n` +
            `/send <number> <msg> - Send message\n` +
            `/sync - Sync contacts\n` +
            `/contacts - View contacts\n` +
            `/updatetopics - Update topic names\n` +
            `/help - Full help`;
        
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    // Helper methods
    formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        if (days > 0) {
            return `${days}d ${hours}h ${minutes}m`;
        } else if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else {
            return `${minutes}m`;
        }
    }

    parseDuration(duration) {
        const match = duration.match(/^(\d+)([hdm])$/);
        if (!match) return 8 * 60 * 60 * 1000; // Default 8 hours
        
        const value = parseInt(match[1]);
        const unit = match[2];
        
        switch (unit) {
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            case 'm': return value * 60 * 1000;
            default: return 8 * 60 * 60 * 1000;
        }
    }

    parseEphemeralTimer(timer) {
        switch (timer) {
            case '24h': return 86400;
            case '7d': return 604800;
            case '90d': return 7776000;
            default: return 604800; // Default 7 days
        }
    }

    async registerBotCommands() {
        try {
            const commands = [
                { command: 'start', description: 'Show bot info' },
                { command: 'status', description: 'Show bridge status' },
                { command: 'help', description: 'Show help message' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Sync WhatsApp contacts' },
                { command: 'contacts', description: 'View WhatsApp contacts' },
                { command: 'searchcontact', description: 'Search WhatsApp contacts' },
                { command: 'groups', description: 'List WhatsApp groups' },
                { command: 'block', description: 'Block contact' },
                { command: 'unblock', description: 'Unblock contact' },
                { command: 'mute', description: 'Mute chat' },
                { command: 'unmute', description: 'Unmute chat' },
                { command: 'ephemeral', description: 'Set ephemeral messages' },
                { command: 'presence', description: 'Set presence status' },
                { command: 'stats', description: 'Show bot statistics' },
                { command: 'backup', description: 'Create backup' },
                { command: 'broadcast', description: 'Send broadcast message' },
                { command: 'updatetopics', description: 'Update topic names' }
            ];

            await this.bridge.telegramBot.setMyCommands(commands);
            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }
}

module.exports = TelegramCommands;