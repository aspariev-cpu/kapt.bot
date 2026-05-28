const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database');

function getParticipantsByType(captId, type) {
  return new Promise((resolve) => {
    db.all('SELECT * FROM participants WHERE capt_id = ? AND type = ?', [captId, type], (err, rows) => {
      if (err) {
        console.error('❌ Ошибка getParticipantsByType:', err);
        resolve([]);
      }
      resolve(rows || []);
    });
  });
}

async function getActiveCapt(captId) {
  return new Promise((resolve) => {
    db.get('SELECT * FROM active_capts WHERE id = ?', [captId], (err, row) => {
      if (err) {
        console.error('❌ Ошибка getActiveCapt:', err);
        resolve(null);
      } else {
        resolve(row);
      }
    });
  });
}

async function getUserTier(userId) {
  return new Promise((resolve) => {
    db.get('SELECT tier, points FROM users WHERE user_id = ?', [userId], (err, row) => {
      if (err || !row) resolve({ tier: 'none', points: 0 });
      else resolve({ tier: row.tier, points: row.points });
    });
  });
}

async function handleCaptCommand(message, client) {
  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('openCaptModal_permanent').setLabel('📝 СОЗДАТЬ СБОР').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('showMyPoints').setLabel('🏆 МОИ БАЛЛЫ').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('showGivePoints').setLabel('📋 ВЫДАТЬ БАЛЛЫ').setStyle(ButtonStyle.Danger)
    );

    await message.channel.send({
      content: '🎮 **Панель управления каптами**\nВыбери нужное действие:',
      components: [row]
    });

    await message.reply({ content: '✅ Панель управления добавлена в канал!', ephemeral: true });
  } catch (error) {
    console.error('❌ Ошибка handleCaptCommand:', error);
  }
}

async function showCaptModal(interaction) {
  const modal = new ModalBuilder().setCustomId('captModal').setTitle('Создание сбора GTA');

  const timeInput = new TextInputBuilder()
    .setCustomId('captTime')
    .setLabel('Время капта (пример: 18.05.2026 20:30)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('18.05.2026 20:30')
    .setRequired(true);

  const enemyInput = new TextInputBuilder()
    .setCustomId('captEnemy')
    .setLabel('Противник')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Название клана/команды')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(timeInput),
    new ActionRowBuilder().addComponents(enemyInput)
  );

  await interaction.showModal(modal);
}

