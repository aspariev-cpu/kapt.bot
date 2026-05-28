const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const db = require('../database');

async function getUserData(userId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (!row) {
        db.run('INSERT INTO users (user_id, username, created_at) VALUES (?, ?, ?)', 
          [userId, 'Unknown', new Date().toISOString()]);
        resolve({ user_id: userId, points: 0, tier: 'none', pending_tier: 'none', call_notified: 0 });
      } else {
        resolve(row);
      }
    });
  });
}

async function updateUserPoints(userId, points) {
  return new Promise((resolve) => {
    db.run('UPDATE users SET points = ? WHERE user_id = ?', [points, userId], (err) => resolve());
  });
}

async function checkTierAchievements(userId, client, newPoints) {
  const user = await getUserData(userId);
  const getTierByPoints = (points) => {
    if (points >= 700) return 'tier1';
    if (points >= 400) return 'tier2';
    if (points >= 100) return 'tier3';
    return 'none';
  };
  
  const getTierName = (tier) => {
    const names = { 'tier1': 'Тир 1', 'tier2': 'Тир 2', 'tier3': 'Тир 3', 'none': 'Нет тира' };
    return names[tier] || 'Нет тира';
  };
  
  const newTier = getTierByPoints(newPoints);
  const currentTier = user.tier;
  
  if (newTier === currentTier || user.call_notified === 1) return;
  
  const tierOrder = { 'none': 0, 'tier3': 1, 'tier2': 2, 'tier1': 3 };
  if (tierOrder[newTier] > tierOrder[currentTier]) {
    await new Promise((resolve) => {
      db.run('UPDATE users SET pending_tier = ?, call_notified = 1 WHERE user_id = ?', [newTier, userId], (err) => resolve());
    });
    
    try {
      const userDiscord = await client.users.fetch(userId);
      
      const embed = {
        title: '🎤 **ПОЗДРАВЛЯЕМ!**',
        description: `Ты набрал **${newPoints}** баллов!\n\nТы можешь получить роль **${getTierName(newTier)}**!\n\nНажми на кнопку ниже, чтобы записаться на обзвон.`,
        color: 0x00FF00,
        footer: { text: 'Обзвон проводится смотрящим за каптами' }
      };
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`call_${userId}_${newTier}`)
          .setLabel('🎙 ЗАПИСАТЬСЯ НА ОБЗВОН')
          .setStyle(ButtonStyle.Primary)
      );
      
      await userDiscord.send({ embeds: [embed], components: [row] });
      console.log(`✅ Отправлено ЛС игроку ${userId} о достижении тира ${newTier}`);
    } catch(e) {
      console.error(`❌ Не удалось отправить ЛС игроку ${userId}:`, e.message);
    }
  }
}

async function sendScreenRequest(captId, player, enemy, minutesLeft, client) {
  const existing = await new Promise((resolve) => {
    db.get('SELECT * FROM player_screen_status WHERE capt_id = ? AND user_id = ?', [captId, player.user_id], (err, row) => resolve(row));
  });
  
  if (existing && existing.notified === 1) return;
  
  const embed = {
    title: '🎮 **ПОДТВЕРЖДЕНИЕ УЧАСТИЯ В КАПТЕ**',
    description: `>>> Ты записан в основной состав на капт #${captId}.
    
    **👥 Противник:** \`${enemy}\`
    **⏰ До капта осталось:** ${minutesLeft} минут
    
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    
    📸 **Отправь 2 скриншота ГГ В ОДНОМ СООБЩЕНИИ ДО начала капта!**
    
    ⚠️ **Важно:** Если не прислать скрины до капта или они будут отклонены, ты получишь **-3 балла**!`,
    color: 0xFFA500,
    footer: { text: 'Скрины проверяются после капта' }
  };
  
  try {
    const user = await client.users.fetch(player.user_id);
    await user.send({ embeds: [embed] });
    
    if (!existing) {
      db.run('INSERT INTO player_screen_status (capt_id, user_id, notified, status) VALUES (?, ?, 1, "waiting")', [captId, player.user_id]);
    } else {
      db.run('UPDATE player_screen_status SET notified = 1 WHERE capt_id = ? AND user_id = ?', [captId, player.user_id]);
    }
    console.log(`📨 Запрос скринов отправлен ${player.username}`);
  } catch(e) {
    console.error(`❌ Не удалось отправить ЛС ${player.user_id}:`, e.message);
  }
}

