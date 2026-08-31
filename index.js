import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage,
    downloadMediaMessage
} from '@whiskeysockets/baileys';
import http from 'http';
http.createServer((req, res) => res.end('Bot Online')).listen(process.env.PORT || 3000);
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import sharp from 'sharp';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path'; 
import { PDFDocument } from 'pdf-lib';

const startTime = new Date();
const messageStore = new Map();

// --- ÉTAT GLOBAL ET SÉCURITÉ ANTI-BAN SIGNALEMENT ---
let autoLikeStatus = false;
let autoWelcome = true;
const likedStatuses = new Set();
const welcomedUsers = new Set();

// Configuration Anti-Signalement
let publicMode = false;
const spamTracker = new Map();
const SPAM_LIMIT = 5;

// Quota Auto-Like Status
let dailyLikeCount = 0;
const MAX_DAILY_LIKES = 60;
let lastResetDate = new Date().toDateString();

function checkAndResetDailyQuota() {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
        dailyLikeCount = 0;
        lastResetDate = today;
        likedStatuses.clear();
    }
}

async function getMediaBuffer(mediaMessage, type) {
    const stream = await downloadContentFromMessage(mediaMessage, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

function getDayOfWeek(dateString) {
    const parts = dateString.split('/');
    if (parts.length !== 3) return null;

    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);

    if (isNaN(day) || isNaN(month) || isNaN(year)) return null;

    const date = new Date(year, month, day);
    if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;

    const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

    return {
        dayName: days[date.getDay()],
        fullDateFormatted: `${day} ${months[month]} ${year}`
    };
}

async function startBot() {
    console.log("Démarrage du bot de GOD Enrick (Protection Anti-Signalement Active)...");
    
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        fireInitQueries: true,            // Force l'échange initial de clés
        shouldSyncHistoryMessage: () => false,
        emitOwnEvents: false,
        // Résout le problème des messages en attente en puisant dans la mémoire du bot
        getMessage: async (key) => {
            if (messageStore.has(key.id)) {
                return messageStore.get(key.id).message;
            }
            return { conversation: '' };
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("\n Scanne ce QR Code avec WhatsApp :");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connexion interrompue (code: ${statusCode}). Reconnexion...`);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot de GOD Enrick connecté avec succès !');
        }
    });

    // --- MODULE ANTI-DELETE ---
    sock.ev.on('messages.update', async (updates) => {
        for (const update of updates) {
            if (update.update?.message === null || update.update?.protocolMessage?.type === 0) {
                const deletedKey = update.key;
                const storedMsg = messageStore.get(deletedKey.id);

                if (storedMsg) {
                    const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    const sender = storedMsg.key.participant || storedMsg.key.remoteJid;
                    const fromGroup = storedMsg.key.remoteJid.endsWith('@g.us') ? storedMsg.key.remoteJid : 'Discussion Privée';

                    const headerInfo = `🗑️ *MESSAGE SUPPRIMÉ DÉTECTÉ*\n\n` +
                                       `👤 Expéditeur : @${sender.split('@')[0]}\n` +
                                       `📍 Source : ${fromGroup}\n` +
                                       `─────── MESSAGE RECOUVRÉ ───────`;

                    try {
                        const msgContent = storedMsg.message;
                        const textContent = msgContent.conversation || msgContent.extendedTextMessage?.text;
                        const imgMsg = msgContent.imageMessage;
                        const vidMsg = msgContent.videoMessage;

                        if (textContent) {
                            await sock.sendMessage(myJid, { text: `${headerInfo}\n\n💬 Texte : ${textContent}`, mentions: [sender] });
                        } else if (imgMsg) {
                            const buffer = await getMediaBuffer(imgMsg, 'image');
                            await sock.sendMessage(myJid, { image: buffer, caption: `${headerInfo}\n🖼️ Photo supprimée`, mentions: [sender] });
                        } else if (vidMsg) {
                            const buffer = await getMediaBuffer(vidMsg, 'video');
                            await sock.sendMessage(myJid, { video: buffer, caption: `${headerInfo}\n🎥 Vidéo supprimée`, mentions: [sender] });
                        }
                    } catch (e) {
                        console.error("Erreur récupération Anti-Delete:", e);
                    }
                }
            }
        }
    });

    // --- TRAITEMENT DES MESSAGES ET COMMANDES ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const from = msg.key.remoteJid;

            // 🟢 TRAITEMENT DES STATUTS (AUTO-LIKE)
            if (from === 'status@broadcast' && !msg.key.fromMe) {
                if (!autoLikeStatus) continue;

                checkAndResetDailyQuota();
                if (dailyLikeCount >= MAX_DAILY_LIKES) continue;

                const statusId = msg.key.id;
                if (likedStatuses.has(statusId)) continue;
                likedStatuses.add(statusId);

                const delay = Math.floor(Math.random() * 15000) + 5000;

                setTimeout(async () => {
                    if (!autoLikeStatus) return;
                    try {
                        const author = msg.key.participant || msg.participant;

                        await sock.readMessages([msg.key]);

                        await sock.sendMessage(
                            'status@broadcast',
                            { react: { text: '❤️', key: msg.key } },
                            { statusJidList: [author] }
                        );

                        dailyLikeCount++;
                        console.log(`💚 [AUTO-LIKE] Statut de ${author.split('@')[0]} liké ! (${dailyLikeCount}/${MAX_DAILY_LIKES})`);
                    } catch (err) {
                        console.error("❌ Erreur lors du like de statut:", err);
                    }
                }, delay);

                continue;
            }

            // Mémorisation des messages normaux pour l'anti-delete & le déchiffrement
            if (msg.key && msg.key.id) {
                messageStore.set(msg.key.id, msg);
                if (messageStore.size > 1000) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
            }

            const rawText = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                ''
            ).trim();

            const text = rawText.toLowerCase();
            const myJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

            const senderJid = msg.key.participant || msg.key.remoteJid;
            const isOwner = msg.key.fromMe || senderJid.includes(sock.user.id.split(':')[0]);

            // 🤖 MESSAGE AUTOMATIQUE POUR LES MP INCONNUS
            if (autoWelcome && !isOwner && !from.endsWith('@g.us')) {
                if (!welcomedUsers.has(senderJid)) {
                    welcomedUsers.add(senderJid);
                    const welcomeMessage = `👋 *Salut !*\n\nActuellement, je suis probablement en train de réfléchir, de jouer ou de chercher à vous surpasser ! 😼\n\nQuoi qu'il en soit, je réponds généralement très vite aux messages. Mon propriétaire repasse par ici très bientôt ! 😉`;
                    await sock.sendMessage(from, { text: welcomeMessage }, { quoted: msg });
                }
            }

            // 🛡️ DÉFENSE 1: PROTECTION ANTI-SPAM
            if (!isOwner && !from.endsWith('@g.us')) {
                const now = Date.now();
                const userSpam = spamTracker.get(senderJid) || { count: 0, lastMsg: now };

                if (now - userSpam.lastMsg < 10000) {
                    userSpam.count += 1;
                } else {
                    userSpam.count = 1;
                }
                userSpam.lastMsg = now;
                spamTracker.set(senderJid, userSpam);

                if (userSpam.count > SPAM_LIMIT) {
                    console.log(`⚠️ Spam détecté venant de ${senderJid}. Blocage de sécurité.`);
                    await sock.sendMessage(from, { text: '🚫 *Spam détecté. Vous avez été bloqué pour protéger ce compte.*' });
                    await sock.updateBlockStatus(senderJid, 'block');
                    spamTracker.delete(senderJid);
                    return;
                }
            }

            // 🛡️ DÉFENSE 2: REJET DU MODE PUBLIC SI DÉSACTIVÉ
            if (!isOwner && !publicMode && text.startsWith('.')) {
                return;
            }

            // --- COMMANDES DE CONTRÔLE DE SÉCURITÉ ---
            if (isOwner && text === '.mode public') {
                publicMode = true;
                return await sock.sendMessage(from, { text: '🔓 *Mode Public ACTIVÉ* (Tout le monde peut utiliser le bot).' }, { quoted: msg });
            }

            if (isOwner && text === '.mode private') {
                publicMode = false;
                return await sock.sendMessage(from, { text: '🔒 *Mode Privé ACTIVÉ* (Seul vous pouvez utiliser le bot. Protection Anti-Ban optimale).' }, { quoted: msg });
            }

            // --- COMMANDES AUTO-WELCOME ---
            if (isOwner && text === '.welcome on') {
                autoWelcome = true;
                return await sock.sendMessage(from, { text: '💬 *Message d\'accueil automatique ACTIVÉ !*' }, { quoted: msg });
            }

            if (isOwner && text === '.welcome off') {
                autoWelcome = false;
                return await sock.sendMessage(from, { text: '❌ *Message d\'accueil automatique DÉSACTIVÉ !*' }, { quoted: msg });
            }

            // --- COMMANDES AUTO-LIKE STATUT ---
            if (text === '.statut on') {
                autoLikeStatus = true;
                return await sock.sendMessage(from, { text: '🛡️ *Auto-Like Anti-Ban ACTIVÉ !*' }, { quoted: msg });
            }

            if (text === '.statut off') {
                autoLikeStatus = false;
                return await sock.sendMessage(from, { text: '❌ *Auto-Like des statuts DÉSACTIVÉ !*' }, { quoted: msg });
            }

            if (text === '.statut status') {
                checkAndResetDailyQuota();
                const statusInfo = `📊 *SÉCURITÉ ET STATISTIQUES*\n\n` +
                                   `🔒 Mode Bot : *${publicMode ? 'Public' : 'Privé (Protégé)'}*\n` +
                                   `💬 Auto-Welcome : *${autoWelcome ? 'ACTIVÉ' : 'DÉSACTIVÉ'}*\n` +
                                   `🟢 Auto-Like : *${autoLikeStatus ? 'ACTIVÉ' : 'DÉSACTIVÉ'}*\n` +
                                   `📈 Likes aujourd'hui : *${dailyLikeCount} / ${MAX_DAILY_LIKES}*`;
                return await sock.sendMessage(from, { text: statusInfo }, { quoted: msg });
            }

            // --- COMMANDES EXCLUSIVES OWNER ---
            if (isOwner) {
                if (text === '.setbotimg' || text === '.setpp') {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const imgMsg = msg.message.imageMessage || quotedMsg?.imageMessage;

                    if (!imgMsg) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });

                    try {
                        await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });
                        const buffer = await getMediaBuffer(imgMsg, 'image');
                        const resizedBuffer = await sharp(buffer).resize(640, 640, { fit: 'cover' }).jpeg().toBuffer();
                        await sock.updateProfilePicture(myJid, resizedBuffer);
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    }
                }

                if (text === '.restart') {
                    await sock.sendMessage(from, { react: { text: '🔄', key: msg.key } });
                    process.exit(0);
                }

                if (text.startsWith('.setname ')) {
                    const newName = rawText.slice(9).trim();
                    if (!newName) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });
                    try {
                        await sock.updateProfileName(newName);
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    }
                }

                if (text === '.block' || text === '.unblock') {
                    const quotedMsg = msg.message.extendedTextMessage?.contextInfo;
                    const targetUser = quotedMsg?.participant || from;

                    if (targetUser.endsWith('@g.us')) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });

                    try {
                        const action = text === '.block' ? 'block' : 'unblock';
                        await sock.updateBlockStatus(targetUser, action);
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } catch (e) {
                        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    }
                }
            }

            // --- COMMANDE .PLAY ---
            if (text.startsWith('.play ')) {
                const query = rawText.slice(6).trim();
                if (!query) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });

                await sock.sendMessage(from, { react: { text: '🎵', key: msg.key } });
                const tempOutput = path.join('./', `play_${Date.now()}.mp3`);
                
                const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
                const cmd = `yt-dlp --no-check-certificates --cookies cookies.txt "ytsearch1:${query.replace(/"/g, '')}" -x --audio-format mp3 -o "${tempOutput}"`;

                exec(cmd, { env }, async (err, stdout, stderr) => {
                    if (err) {
                        console.error("Erreur Exec Play:", stderr || err);
                        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    } else {
                        const audioBuffer = fs.readFileSync(tempOutput);
                        await sock.sendMessage(from, { audio: audioBuffer, mimetype: 'audio/mp4' }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
                    }
                });
            }

            // --- COMMANDE .VIDEO ---
            if (text.startsWith('.video ')) {
                const query = rawText.slice(7).trim(); 
                if (!query) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });

                await sock.sendMessage(from, { react: { text: '🎬', key: msg.key } });
                const tempOutput = path.join('./', `vid_${Date.now()}.mp4`);

                const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
                const cmd = `yt-dlp --no-check-certificates --cookies cookies.txt "ytsearch1:${query.replace(/"/g, '')}" -f "b[ext=mp4]/b" -o "${tempOutput}"`;

                exec(cmd, { env }, async (err, stdout, stderr) => {
                    if (err) {
                        console.error("Erreur Exec Video:", stderr || err);
                        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    } else {
                        const videoBuffer = fs.readFileSync(tempOutput);
                        await sock.sendMessage(from, { video: videoBuffer, caption: '🎥 *GOD Enrick Bot*' }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
                    }
                });
            }

            // --- COMMANDES DL RÉSEAUX SOCIAUX ---
            if (text.startsWith('.tiktok ') || text.startsWith('.fbk ') || text.startsWith('.insta ') || text.startsWith('.x ')) {
                const url = rawText.split(' ')[1]?.trim();
                if (!url) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });

                await sock.sendMessage(from, { react: { text: '📥', key: msg.key } });
                const tempOutput = path.join('./', `dl_${Date.now()}.mp4`);

                const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}` };
                const cmd = `yt-dlp "${url}" --no-check-certificates -f "b[ext=mp4]/b" -o "${tempOutput}"`;

                exec(cmd, { env }, async (err, stdout, stderr) => {
                    if (err) {
                        console.error("Erreur Exec DL:", stderr || err);
                        await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    } else {
                        const videoBuffer = fs.readFileSync(tempOutput);
                        await sock.sendMessage(from, { video: videoBuffer, caption: '📥 *Téléchargé par GOD Enrick Bot*' }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                        if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
                    }
                });
            }

            // --- COMMANDE .PDF ---
            if (text === '.pdf') {
                try {
                    const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
                    const targetMsg = msg.message?.imageMessage ? msg : (quotedMsg?.imageMessage ? { message: quotedMsg } : null);

                    if (!targetMsg) {
                        return await sock.sendMessage(from, { text: '❌ *Veuillez envoyer ou citer une image avec la commande .pdf*' }, { quoted: msg });
                    }

                    await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });

                    const imageBuffer = await downloadMediaMessage(targetMsg, 'buffer', {}, { options: { timeout: 30000 } });
                    const pdfDoc = await PDFDocument.create();
                    let image;

                    try {
                        image = await pdfDoc.embedJpg(imageBuffer);
                    } catch {
                        image = await pdfDoc.embedPng(imageBuffer);
                    }

                    const page = pdfDoc.addPage([image.width, image.height]);
                    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });

                    const pdfBytes = await pdfDoc.save();

                    await sock.sendMessage(from, {
                        document: Buffer.from(pdfBytes),
                        mimetype: 'application/pdf',
                        fileName: 'Converti_GOD_Enrick.pdf'
                    }, { quoted: msg });

                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });

                } catch (error) {
                    console.error("Erreur conversion PDF:", error);
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(from, { text: '❌ *Erreur lors de la création du PDF.*' }, { quoted: msg });
                }
            }

            // --- COMMANDE .SAVE ---
            if (text === '.save') {
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                const imgMsg = msg.message.imageMessage || quotedMsg?.imageMessage;
                const vidMsg = msg.message.videoMessage || quotedMsg?.videoMessage;

                if (!imgMsg && !vidMsg) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });

                try {
                    await sock.sendMessage(from, { react: { text: '💾', key: msg.key } });

                    if (imgMsg) {
                        const buffer = await getMediaBuffer(imgMsg, 'image');
                        await sock.sendMessage(myJid, { image: buffer, caption: '📥 *Statut sauvegardé par GOD Enrick*' });
                    } else if (vidMsg) {
                        const buffer = await getMediaBuffer(vidMsg, 'video');
                        await sock.sendMessage(myJid, { video: buffer, caption: '📥 *Statut sauvegardé par GOD Enrick*' });
                    }

                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } catch (e) {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                }
            }

            // --- COMMANDE .STICKER / .S ---
            if (text === '.sticker' || text === '.s') {
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                const imgMsg = msg.message.imageMessage || quotedMsg?.imageMessage;
                const vidMsg = msg.message.videoMessage || quotedMsg?.videoMessage;

                if (!imgMsg && !vidMsg) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });

                try {
                    await sock.sendMessage(from, { react: { text: '⏳', key: msg.key } });

                    if (imgMsg) {
                        const buffer = await getMediaBuffer(imgMsg, 'image');
                        const stickerBuffer = await sharp(buffer)
                            .resize(320, 320, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                            .webp()
                            .toBuffer();
                        
                        await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                        await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                    } else if (vidMsg) {
                        const buffer = await getMediaBuffer(vidMsg, 'video');
                        const tempInput = path.join('./', `input_${Date.now()}.mp4`);
                        const tempOutput = path.join('./', `output_${Date.now()}.webp`);

                        fs.writeFileSync(tempInput, buffer);

                        const ffmpegCmd = `ffmpeg -i "${tempInput}" -vcodec libwebp -filter:v "scale='min(320,iw)':min(320,ih)':force_original_aspect_ratio=decrease,fps=15,pad=320:320:-1:-1:color=0x00000000" -t 3 -an -preset default -loop 0 -vsync 0 -s 320x320 "${tempOutput}"`;

                        exec(ffmpegCmd, async (err) => {
                            if (err) {
                                await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                            } else {
                                const stickerBuffer = fs.readFileSync(tempOutput);
                                await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg });
                                await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                                if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
                            }
                            if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
                        });
                    }
                } catch (e) {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                }
            }

            // --- COMMANDE .VV ---
            if (text === '.vv') {
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                
                const voContent = quotedMsg?.viewOnceMessage?.message || 
                                  quotedMsg?.viewOnceMessageV2?.message || 
                                  quotedMsg?.viewOnceMessageV2Extension?.message ||
                                  quotedMsg;

                const voImage = voContent?.imageMessage;
                const voVideo = voContent?.videoMessage;

                if (!voImage && !voVideo) return await sock.sendMessage(from, { react: { text: '⚠️', key: msg.key } });

                try {
                    await sock.sendMessage(from, { react: { text: '🔓', key: msg.key } });

                    if (voImage) {
                        const buffer = await getMediaBuffer(voImage, 'image');
                        await sock.sendMessage(myJid, { image: buffer, caption: `🔓 *Photo Vue Unique Extraite*\n📩 Source : ${from}` });
                    } else if (voVideo) {
                        const buffer = await getMediaBuffer(voVideo, 'video');
                        await sock.sendMessage(myJid, { video: buffer, caption: `🔓 *Vidéo Vue Unique Extraite*\n📩 Source : ${from}` });
                    }

                    await sock.sendMessage(from, { react: { text: '✅', key: msg.key } });
                } catch (e) {
                    await sock.sendMessage(from, { react: { text: '❌', key: msg.key } });
                }
            }

            // --- COMMANDES GÉNÉRALES ---
            if (text === '.ping') await sock.sendMessage(from, { text: 'Pong! 🏓 | Bot by GOD Enrick' }, { quoted: msg });
            if (text === '.owner') await sock.sendMessage(from, { text: '👑 Créateur du Bot : *GOD Enrick*' }, { quoted: msg });

            if (text === '.alive') {
                const now = new Date();
                const uptimeMs = now - startTime;
                const uptimeSec = Math.floor((uptimeMs / 1000) % 60);
                const uptimeMin = Math.floor((uptimeMs / (1000 * 60)) % 60);
                const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));

                const aliveMsg = `⚡ *GOD ENRICK BOT EST EN LIGNE !*\n\n` +
                                 `🟢 Status : Actif\n` +
                                 `⏱️ Uptime : ${uptimeHours}h ${uptimeMin}m ${uptimeSec}s\n` +
                                 `📍 Emplacement : Libreville, Gabon 🇬🇦\n` +
                                 `👑 Master : GOD Enrick`;

                await sock.sendMessage(from, { text: aliveMsg }, { quoted: msg });
            }

            if (text.startsWith('.hdb')) {
                const args = rawText.split(' ').slice(1);
                let targetDate = '26/03/2006';
                if (args.length > 0 && args[0].includes('/')) targetDate = args[0];

                const result = getDayOfWeek(targetDate);
                if (!result) {
                    await sock.sendMessage(from, { text: '⚠️ Format invalide. Utilise : `.hdb JJ/MM/AAAA`' }, { quoted: msg });
                } else {
                    const response = `📅 *CALCULATEUR DE JOUR DE NAISSANCE*\n\n` +
                                     `🎈 Date : *${result.fullDateFormatted}*\n` +
                                     `🗓️ Jour : *${result.dayName}*\n\n` +
                                     `_Bot by GOD Enrick_`;
                    await sock.sendMessage(from, { text: response }, { quoted: msg });
                }
            }

            // --- MENU COMPLET ---
            if (text === '.menu') {
                const menuText = 
`──────────────⭓
│ 👤 *GOD ENRICK BOT*
│ 👑 Owner : GOD Enrick
│ ⚙️ Prefix : [ . ]
╰───────────────⭓
╭─🏠 *MAIN*
│ • .ping
│ • .salut
│ • .alive
│ • .hdb [JJ/MM/AAAA]
│ • .owner
│ • .menu
╰───────────────⭓