async function handleCaptModal(interaction, client) {
  try {
    const startTimeRaw = interaction.fields.getTextInputValue('captTime');
    const enemy = interaction.fields.getTextInputValue('captEnemy');

    const parts = startTimeRaw.split(' ');
    const dateParts = parts[0].split('.');
    const timeParts = parts[1].split(':');
    
    const parsedDate = new Date(dateParts[2], dateParts[1] - 1, dateParts[0], timeParts[0], timeParts[1]);

    if (isNaN(parsedDate.getTime())) {
      return interaction.reply({ content: '❌ Неверный формат! Используйте: ДД.ММ.ГГГГ ЧЧ:ММ\nПример: 18.05.2026 20:30', ephemeral: true });
    }

    if (parsedDate < new Date()) {
      return interaction.reply({ content: '❌ Время должно быть в будущем!', ephemeral: true });
    }

    const isoStartTime = parsedDate.toISOString();

    const result = await new Promise((resolve) => {
      db.run(
        'INSERT INTO active_capts (channel_id, message_id, start_time, enemy, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [interaction.channelId, 'temp', isoStartTime, enemy, interaction.user.id, new Date().toISOString()],
        function(err) {
          if (err) { console.error(err); resolve(null); }
          else resolve(this.lastID);
        }
      );
    });

    if (!result) return interaction.reply({ content: '❌ Ошибка при создании сбора', ephemeral: true });

    const timestamp = Math.floor(parsedDate.getTime() / 1000);
    const maxPlayers = parseInt(process.env.MAX_PLAYERS) || 35;
    const maxSubs = parseInt(process.env.MAX_SUBS) || 10;

    const embed = {
      title: '🎮 **СБОР НА GTA V** 🎮',
      description: `>>> **👥 Противник:** \`${enemy}\`
      **⏰ Время капта:** <t:${timestamp}:F> (<t:${timestamp}:R>)
      
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      
      **✅ ОСНОВНОЙ СОСТАВ (0/${maxPlayers})**
      *«Никто не записан»*
      
      **🔄 ЗАМЕНА (0/${maxSubs})**
      *«Никто не записан»*
      
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      
      *Нажми на кнопку ниже, чтобы записаться!*`,
      color: 0x5865F2,
      footer: { text: `📋 Создал: ${interaction.user.username} | ID: ${result}`, icon_url: interaction.user.displayAvatarURL() },
      timestamp: new Date().toISOString()
    };

    const buttonRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`join_${result}`).setLabel('🎮 ИГРАТЬ').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`sub_${result}`).setLabel('🔄 ЗАМЕНА').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`leave_${result}`).setLabel('❌ НЕ ИГРАЮ').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`close_${result}`).setLabel('❌ ЗАКРЫТЬ КАПТ').setStyle(ButtonStyle.Danger)
    );

    const sentMessage = await interaction.channel.send({ 
      content: '@everyone **🔴 НОВЫЙ КАПТ 🔴**',
      embeds: [embed], 
      components: [buttonRow] 
    });

    db.run('UPDATE active_capts SET message_id = ? WHERE id = ?', [sentMessage.id, result]);
    console.log(`✅ Сбор ${result} создан, message_id: ${sentMessage.id}`);
    
    // ========= ОТПРАВКА В КАНАЛ TEGS (ОБНОВЛЁННЫЙ ТЕКСТ) =========
    const tegsChannelId = process.env.TEGS_CHANNEL_ID;
    if (tegsChannelId) {
      const tegsChannel = await client.channels.fetch(tegsChannelId);
      const captLink = `https://discord.com/channels/${process.env.GUILD_ID}/${interaction.channelId}/${sentMessage.id}`;
      
      await tegsChannel.send(
        `## @everyone Хочешь играть этот капт? Нажми "ИГРАТЬ" тут: ${captLink}\n\n📸 **Не забудь сделать 2 скрина с ГГ и отправить боту в личные сообщения!**\n⚠️ Иначе снимется **-3 балла**!`
      );
    }
    
    await interaction.reply({ content: '✅ Сбор создан!', ephemeral: true });

  } catch (error) {
    console.error('Ошибка handleCaptModal:', error);
    await interaction.reply({ content: '❌ Ошибка при создании сбора', ephemeral: true }).catch(() => {});
  }
}

async function showRegistrationModal(interaction, captId, type) {
  const modal = new ModalBuilder()
    .setCustomId(`register_${captId}_${type}`)
    .setTitle('Регистрация на капт');

  const nameInput = new TextInputBuilder()
    .setCustomId('playerName')
    .setLabel('Имя Фамилия')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Иван Иванов')
    .setRequired(true);

  const staticInput = new TextInputBuilder()
    .setCustomId('staticInfo')
    .setLabel('Статик')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Ваш статик')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(staticInput)
  );

  await interaction.showModal(modal);
}

