const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const dotenv = require('dotenv');
const db = require('./database');
const { handleCaptCommand, handleCaptButton, updateCaptMessage, getActiveCapt } = require('./commands/capt');
const { handlePointsButton, handleCallRequest, handleSendChannel, handleCallResponse } = require('./commands/points');
const { handleGivePoints, showGivePointsModal, handlePlayerSelection, handlePointsPage } = require('./commands/admin');
const { handleScreenSubmission, approveScreens, rejectScreens, checkMissingScreens } = require('./commands/screens');
const cron = require('node-cron');

dotenv.config();

db.run('DELETE FROM active_capts WHERE start_time < datetime("now")');
db.run('DELETE FROM participants WHERE capt_id NOT IN (SELECT id FROM active_capts)');
console.log('🗑️ Старые сборы очищены при запуске');

console.log('🔍 ПРОВЕРКА .env:');
console.log('DISCORD_TOKEN:', process.env.DISCORD_TOKEN ? '✅ Есть' : '❌ НЕТ');
console.log('CAPT_MANAGER_ROLE_ID:', process.env.CAPT_MANAGER_ROLE_ID || '❌ НЕТ');
console.log('CAPT_WATCHER_ROLE_ID:', process.env.CAPT_WATCHER_ROLE_ID || '❌ НЕТ');
console.log('CAPT_PLAYER_ROLE_ID:', process.env.CAPT_PLAYER_ROLE_ID || '❌ НЕТ');
console.log('SCREEN_CHECKER_ROLE_ID:', process.env.SCREEN_CHECKER_ROLE_ID || '❌ НЕТ');
console.log('------------------------');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages
  ]
});

client.on('error', console.error);
process.on('unhandledRejection', console.error);

const playerVoiceStatus = new Map();
const sentNotifications = new Map();
const lastCheckTime = new Map();

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;
  const command = message.content.slice(1).trim().toLowerCase();
  if (command === 'capt' || command === 'создатьсбор') {
    await handleCaptCommand(message, client);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'captModal') {
      const { handleCaptModal } = require('./commands/capt');
      await handleCaptModal(interaction, client);
    } else if (interaction.customId.startsWith('givePointsModal_')) {
      await handleGivePoints(interaction, client);
    } else if (interaction.customId.startsWith('register_')) {
      const { handleRegistrationSubmit } = require('./commands/capt');
      await handleRegistrationSubmit(interaction, client);
    }
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId === 'openCaptModal_permanent') {
      const { showCaptModal } = require('./commands/capt');
      await showCaptModal(interaction);
      return;
    }

    if (interaction.customId === 'showMyPoints') {
      await handlePointsButton(interaction, client);
      return;
    }

    if (interaction.customId === 'showGivePoints') {
      if (!interaction.member) return interaction.reply({ content: '❌ Доступно только на сервере!', ephemeral: true });
      const managerRoleId = process.env.CAPT_MANAGER_ROLE_ID;
      if (!managerRoleId || !interaction.member.roles.cache.has(managerRoleId)) {
        return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
      }
      await showGivePointsModal(interaction);
      return;
    }

    if (interaction.customId.startsWith('givePointsTo_')) {
      if (!interaction.member) return interaction.reply({ content: '❌ Доступно только на сервере!', ephemeral: true });
      const managerRoleId = process.env.CAPT_MANAGER_ROLE_ID;
      if (!managerRoleId || !interaction.member.roles.cache.has(managerRoleId)) {
        return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
      }
      await handlePlayerSelection(interaction, client);
      return;
    }

    if (interaction.customId.startsWith('playersPage_') && !interaction.customId.includes('current')) {
      if (!interaction.member) return interaction.reply({ content: '❌ Доступно только на сервере!', ephemeral: true });
      const managerRoleId = process.env.CAPT_MANAGER_ROLE_ID;
      if (!managerRoleId || !interaction.member.roles.cache.has(managerRoleId)) {
        return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
      }
      const page = interaction.customId.split('_')[1];
      await handlePointsPage(interaction, page);
      return;
    }

    if (interaction.customId.startsWith('join_') || interaction.customId.startsWith('sub_') || interaction.customId.startsWith('leave_')) {
      await handleCaptButton(interaction, client);
      return;
    }

    if (interaction.customId.startsWith('close_')) {
      const managerRoleId = process.env.CAPT_MANAGER_ROLE_ID;
      if (!managerRoleId || !interaction.member.roles.cache.has(managerRoleId)) {
        return interaction.reply({ content: '❌ У вас нет прав для закрытия капта!', ephemeral: true });
      }
      
      const captId = interaction.customId.split('_')[1];
      db.run('DELETE FROM active_capts WHERE id = ?', [captId]);
      db.run('DELETE FROM participants WHERE capt_id = ?', [captId]);
      
      try {
        await interaction.message.delete();
      } catch(e) {
        console.error('❌ Не удалось удалить сообщение:', e.message);
      }
      
      for (const key of sentNotifications.keys()) {
        if (key.startsWith(`${captId}_`)) {
          sentNotifications.delete(key);
        }
      }
      
      await interaction.reply({ content: `✅ Капт #${captId} успешно закрыт и удалён!`, ephemeral: true });
      return;
    }

    // ========= ОДОБРЕНИЕ СКРИНОВ (оба сразу) =========
    if (interaction.customId.startsWith('approve_screens_')) {
      const checkerRoleId = process.env.SCREEN_CHECKER_ROLE_ID;
      if (!checkerRoleId || !interaction.member.roles.cache.has(checkerRoleId)) {
        return interaction.reply({ content: '❌ У вас нет прав для проверки скринов!', ephemeral: true });
      }
      await approveScreens(interaction, client);
      return;
    }

    // ========= ОТКЛОНЕНИЕ СКРИНОВ (оба сразу) =========
    if (interaction.customId.startsWith('reject_screens_')) {
      const checkerRoleId = process.env.SCREEN_CHECKER_ROLE_ID;
      if (!checkerRoleId || !interaction.member.roles.cache.has(checkerRoleId)) {
        return interaction.reply({ content: '❌ У вас нет прав для проверки скринов!', ephemeral: true });
      }
      await rejectScreens(interaction, client);
      return;
    }

    if (interaction.customId.startsWith('tegs_confirm_')) {
      const captId = interaction.customId.split('_')[2];
      await interaction.reply({ content: `✅ Ты подтвердил, что едешь в строй на капт #${captId}!`, ephemeral: true });
      
      const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
      if (logChannel) {
        await logChannel.send(`🚗 **${interaction.user.username}** подтвердил выезд на капт #${captId}`);
      }
      return;
    }

    if (interaction.customId.startsWith('call_')) {
      await handleCallRequest(interaction, client);
      return;
    }

    if (interaction.customId.startsWith('sendChannel_')) {
      if (!interaction.member) return interaction.reply({ content: '❌ Доступно только на сервере!', ephemeral: true });
      const watcherRoleId = process.env.CAPT_WATCHER_ROLE_ID;
      if (!watcherRoleId || !interaction.member.roles.cache.has(watcherRoleId)) {
        return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
      }
      await handleSendChannel(interaction, client);
      return;
    }

    if (interaction.customId.startsWith('tier_')) {
      let hasPermission = false;
      if (interaction.member) {
        const watcherRoleId = process.env.CAPT_WATCHER_ROLE_ID;
        hasPermission = watcherRoleId && interaction.member.roles.cache.has(watcherRoleId);
      } else {
        try {
          const guild = await client.guilds.fetch(process.env.GUILD_ID);
          const member = await guild.members.fetch(interaction.user.id);
          const watcherRoleId = process.env.CAPT_WATCHER_ROLE_ID;
          hasPermission = watcherRoleId && member.roles.cache.has(watcherRoleId);
        } catch(e) {}
      }
      if (!hasPermission) return interaction.reply({ content: '❌ У вас нет прав!', ephemeral: true });
      await handleCallResponse(interaction, client);
      return;
    }
  }
});