async function handleScreenSubmission(message, client) {
  if (message.author.bot) return;
  if (message.channel.type !== 1) return;
  
  const now = new Date();
  const activeCapt = await new Promise((resolve) => {
    db.get(`
      SELECT ac.* FROM active_capts ac
      JOIN participants p ON p.capt_id = ac.id
      WHERE p.user_id = ? AND p.type = 'join' AND ac.start_time > ?
      ORDER BY ac.start_time ASC LIMIT 1
    `, [message.author.id, now.toISOString()], (err, row) => resolve(row));
  });
  
  if (!activeCapt) return;
  
  const status = await new Promise((resolve) => {
    db.get('SELECT * FROM player_screen_status WHERE capt_id = ? AND user_id = ?', [activeCapt.id, message.author.id], (err, row) => resolve(row));
  });
  
  if (!status || status.status !== 'waiting') return;
  
  const attachments = message.attachments;
  if (attachments.size === 0) {
    await message.reply('❌ Пожалуйста, отправь 2 скриншота ГГ в одном сообщении!');
    return;
  }
  
  if (attachments.size < 2) {
    await message.reply(`❌ Ты отправил только ${attachments.size} скриншот. Нужно отправить 2 скриншота в одном сообщении!`);
    return;
  }
  
  db.run('DELETE FROM game_screens WHERE capt_id = ? AND user_id = ?', [activeCapt.id, message.author.id]);
  
  let screenNumber = 1;
  for (const [id, attachment] of attachments) {
    if (screenNumber > 2) break;
    db.run(
      'INSERT INTO game_screens (capt_id, user_id, username, screen_url, screen_number, submitted_at) VALUES (?, ?, ?, ?, ?, ?)',
      [activeCapt.id, message.author.id, message.author.username, attachment.url, screenNumber, new Date().toISOString()]
    );
    screenNumber++;
  }
  
  db.run('UPDATE player_screen_status SET screens_count = 2, status = "submitted" WHERE capt_id = ? AND user_id = ?', [activeCapt.id, message.author.id]);
  
  await message.reply('✅ Спасибо! Оба скриншота получены. Они будут проверены после капта.');
  await sendToVerification(activeCapt.id, message.author.id, message.author.username, client);
}

async function sendToVerification(captId, userId, username, client) {
  const screens = await new Promise((resolve) => {
    db.all('SELECT * FROM game_screens WHERE capt_id = ? AND user_id = ? ORDER BY screen_number', [captId, userId], (err, rows) => resolve(rows || []));
  });
  
  const capt = await new Promise((resolve) => {
    db.get('SELECT * FROM active_capts WHERE id = ?', [captId], (err, row) => resolve(row));
  });
  
  const checkChannelId = process.env.SCREEN_CHECK_CHANNEL_ID;
  if (!checkChannelId) {
    console.error('❌ SCREEN_CHECK_CHANNEL_ID не указан в .env');
    return;
  }
  
  const checkChannel = await client.channels.fetch(checkChannelId);
  const checkerRoleId = process.env.SCREEN_CHECKER_ROLE_ID;
  
  const embed = new EmbedBuilder()
    .setTitle('📸 **СКРИНЫ ГГ**')
    .setDescription(`>>> **Игрок:** <@${userId}> (${username})
    **Капт #${captId}** | Противник: ${capt ? capt.enemy : 'Неизвестно'}`)
    .setColor(0xFFA500)
    .setTimestamp();
  
  for (let i = 0; i < screens.length; i++) {
    embed.addFields({ name: `📷 Скрин ${screens[i].screen_number}`, value: `[Ссылка](${screens[i].screen_url})`, inline: true });
  }
  
  if (screens[0]) embed.setImage(screens[0].screen_url);
  if (screens[1]) embed.setThumbnail(screens[1].screen_url);
  
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_screens_${captId}_${userId}`)
      .setLabel('✅ ОДОБРИТЬ')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reject_screens_${captId}_${userId}`)
      .setLabel('❌ ОТКЛОНИТЬ')
      .setStyle(ButtonStyle.Danger)
  );
  
  await checkChannel.send({
    content: checkerRoleId ? `<@&${checkerRoleId}>` : '',
    embeds: [embed],
    components: [row]
  });
}