async function handleRegistrationSubmit(interaction, client) {
  const [_, captId, type] = interaction.customId.split('_');
  const playerName = interaction.fields.getTextInputValue('playerName');
  const staticInfo = interaction.fields.getTextInputValue('staticInfo');

  console.log(`📝 Регистрация: captId=${captId}, userId=${interaction.user.id}, type=${type}`);

  const existing = await new Promise((resolve) => {
    db.get('SELECT * FROM participants WHERE capt_id = ? AND user_id = ?', [captId, interaction.user.id], (err, row) => resolve(row));
  });

  if (existing) {
    return interaction.reply({ content: '❌ Вы уже записаны на этот сбор!', ephemeral: true });
  }

  const players = await getParticipantsByType(captId, 'join');
  const subs = await getParticipantsByType(captId, 'sub');
  const maxPlayers = parseInt(process.env.MAX_PLAYERS) || 35;
  const maxSubs = parseInt(process.env.MAX_SUBS) || 10;

  if (type === 'join' && players.length >= maxPlayers) {
    return interaction.reply({ content: `❌ Основной состав уже заполнен (${maxPlayers}/${maxPlayers})!`, ephemeral: true });
  }
  if (type === 'sub' && subs.length >= maxSubs) {
    return interaction.reply({ content: `❌ Замена уже заполнена (${maxSubs}/${maxSubs})!`, ephemeral: true });
  }

  await new Promise((resolve) => {
    db.run(
      'INSERT INTO participants (capt_id, user_id, username, player_name, static_info, type, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [captId, interaction.user.id, interaction.user.username, playerName, staticInfo, type, new Date().toISOString()],
      (err) => {
        if (err) console.error('❌ Ошибка INSERT:', err);
        else console.log(`✅ INSERT выполнен для ${interaction.user.username}`);
        resolve();
      }
    );
  });

  const capt = await getActiveCapt(captId);
  
  if (capt && capt.message_id && capt.message_id !== 'temp') {
    console.log(`🔄 Обновляем сообщение сбора ${captId}`);
    await updateCaptMessage(capt, client);
    
    if (type === 'join') {
      const timeToStart = new Date(capt.start_time) - new Date();
      const minutesLeft = Math.floor(timeToStart / 60000);
      const { sendScreenRequest } = require('./screens');
      await sendScreenRequest(captId, {
        user_id: interaction.user.id,
        username: interaction.user.username
      }, capt.enemy, minutesLeft, client);
    }
  } else {
    console.error(`❌ Сбор ${captId} не найден или message_id = temp`);
  }

  await interaction.reply({ 
    content: `✅ Вы записаны в ${type === 'join' ? 'основной состав' : 'замену'}!`, 
    ephemeral: true 
  });
}

async function handleLeave(interaction, client) {
  const captId = interaction.customId.split('_')[1];
  
  const participant = await new Promise((resolve) => {
    db.get('SELECT * FROM participants WHERE capt_id = ? AND user_id = ?', [captId, interaction.user.id], (err, row) => resolve(row));
  });

  if (!participant) {
    return interaction.reply({ content: '❌ Вы не записаны на этот сбор!', ephemeral: true });
  }

  db.run('DELETE FROM participants WHERE id = ?', [participant.id]);
  
  const capt = await getActiveCapt(captId);
  if (capt && capt.message_id && capt.message_id !== 'temp') {
    await updateCaptMessage(capt, client);
  }

  await interaction.reply({ content: '✅ Вы отписались от сбора!', ephemeral: true });
}