async function getParticipantsByType(captId, type) {
  return new Promise((resolve) => {
    db.all('SELECT * FROM participants WHERE capt_id = ? AND type = ?', [captId, type], (err, rows) => resolve(rows || []));
  });
}

function getEnemyByCaptId(captId) {
  return new Promise((resolve) => {
    db.get('SELECT enemy FROM active_capts WHERE id = ?', [captId], (err, row) => resolve(row ? row.enemy : 'Неизвестно'));
  });
}

async function checkVoiceChannel(captId, startTime) {
  const now = new Date();
  const timeToStart = new Date(startTime) - now;
  const minutesLeft = Math.floor(timeToStart / 60000);
  
  if (minutesLeft > 10 || minutesLeft < 0) return;
  
  const lastCheck = lastCheckTime.get(captId);
  if (lastCheck && (now - lastCheck) < 30000) return;
  lastCheckTime.set(captId, now);
  
  console.log(`🔍 ПРОВЕРКА ГОЛОСА: captId=${captId}, до капта ${minutesLeft} мин`);
  
  const players = await getParticipantsByType(captId, 'join');
  if (players.length === 0) return;
  
  const voiceChannelId = process.env.VOICE_CHANNEL_ID;
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const voiceChannel = await guild.channels.fetch(voiceChannelId);
  
  const membersInVoice = new Map();
  voiceChannel.members.forEach(member => {
    const isMuted = member.voice.selfMute || member.voice.selfDeaf || member.voice.serverMute || member.voice.serverDeaf;
    membersInVoice.set(member.id, { isMuted: isMuted, isSelfMute: member.voice.selfMute, isServerMute: member.voice.serverMute });
  });
  
  const problemPlayers = [];
  
  for (const player of players) {
    const voiceInfo = membersInVoice.get(player.user_id);
    const status = playerVoiceStatus.get(player.user_id);
    const nowTime = Date.now();
    
    if (!voiceInfo) {
      if (!status || (nowTime - status.lastNotified) > 120000) {
        try {
          const user = await client.users.fetch(player.user_id);
          await user.send(`🚨 **ВНИМАНИЕ!**\n\nДо капта осталось **${minutesLeft}** минут!\nТы **НЕ В ГОЛОСОВОМ КАНАЛЕ**!\n\n🎤 Канал: <#${voiceChannelId}>\n\n**Срочно зайди в голосовой канал!**`);
          playerVoiceStatus.set(player.user_id, { lastNotified: nowTime, problem: 'not_in_voice' });
          problemPlayers.push(`❌ <@${player.user_id}> — не в голосовом канале`);
        } catch(e) {}
      }
    } else if (voiceInfo.isMuted) {
      const muteType = voiceInfo.isSelfMute ? 'самомут' : 'серверный мут';
      if (!status || (nowTime - status.lastNotified) > 120000 || status.problem !== 'muted') {
        try {
          const user = await client.users.fetch(player.user_id);
          await user.send(`🔇 **ВНИМАНИЕ!**\n\nДо капта осталось **${minutesLeft}** минут!\nТы в **${muteType}**!\n\n**Пожалуйста, сними мут!**`);
          playerVoiceStatus.set(player.user_id, { lastNotified: nowTime, problem: 'muted' });
          problemPlayers.push(`🔇 <@${player.user_id}> — ${muteType}`);
        } catch(e) {}
      }
    } else {
      if (status) {
        console.log(`✅ Игрок ${player.user_id} в порядке`);
        playerVoiceStatus.delete(player.user_id);
      }
    }
  }
  
  if (problemPlayers.length > 0) {
    const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
    if (logChannel) {
      await logChannel.send(`🚨 **ПРОВЕРКА КАПТА ${captId} (за ${minutesLeft} мин)**\n${problemPlayers.join('\n')}`);
    }
  }
}

