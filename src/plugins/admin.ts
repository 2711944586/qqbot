import * as fs from 'fs';
import * as path from 'path';
import { Plugin, BotConfig } from '../types';

export const adminPlugin: Plugin = {
  name: 'admin',
  description: '管理员命令 - 群管理、配置重载等',

  handler: (ctx) => {
    const config = ctx.bot.getConfig();
    const isAdmin = config.admin_qq.includes(ctx.event.user_id);

    // ===== 重载配置 =====
    if (ctx.command === 'reload') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足，仅管理员可用');
        return true;
      }

      try {
        const configPath = path.resolve(__dirname, '..', '..', 'config.json');
        const raw = fs.readFileSync(configPath, 'utf-8');
        const newConfig = JSON.parse(raw) as BotConfig;
        ctx.bot.updateConfig(newConfig);
        ctx.reply('✅ 配置已重载');
      } catch (err) {
        ctx.reply(`❌ 重载失败: ${err instanceof Error ? err.message : err}`);
      }
      return true;
    }

    // ===== 群白名单管理 =====
    if (ctx.command === 'addgroup') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const groupId = parseInt(ctx.args[0]) || ctx.event.group_id;
      if (!config.enabled_groups.includes(groupId)) {
        config.enabled_groups.push(groupId);
        ctx.reply(`✅ 已将群 ${groupId} 加入白名单`);
      } else {
        ctx.reply(`ℹ️ 群 ${groupId} 已在白名单中`);
      }
      return true;
    }

    if (ctx.command === 'rmgroup') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const groupId = parseInt(ctx.args[0]);
      if (!groupId) {
        ctx.reply('用法: /rmgroup <群号>');
        return true;
      }
      const idx = config.enabled_groups.indexOf(groupId);
      if (idx >= 0) {
        config.enabled_groups.splice(idx, 1);
        ctx.reply(`✅ 已将群 ${groupId} 移出白名单`);
      } else {
        ctx.reply(`ℹ️ 群 ${groupId} 不在白名单中`);
      }
      return true;
    }

    // ===== 禁言/解禁（需要管理员权限） =====
    if (ctx.command === 'ban') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const atSeg = ctx.event.message.find((s) => s.type === 'at');
      if (!atSeg || atSeg.type !== 'at') {
        ctx.reply('用法: /ban @某人 [时长(分钟)]');
        return true;
      }
      const targetQQ = parseInt(atSeg.data.qq);
      const duration = (parseInt(ctx.args.find((a) => /^\d+$/.test(a)) || '') || 10) * 60;

      ctx.bot.callApi('set_group_ban', {
        group_id: ctx.event.group_id,
        user_id: targetQQ,
        duration,
      });
      ctx.reply(`✅ 已禁言 ${duration / 60} 分钟`);
      return true;
    }

    if (ctx.command === 'unban') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const atSeg = ctx.event.message.find((s) => s.type === 'at');
      if (!atSeg || atSeg.type !== 'at') {
        ctx.reply('用法: /unban @某人');
        return true;
      }
      const targetQQ = parseInt(atSeg.data.qq);
      ctx.bot.callApi('set_group_ban', {
        group_id: ctx.event.group_id,
        user_id: targetQQ,
        duration: 0,
      });
      ctx.reply('✅ 已解除禁言');
      return true;
    }

    // ===== 踢人 =====
    if (ctx.command === 'kick') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const atSeg = ctx.event.message.find((s) => s.type === 'at');
      if (!atSeg || atSeg.type !== 'at') {
        ctx.reply('用法: /kick @某人');
        return true;
      }
      const targetQQ = parseInt(atSeg.data.qq);
      ctx.bot.callApi('set_group_kick', {
        group_id: ctx.event.group_id,
        user_id: targetQQ,
        reject_add_request: false,
      });
      ctx.reply('✅ 已移出群聊');
      return true;
    }

    // ===== 设置群头衔 =====
    if (ctx.command === 'title') {
      if (!isAdmin) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      const atSeg = ctx.event.message.find((s) => s.type === 'at');
      if (!atSeg || atSeg.type !== 'at') {
        ctx.reply('用法: /title @某人 <头衔>');
        return true;
      }
      const targetQQ = parseInt(atSeg.data.qq);
      const title = ctx.args.filter((a) => !/^@/.test(a)).join(' ');
      ctx.bot.callApi('set_group_special_title', {
        group_id: ctx.event.group_id,
        user_id: targetQQ,
        special_title: title,
        duration: -1,
      });
      ctx.reply(`✅ 已设置头衔: ${title || '(清除)'}`);
      return true;
    }

    return false;
  },
};