🛠️ *TOOLS & DOWNLOADS*
│ • .play <titre> (Audio MP3)
│ • .video <titre> (Vidéo YouTube)
│ • .tiktok <lien>
│ • .fbk <lien>
│ • .insta <lien>
│ • .x <lien>
│ • .pdf (Convertit une image en PDF)
│ • .sticker (ou .s)
│ • .vv (débloque en MP)
│ • .save (enregistre les statuts)

╭─🛡️ *SECURITY & AUTO*
│ • .mode private (Mode privé - Sécurité max)
│ • .mode public (Autorise tout le monde)
│ • .welcome on / off (Message d'accueil)
│ • .statut on / off (Auto-like statuts)
│ • .statut status (Statistiques)

╭─👑 *OWNER* (God Enrick)
│ • .setbotimg
│ • .setname <Nom>
│ • .block / .unblock
│ • .restart
╰───────────────⭓`;
                await sock.sendMessage(from, { text: menuText }, { quoted: msg });
            }
        }
    });
}

// Interception des erreurs réseau et de déchiffrement de session
process.on('uncaughtException', (err) => {
    if (
        err.message?.includes('MessageCounterError') || 
        err.message?.includes('Failed to decrypt') ||
        err.message?.includes('Session closed')
    ) {
        console.log('⚠️ Session/Déchiffrement géré automatiquement (Avertissement ignoré)');
        return;
    }
    console.error('Erreur non gérée :', err);
});

process.on('unhandledRejection', (reason) => {
    if (
        reason?.message?.includes('MessageCounterError') || 
        reason?.message?.includes('Failed to decrypt') ||
        reason?.message?.includes('Session closed')
    ) {
        console.log('⚠️ Session/Déchiffrement géré automatiquement (Avertissement ignoré)');
        return;
    }
    console.error('Rejet non géré :', reason);
});

startBot();