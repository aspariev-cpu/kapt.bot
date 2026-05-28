const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const db = require('../database');

// Кэш игроков (обновляется раз в 5 минут)
let playersCache = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 300000; // 5 минут

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

// ============= ПОЛУЧИТЬ ВСЕХ ИГРОКОВ С РОЛЬЮ CAPT =============
async function getAllCaptPlayers(guild) {
  const now = Date.now();
  
  // Если кэш свежий, используем его
  if (playersCache.length > 0 && (now - lastCacheUpdate) < CACHE_TTL) {
    console.log(`📦 Используем кэш: ${playersCache.length} игроков`);
    return playersCache;
  }
  
  const playerRoleId = process.env.CAPT_PLAYER_ROLE_ID;
  
  if (!playerRoleId) {
    console.error('❌ CAPT_PLAYER_ROLE_ID не указан в .env');
    return [];
  }
  
  try {
    console.log('🔄 Загружаем всех участников сервера...');
    
    // Загружаем ВСЕХ участников сервера
    const members = await guild.members.fetch({ 
      limit: 1000,
      withPresences: false 
    });
    
    console.log(`📊 Всего участников на сервере: ${members.size}`);
    
    const players = [];
    
    for (const [id, member] of members) {
      if (member.roles.cache.has(playerRoleId)) {
        console.log(`✅ Найден игрок с ролью CAPT: ${member.user.username} (${id})`);
        const userData = await getUserData(id);
        players.push({
          user_id: id,
          username: member.user.username,
          globalName: member.user.globalName || member.user.username,
          points: userData.points
        });
      }
    }
    
    console.log(`📊 Игроков с ролью CAPT: ${players.length}`);
    
    // Сортируем по имени
    players.sort((a, b) => a.username.localeCompare(b.username));
    
    // Обновляем кэш
    playersCache = players;
    lastCacheUpdate = now;
    
    return players;
    
  } catch (error) {
    console.error('❌ Ошибка получения игроков с ролью:', error);
    if (playersCache.length > 0) return playersCache;
    return [];
  }
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

// ============= ОСНОВНАЯ ФУНКЦИЯ ВЫДАЧИ БАЛЛОВ =============
async function showGivePointsModal(interaction) {
  // Принудительный сброс кэша при каждом открытии (можно убрать после отладки)
  playersCache = [];
  lastCacheUpdate = 0;
  
  const guild = interaction.guild;
  const players = await getAllCaptPlayers(guild);
  
  if (players.length === 0) {
    return interaction.reply({ 
      content: '❌ Нет игроков с ролью CAPT! Убедитесь, что:\n1. Роль существует на сервере\n2. ID роли правильно указан в .env\n3. У игроков есть эта роль\n\n🔧 Твой CAPT_PLAYER_ROLE_ID: `' + process.env.CAPT_PLAYER_ROLE_ID + '`', 
      ephemeral: true 
    });
  }
  
  // Сохраняем игроков во временное хранилище
  if (!global.pendingGivePoints) global.pendingGivePoints = {};
  global.pendingGivePoints[interaction.user.id] = {
    players: players,
    timestamp: Date.now()
  };
  
  // Показываем список игроков с тегами и нумерацией
  const playersList = players.map((p, idx) => {
    let medal = '';
    if (p.points >= 700) medal = '🏆';
    else if (p.points >= 400) medal = '🥈';
    else if (p.points >= 100) medal = '🥉';
    else medal = '⭐';
    return `${idx + 1}. <@${p.user_id}> — **${p.points}** баллов ${medal}`;
  }).join('\n');
  
  // Создаём select menu с номерами вместо ников
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('selectPlayerForPoints')
    .setPlaceholder('🔢 Выберите номер игрока из списка')
    .setMinValues(1)
    .setMaxValues(1);
  
  for (let i = 0; i < Math.min(players.length, 25); i++) {
    const player = players[i];
    let medal = '';
    if (player.points >= 700) medal = '🏆';
    else if (player.points >= 400) medal = '🥈';
    else if (player.points >= 100) medal = '🥉';
    else medal = '⭐';
    
    selectMenu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(`#${i + 1} — ${player.globalName || player.username}`)
        .setDescription(`${player.points} баллов ${medal}`)
        .setValue(player.user_id)
    );
  }
  
  const embed = {
    title: '📋 **ВЫДАЧА БАЛЛОВ**',
    description: `>>> Всего игроков: **${players.length}**
    
    **📜 Список игроков с тегами:**
    ${playersList}
    
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    
    *Выбери **номер игрока** из меню ниже, чтобы выдать баллы.*`,
    color: 0x5865F2,
    footer: { text: 'Выдача баллов за активность на каптах' }
  };
  
  const row = new ActionRowBuilder().addComponents(selectMenu);
  
  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
  
  // Ждём выбора игрока
  const filter = (i) => i.customId === 'selectPlayerForPoints' && i.user.id === interaction.user.id;
  const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000, max: 1 });
  
  collector.on('collect', async (selectInteraction) => {
    const selectedUserId = selectInteraction.values[0];
    
    const modal = new ModalBuilder()
      .setCustomId(`givePointsModal_${selectedUserId}`)
      .setTitle('Выдача баллов');
    
    const pointsInput = new TextInputBuilder()
      .setCustomId('pointsAmount')
      .setLabel('Сумма баллов (5, 10, 15, 20, 25)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('5, 10, 15, 20 или 25')
      .setRequired(true);
    
    modal.addComponents(new ActionRowBuilder().addComponents(pointsInput));
    
    await selectInteraction.showModal(modal);
  });
  
  collector.on('end', async (collected) => {
    if (collected.size === 0 && global.pendingGivePoints[interaction.user.id]) {
      await interaction.editReply({ 
        content: '❌ Время вышло. Нажмите кнопку "ВЫДАТЬ БАЛЛЫ" заново.', 
        components: [] 
      });
      delete global.pendingGivePoints[interaction.user.id];
    }
  });
}

async function handleGivePoints(interaction, client) {
  const userId = interaction.customId.split('_')[1];
  const pointsAmount = parseInt(interaction.fields.getTextInputValue('pointsAmount'));
  
  const validAmounts = [5, 10, 15, 20, 25];
  if (!validAmounts.includes(pointsAmount)) {
    return interaction.reply({ 
      content: '❌ Неверная сумма! Доступные значения: 5, 10, 15, 20, 25', 
      ephemeral: true 
    });
  }
  
  const user = await getUserData(userId);
  const newPoints = (user.points || 0) + pointsAmount;
  
  await updateUserPoints(userId, newPoints);
  
  let userName = user.username;
  try {
    const discordUser = await client.users.fetch(userId);
    userName = discordUser.globalName || discordUser.username;
  } catch(e) {}
  
  await interaction.reply({ 
    content: `✅ Игроку **${userName}** (<@${userId}>) выдано **${pointsAmount}** баллов!\n📊 Теперь у него **${newPoints}** баллов.`, 
    ephemeral: true 
  });
  
  const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
  if (logChannel) {
    await logChannel.send(`💰 **${interaction.user.username}** выдал **${pointsAmount}** баллов игроку **${userName}** (<@${userId}>) (теперь ${newPoints} баллов)`);
  }
  
  await checkTierAchievements(userId, client, newPoints);
}

module.exports = { 
  showGivePointsModal,
  handleGivePoints
};