async function updateCaptMessage(capt, client) {
  try {
    console.log(`🔄 ОБНОВЛЕНИЕ сообщения для сбора ${capt.id}...`);
    
    if (!capt.message_id || capt.message_id === 'temp') {
      console.error(`❌ message_id = temp, пропускаем обновление`);
      return;
    }
    
    const channel = await client.channels.fetch(capt.channel_id);
    if (!channel) {
      console.error(`❌ Канал ${capt.channel_id} не найден`);
      return;
    }
    
    const message = await channel.messages.fetch(capt.message_id).catch(err => {
      if (err.code === 10008) {
        console.log(`🗑️ Сообщение ${capt.message_id} не найдено, удаляем сбор ${capt.id} из БД`);
        db.run('DELETE FROM active_capts WHERE id = ?', [capt.id]);
        db.run('DELETE FROM participants WHERE capt_id = ?', [capt.id]);
      } else {
        console.error(`❌ Ошибка получения сообщения:`, err.message);
      }
      return null;
    });
    
    if (!message) return;
    
    const players = await new Promise((resolve) => {
      db.all('SELECT * FROM participants WHERE capt_id = ? AND type = "join"', [capt.id], (err, rows) => {
        if (err) {
          console.error('❌ Ошибка загрузки игроков:', err);
          resolve([]);
        } else {
          console.log(`📊 Загружено игроков (join): ${rows.length}`);
          resolve(rows || []);
        }
      });
    });
    
    const subs = await new Promise((resolve) => {
      db.all('SELECT * FROM participants WHERE capt_id = ? AND type = "sub"', [capt.id], (err, rows) => {
        console.log(`📊 Загружено замен (sub): ${rows?.length || 0}`);
        resolve(rows || []);
      });
    });
    
    console.log(`📊 Основной состав (${players.length}/35): ${players.map(p => p.player_name).join(', ') || 'пусто'}`);
    console.log(`📊 Замена (${subs.length}/10): ${subs.map(s => s.player_name).join(', ') || 'пусто'}`);
    
    const playersWithTier = [];
    for (const p of players) {
      const userData = await getUserTier(p.user_id);
      playersWithTier.push({ ...p, tier: userData.tier });
    }
    
    const tierOrder = { 'tier1': 1, 'tier2': 2, 'tier3': 3, 'none': 4 };
    playersWithTier.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
    
    const maxPlayers = parseInt(process.env.MAX_PLAYERS) || 35;
    const maxSubs = parseInt(process.env.MAX_SUBS) || 10;
    
    const playersList = playersWithTier.length > 0 
      ? playersWithTier.map(p => {
          let tierIcon = '';
          if (p.tier === 'tier1') tierIcon = '🏆 Тир 1';
          else if (p.tier === 'tier2') tierIcon = '🏆 Тир 2';
          else if (p.tier === 'tier3') tierIcon = '🏆 Тир 3';
          else tierIcon = '⭐ Новичок';
          return `**${p.player_name}** \`${p.static_info}\` <@${p.user_id}> | ${tierIcon}`;
        }).join('\n')
      : '*Нет участников*';
    
    const subsList = subs.length > 0
      ? subs.map(s => `**${s.player_name}** \`${s.static_info}\` <@${s.user_id}>`).join('\n')
      : '*Нет участников*';
    
    let color;
    if (players.length === maxPlayers) color = 0x00FF00;
    else if (players.length >= maxPlayers - 5) color = 0xFFA500;
    else color = 0x5865F2;
    
    const timestamp = Math.floor(new Date(capt.start_time).getTime() / 1000);
    
    const embed = {
      title: '🎮 **СБОР НА GTA V** 🎮',
      description: `>>> **👥 Противник:** \`${capt.enemy}\`
      **⏰ Время капта:** <t:${timestamp}:F> (<t:${timestamp}:R>)
      
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      
      **✅ ОСНОВНОЙ СОСТАВ (${players.length}/${maxPlayers})**
      ${playersList}
      
      **🔄 ЗАМЕНА (${subs.length}/${maxSubs})**
      ${subsList}
      
      ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
      color: color,
      footer: { 
        text: `📋 Создал: ${capt.created_by ? `<@${capt.created_by}>` : 'Неизвестно'}`,
        icon_url: client.user.displayAvatarURL()
      },
      timestamp: new Date().toISOString()
    };
    
    const row = {
      type: 1,
      components: [
        { type: 2, label: '🎮 ИГРАТЬ', style: 3, custom_id: `join_${capt.id}` },
        { type: 2, label: '🔄 ЗАМЕНА', style: 2, custom_id: `sub_${capt.id}` },
        { type: 2, label: '❌ НЕ ИГРАЮ', style: 4, custom_id: `leave_${capt.id}` },
        { type: 2, label: '❌ ЗАКРЫТЬ КАПТ', style: 4, custom_id: `close_${capt.id}` }
      ]
    };
    
    await message.edit({ embeds: [embed], components: [row] });
    console.log(`✅ Сообщение сбора ${capt.id} УСПЕШНО ОТРЕДАКТИРОВАНО!`);
  } catch (error) {
    console.error('❌ Ошибка обновления сообщения:', error);
  }
}

async function handleCaptButton(interaction, client) {
  const customId = interaction.customId;
  
  if (customId.startsWith('join_') || customId.startsWith('sub_')) {
    const [action, captId] = customId.split('_');
    await showRegistrationModal(interaction, captId, action);
  } else if (customId.startsWith('leave_')) {
    await handleLeave(interaction, client);
  }
}

module.exports = { 
  handleCaptCommand, 
  showCaptModal, 
  handleCaptModal,
  handleCaptButton,
  handleRegistrationSubmit,
  updateCaptMessage,
  getActiveCapt
};