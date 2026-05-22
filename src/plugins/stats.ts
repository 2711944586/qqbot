import { Plugin } from '../types';

// ============ 消息统计 ============
interface GroupStats {
  totalMessages: number;
  userMessages: Map<number, { count: number; nickname: string }>;
  hourly: number[];
  lastReset: number;
  lastActive: number;
}

class StatsManager {
  private stats: Map<number, GroupStats> = new Map();
  private readonly maxGroups = 200;
  private readonly maxUsersPerGroup = 1000;
  private readonly keepUsersPerGroup = 800;

  private getGroupStats(groupId: number): GroupStats {
    if (!this.stats.has(groupId)) {
      this.pruneGroupsIfNeeded();
      this.stats.set(groupId, {
        totalMessages: 0,
        userMessages: new Map(),
        hourly: new Array(24).fill(0),
        lastReset: Date.now(),
        lastActive: Date.now(),
      });
    }
    return this.stats.get(groupId)!;
  }

  record(groupId: number, userId: number, nickname: string): void {
    const stats = this.getGroupStats(groupId);
    stats.totalMessages++;
    stats.lastActive = Date.now();

    const user = stats.userMessages.get(userId) || { count: 0, nickname };
    user.count++;
    user.nickname = nickname;
    stats.userMessages.set(userId, user);
    this.pruneUsersIfNeeded(stats);

    const hour = new Date().getHours();
    stats.hourly[hour]++;
  }

  getSummary(groupId: number): string {
    const stats = this.stats.get(groupId);
    if (!stats || stats.totalMessages === 0) {
      return '📊 暂无统计数据';
    }

    const uptime = Math.floor((Date.now() - stats.lastReset) / 1000 / 3600);

    // 活跃用户 Top 5
    const topUsers = [...stats.userMessages.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map((entry, i) => `  ${i + 1}. ${entry[1].nickname}: ${entry[1].count}条`)
      .join('\n');

    // 活跃时段
    const peakHour = stats.hourly.indexOf(Math.max(...stats.hourly));

    const lines = [
      '📊 群聊统计',
      '',
      `📝 总消息: ${stats.totalMessages} 条`,
      `⏱ 统计时长: ${uptime} 小时`,
      `👥 活跃人数: ${stats.userMessages.size} 人`,
      `🕐 最活跃时段: ${peakHour}:00-${peakHour + 1}:00`,
      '',
      '🏆 话痨排行:',
      topUsers,
    ];

    return lines.join('\n');
  }

  reset(groupId: number): void {
    this.stats.delete(groupId);
  }

  private pruneGroupsIfNeeded(): void {
    if (this.stats.size < this.maxGroups) return;
    const sorted = [...this.stats.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
    const removeCount = Math.max(1, this.stats.size - this.maxGroups + 1);
    for (const [groupId] of sorted.slice(0, removeCount)) {
      this.stats.delete(groupId);
    }
  }

  private pruneUsersIfNeeded(stats: GroupStats): void {
    if (stats.userMessages.size <= this.maxUsersPerGroup) return;
    const sorted = [...stats.userMessages.entries()].sort((a, b) => b[1].count - a[1].count);
    stats.userMessages = new Map(sorted.slice(0, this.keepUsersPerGroup));
  }
}

const statsManager = new StatsManager();

export const statsPlugin: Plugin = {
  name: 'stats',
  description: '群消息统计 - 活跃度、话痨排行等',

  handler: (ctx) => {
    // 记录每条消息（无论是否命令）
    const nickname = ctx.event.sender.card || ctx.event.sender.nickname;
    statsManager.record(ctx.event.group_id, ctx.event.user_id, nickname);

    // 只处理命令
    if (ctx.command === 'stats' || ctx.command === 'stat') {
      ctx.reply(statsManager.getSummary(ctx.event.group_id));
      return true;
    }

    if (ctx.command === 'resetstats') {
      const config = ctx.bot.getConfig();
      if (!config.admin_qq.includes(ctx.event.user_id)) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      statsManager.reset(ctx.event.group_id);
      ctx.reply('✅ 统计数据已重置');
      return true;
    }

    return false;
  },
};