async function approveScreens(interaction, client) {
  const [_, captId, userId] = interaction.customId.split('_');
  
  db.run('UPDATE game_screens SET status = "approved" WHERE capt_id = ? AND user_id = ?', [captId, userId]);
  db.run('UPDATE player_screen_status SET status = "approved" WHERE capt_id = ? AND user_id = ?', [captId, userId]);
  
  await interaction.reply({ content: `✅ Скрины игрока <@${userId}> одобрены!`, ephemeral: true });
  await interaction.message.delete();
  
  try {
    const user = await client.users.fetch(userId);
    await user.send(`✅ **Твои скрины ГГ одобрены!**\nТы успешно подтвердил участие в капте #${captId}.`);
  } catch(e) {}
  
  const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
  if (logChannel) {
    await logChannel.send(`✅ **${interaction.user.username}** одобрил скрины игрока <@${userId}> (капт #${captId})`);
  }
}

async function rejectScreens(interaction, client) {
  const [_, captId, userId] = interaction.customId.split('_');
  
  const status = await new Promise((resolve) => {
    db.get('SELECT * FROM player_screen_status WHERE capt_id = ? AND user_id = ?', [captId, userId], (err, row) => resolve(row));
  });
  
  if (status && status.penalty_applied === 1) {
    await interaction.reply({ content: `⚠️ Штраф уже был наложен на этого игрока.`, ephemeral: true });
    await interaction.message.delete();
    return;
  }
  
  db.run('UPDATE game_screens SET status = "rejected" WHERE capt_id = ? AND user_id = ?', [captId, userId]);
  
  const user = await getUserData(userId);
  const newPoints = Math.max(0, (user.points || 0) - 3);
  await updateUserPoints(userId, newPoints);
  
  db.run('UPDATE player_screen_status SET status = "rejected", penalty_applied = 1 WHERE capt_id = ? AND user_id = ?', [captId, userId]);
  
  try {
    const player = await client.users.fetch(userId);
    await player.send(`❌ **Твои скрины ГГ были отклонены!**\nС тебя снято **3 балла**.\n\nТекущий баланс: ${newPoints} баллов.`);
  } catch(e) {}
  
  await interaction.reply({ content: `❌ Скрины игрока <@${userId}> отклонены! Снято 3 балла.`, ephemeral: true });
  await interaction.message.delete();
  
  await checkTierAchievements(userId, client, newPoints);
  
  const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
  if (logChannel) {
    await logChannel.send(`❌ **${interaction.user.username}** отклонил скрины игрока <@${userId}> (капт #${captId}), снято 3 балла`);
  }
}

async function checkMissingScreens(captId, client) {
  const players = await new Promise((resolve) => {
    db.all('SELECT * FROM participants WHERE capt_id = ? AND type = "join"', [captId], (err, rows) => resolve(rows || []));
  });
  
  for (const player of players) {
    const status = await new Promise((resolve) => {
      db.get('SELECT * FROM player_screen_status WHERE capt_id = ? AND user_id = ?', [captId, player.user_id], (err, row) => resolve(row));
    });
    
    if (!status || (status.status === 'waiting' && status.penalty_applied !== 1)) {
      const user = await getUserData(player.user_id);
      const newPoints = Math.max(0, (user.points || 0) - 3);
      await updateUserPoints(player.user_id, newPoints);
      
      if (!status) {
        db.run('INSERT INTO player_screen_status (capt_id, user_id, status, penalty_applied, screens_count) VALUES (?, ?, "timeout", 1, 0)', [captId, player.user_id]);
      } else {
        db.run('UPDATE player_screen_status SET status = "timeout", penalty_applied = 1 WHERE capt_id = ? AND user_id = ?', [captId, player.user_id]);
      }
      
      try {
        const user = await client.users.fetch(player.user_id);
        await user.send(`⏰ **Ты не прислал скрины ГГ на капт #${captId}!**\nС тебя снято **3 балла**.\n\nТекущий баланс: ${newPoints} баллов.\n\nВ следующий раз не забывай отправлять скрины!`);
      } catch(e) {}
      
      const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
      if (logChannel) {
        await logChannel.send(`⏰ Игрок <@${player.user_id}> не прислал скрины на капт #${captId}, снято 3 балла`);
      }
      
      await checkTierAchievements(player.user_id, client, newPoints);
    }
  }
}

module.exports = {
  sendScreenRequest,
  handleScreenSubmission,
  approveScreens,
  rejectScreens,
  checkMissingScreens
};