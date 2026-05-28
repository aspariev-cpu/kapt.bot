const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

async function updateUserPendingTier(userId, pendingTier) {
  return new Promise((resolve) => {
    db.run('UPDATE users SET pending_tier = ?, call_notified = 1 WHERE user_id = ?', [pendingTier, userId], (err) => resolve());
  });
}

async function clearUserPendingTier(userId) {
  return new Promise((resolve) => {
    db.run('UPDATE users SET pending_tier = "none", call_notified = 0 WHERE user_id = ?', [userId], (err) => resolve());
  });
}

async function updateUserTier(userId, tier) {
  return new Promise((resolve) => {
    db.run('UPDATE users SET tier = ? WHERE user_id = ?', [tier, userId], (err) => resolve());
  });
}

function getTierName(tier) {
  const names = { 'tier1': 'Тир 1', 'tier2': 'Тир 2', 'tier3': 'Тир 3', 'none': 'Нет тира' };
  return names[tier] || 'Нет тира';
}

function getRoleIdByTier(tier) {
  const roles = {
    'tier1': process.env.TIER_1_ROLE_ID,
    'tier2': process.env.TIER_2_ROLE_ID,
    'tier3': process.env.TIER_3_ROLE_ID
  };
  return roles[tier];
}

async function handlePointsButton(interaction, client) {
  const userData = await getUserData(interaction.user.id);
  
  const embed = {
    title: '🏆 **ТВОЙ ПРОГРЕСС**',
    description: `>>> **Баллы:** \`${userData.points}\`
    **Текущий тир:** \`${getTierName(userData.tier)}\`
    
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    
    **🎯 ДО СЛЕДУЮЩЕГО ТИРА:**
    ${userData.points < 100 ? `До Тир 3: **${100 - userData.points}** баллов` : ''}
    ${userData.points >= 100 && userData.points < 400 ? `До Тир 2: **${400 - userData.points}** баллов` : ''}
    ${userData.points >= 400 && userData.points < 700 ? `До Тир 1: **${700 - userData.points}** баллов` : ''}
    ${userData.points >= 700 ? '✅ **МАКСИМАЛЬНЫЙ ТИР ДОСТИГНУТ!**' : ''}`,
    color: 0x5865F2,
    footer: { text: 'Баллы выдаются за активность на каптах' }
  };

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function handleCallRequest(interaction, client) {
  const [_, userId, pendingTier] = interaction.customId.split('_');
  
  if (interaction.user.id !== userId) {
    return interaction.reply({ content: '❌ Эта кнопка не для вас!', ephemeral: true });
  }
  
  const callChannelId = process.env.CALL_CHANNEL_ID;
  const watcherRoleId = process.env.CAPT_WATCHER_ROLE_ID;
  
  const embed = {
    title: '🔔 **НОВАЯ ЗАЯВКА НА ОБЗВОН**',
    description: `>>> **Игрок:** <@${userId}>
    **Желаемый тир:** \`${getTierName(pendingTier)}\`
    
    Нажми на кнопку ниже, чтобы отправить игроку голосовой канал для обзвона.`,
    color: 0xFFA500,
    footer: { text: 'Обзвон проводится смотрящим за каптами' }
  };
  
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sendChannel_${userId}_${pendingTier}`)
      .setLabel('📢 ОТПРАВИТЬ КАНАЛ')
      .setStyle(ButtonStyle.Primary)
  );
  
  const callChannel = await client.channels.fetch(callChannelId);
  await callChannel.send({
    content: `<@&${watcherRoleId}>`,
    embeds: [embed],
    components: [row]
  });
  
  await interaction.reply({ 
    content: `✅ Ваша заявка отправлена! Смотрящий свяжется с вами в ближайшее время.`, 
    ephemeral: true 
  });
}

async function handleSendChannel(interaction, client) {
  const [_, userId, pendingTier] = interaction.customId.split('_');
  
  // ID голосового канала для ОБЗВОНА (отдельный от проверки капта)
  const callVoiceChannelId = process.env.CALL_VOICE_CHANNEL_ID;
  
  // Получаем объект голосового канала для обзвона
  const voiceChannel = await client.channels.fetch(callVoiceChannelId);
  const voiceChannelMention = voiceChannel.toString();
  
  try {
    const user = await client.users.fetch(userId);
    
    const embed = {
      title: '🎙 **ОБЗВОН**',
      description: `>>> Для получения роли **${getTierName(pendingTier)}** пройдите обзвон в голосовом канале:\n\n🎤 ${voiceChannelMention}\n\nЗайдите в канал и дождитесь смотрящего.\n\nПосле прохождения обзвона смотрящий выдаст вам роль.`,
      color: 0x00FF00,
      footer: { text: 'Ждём вас!' }
    };
    
    await user.send({ embeds: [embed] });
    
    const watcherEmbed = {
      title: '🎤 **ВЫДАЧА ТИРА**',
      description: `>>> **Игрок:** <@${userId}>
      **Тир:** \`${getTierName(pendingTier)}\`
      
      После того как игрок прошёл обзвон, нажми на соответствующую кнопку.`,
      color: 0x5865F2
    };
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`tier_tier1_${userId}`)
        .setLabel('🏆 ТИР 1')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tier_tier2_${userId}`)
        .setLabel('🏆 ТИР 2')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tier_tier3_${userId}`)
        .setLabel('🏆 ТИР 3')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`tier_retry_${userId}`)
        .setLabel('🔄 ПЕРЕПРОЙТИ ОБЗВОН')
        .setStyle(ButtonStyle.Secondary)
    );
    
    await interaction.reply({
      content: `✅ Игроку <@${userId}> отправлен голосовой канал для обзвона!`,
      ephemeral: true
    });
    
    await interaction.user.send({
      embeds: [watcherEmbed],
      components: [row]
    });
    
  } catch(e) {
    console.error('❌ Ошибка отправки ЛС:', e);
    await interaction.reply({ 
      content: `❌ Не удалось отправить сообщение игроку. Возможно, у него закрыты ЛС.`, 
      ephemeral: true 
    });
  }
}