async function sendNotifications(captId, startTime) {
  const now = new Date();
  const timeToStart = new Date(startTime) - now;
  const minutesLeft = Math.floor(timeToStart / 60000);
  
  if (minutesLeft < 0) return;
  
  if (minutesLeft === 10 || minutesLeft === 5 || minutesLeft === 1) {
    const notificationKey = `${captId}_${minutesLeft}`;
    if (sentNotifications.has(notificationKey)) return;
    
    console.log(`📢 ОТПРАВКА НАПОМИНАНИЙ ЗА ${minutesLeft} МИНУТ!`);
    
    const players = await getParticipantsByType(captId, 'join');
    const subs = await getParticipantsByType(captId, 'sub');
    const all = [...players, ...subs];
    const enemy = await getEnemyByCaptId(captId);
    
    for (const p of all) {
      try {
        const user = await client.users.fetch(p.user_id);
        let roleText = p.type === 'join' ? '✅ Основной состав' : '🔄 Замена';
        await user.send(`⏰ **НАПОМИНАНИЕ О КАПТЕ!**\n\nДо начала осталось **${minutesLeft}** минут!\n👥 Противник: ${enemy}\n📋 Ваш статус: ${roleText}\n\nГотовься! 🎮`);
      } catch(e) {}
    }
    sentNotifications.set(notificationKey, true);
    setTimeout(() => sentNotifications.delete(notificationKey), 3600000);
  }
}

setInterval(async () => {
  const now = new Date();
  const activeCapts = await new Promise((resolve) => {
    db.all('SELECT * FROM active_capts', (err, rows) => resolve(rows || []));
  });
  
  for (const capt of activeCapts) {
    const timeToStart = new Date(capt.start_time) - now;
    const minutesLeft = Math.floor(timeToStart / 60000);
    
    await checkVoiceChannel(capt.id, capt.start_time);
    await sendNotifications(capt.id, capt.start_time);
    
    if (minutesLeft <= 3 && minutesLeft > 0) {
      console.log(`🗑️ ОЧИСТКА ЗАМЕНЫ: captId=${capt.id}`);
      db.run('DELETE FROM participants WHERE capt_id = ? AND type = "sub"', [capt.id]);
      const updatedCapt = await getActiveCapt(capt.id);
      if (updatedCapt) await updateCaptMessage(updatedCapt, client);
    }
    
    if (minutesLeft <= 0 && minutesLeft > -5) {
      await checkMissingScreens(capt.id, client);
    }
  }
}, 30000);

cron.schedule('0 * * * *', async () => {
  const oneHourAgo = new Date(Date.now() - 3600000);
  db.run('DELETE FROM active_capts WHERE start_time < ?', [oneHourAgo.toISOString()]);
  db.run('DELETE FROM participants WHERE capt_id NOT IN (SELECT id FROM active_capts)');
  console.log('🗑️ Часовая очистка выполнена');
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== 1) return;
  await handleScreenSubmission(message, client);
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Бот запущен как ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ ОШИБКА ЛОГИНА:', err.message);
});