async function handleCallResponse(interaction, client) {
  const [_, action, userId] = interaction.customId.split('_');
  
  if (action === 'retry') {
    const userData = await getUserData(userId);
    const pendingTier = userData.pending_tier;
    
    if (pendingTier === 'none') {
      return interaction.reply({ content: '❌ У игрока нет ожидающего тира!', ephemeral: true });
    }
    
    const callVoiceChannelId = process.env.CALL_VOICE_CHANNEL_ID;
    const voiceChannel = await client.channels.fetch(callVoiceChannelId);
    const voiceChannelMention = voiceChannel.toString();
    
    try {
      const user = await client.users.fetch(userId);
      const embed = {
        title: '🎙 **ПОВТОРНЫЙ ОБЗВОН**',
        description: `>>> Для получения роли **${getTierName(pendingTier)}** пройдите обзвон в голосовом канале:\n\n🎤 ${voiceChannelMention}\n\nЗайдите в канал и дождитесь смотрящего.\n\nПосле прохождения обзвона смотрящий выдаст вам роль.`,
        color: 0xFFA500,
        footer: { text: 'Ждём вас!' }
      };
      
      await user.send({ embeds: [embed] });
      await interaction.reply({ content: `✅ Игроку отправлено повторное приглашение на обзвон.`, ephemeral: true });
    } catch(e) {
      await interaction.reply({ content: `❌ Не удалось отправить сообщение игроку.`, ephemeral: true });
    }
    return;
  }
  
  const tier = action;
  const roleId = getRoleIdByTier(tier);
  
  if (!roleId) {
    return interaction.reply({ content: `❌ Роль для тира ${tier} не найдена!`, ephemeral: true });
  }
  
  try {
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const member = await guild.members.fetch(userId);
    
    const tierRoles = [process.env.TIER_1_ROLE_ID, process.env.TIER_2_ROLE_ID, process.env.TIER_3_ROLE_ID];
    for (const roleId of tierRoles) {
      if (roleId && member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
      }
    }
    
    await member.roles.add(roleId);
    await updateUserTier(userId, tier);
    await clearUserPendingTier(userId);
    
    try {
      const user = await client.users.fetch(userId);
      await user.send(`✅ **Поздравляем!** Ты получил роль **${getTierName(tier)}**!\nТеперь ты можешь участвовать в каптах с этим тиром. 🎮`);
    } catch(e) {}
    
    await interaction.reply({ 
      content: `✅ Игроку <@${userId}> выдана роль **${getTierName(tier)}**!`, 
      ephemeral: true 
    });
    
    const logChannel = await client.channels.fetch(process.env.LOG_CHANNEL_ID);
    if (logChannel) {
      await logChannel.send(`🏆 **${interaction.user.username}** выдал роль **${getTierName(tier)}** игроку <@${userId}>`);
    }
    
  } catch(e) {
    console.error('❌ Ошибка выдачи роли:', e);
    await interaction.reply({ 
      content: `❌ Не удалось выдать роль. Убедитесь, что бот имеет права на управление ролями.`, 
      ephemeral: true 
    });
  }
}

module.exports = { 
  handlePointsButton,
  handleCallRequest,
  handleSendChannel,
  handleCallResponse,
  getUserData,
  updateUserTier,
  clearUserPendingTier
};