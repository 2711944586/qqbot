import { Plugin } from '../types';
import { detectFuzzyCommand } from './fuzzy-command';

// ============ 消息统计 ============
interface UserDetail {
  count: number;
  nickname: string;
  /** 每天的消息数 (key: YYYY-MM-DD) */
  daily: Map<string, number>;
  /** 每小时的消息数(0-23) */
  hourly: number[];
  firstSeen: number;
  lastActive: number;
}

interface GroupStats {
  totalMessages: number;
  userMessages: Map<number, UserDetail>;
  hourly: number[];
  lastReset: number;
  lastActive: number;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function calcStreak(daily: Map<string, number>): number {
  // 从今天往回数，连续有消息的天数
  const d = new Date();
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (daily.has(key) && (daily.get(key) || 0) > 0) {
      streak++;
    } else if (i > 0) {
      break; // 今天可以没消息（午夜情况），但中间断了就停
    }
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

class StatsManager {
  private stats: Map<number, GroupStats> = new Map();
  private readonly maxGroups = 200;
  private readonly maxUsersPerGroup = 1000;
  private readonly keepUsersPerGroup = 800;
  private readonly maxDailyEntriesPerUser = 60;

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

    let user = stats.userMessages.get(userId);
    if (!user) {
      user = {
        count: 0,
        nickname,
        daily: new Map(),
        hourly: new Array(24).fill(0),
        firstSeen: Date.now(),
        lastActive: Date.now(),
      };
    }
    user.count++;
    user.nickname = nickname;
    user.lastActive = Date.now();

    const day = todayKey();
    user.daily.set(day, (user.daily.get(day) || 0) + 1);
    if (user.daily.size > this.maxDailyEntriesPerUser) {
      // 删掉最旧的
      const sorted = [...user.daily.keys()].sort();
      for (const k of sorted.slice(0, user.daily.size - this.maxDailyEntriesPerUser)) {
        user.daily.delete(k);
      }
    }

    const hour = new Date().getHours();
    user.hourly[hour]++;
    stats.hourly[hour]++;

    stats.userMessages.set(userId, user);
    this.pruneUsersIfNeeded(stats);
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

  /** 单用户活跃度查询 */
  getUserStats(groupId: number, userId: number): string | null {
    const stats = this.stats.get(groupId);
    if (!stats) return null;
    const user = stats.userMessages.get(userId);
    if (!user) return null;

    // 排名
    const sorted = [...stats.userMessages.entries()].sort((a, b) => b[1].count - a[1].count);
    const rank = sorted.findIndex(([id]) => id === userId) + 1;
    const total = stats.userMessages.size;
    const peakHour = user.hourly.indexOf(Math.max(...user.hourly));
    const streak = calcStreak(user.daily);
    const today = user.daily.get(todayKey()) || 0;
    const days = user.daily.size;
    const avgPerDay = days > 0 ? Math.round(user.count / days) : 0;

    // 排名段位
    let badge = '🆕';
    const pct = (rank / total) * 100;
    if (rank === 1) badge = '👑';
    else if (pct <= 5) badge = '🔥';
    else if (pct <= 20) badge = '⭐';
    else if (pct <= 50) badge = '💬';
    else badge = '🐢';

    return [
      `${badge} 你在本群的活跃度`,
      '',
      `📝 总发言: ${user.count} 条`,
      `🏆 排名: ${rank}/${total}`,
      `📅 今日: ${today} 条`,
      `🔥 连续活跃: ${streak} 天`,
      `📊 日均: ${avgPerDay} 条`,
      `🕐 最活跃时段: ${peakHour}:00-${peakHour + 1}:00`,
    ].join('\n');
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
    if (!ctx.groupId) return false;
    // 记录每条消息（无论是否命令）
    const nickname = ctx.event.sender.card || ctx.event.sender.nickname;
    statsManager.record(ctx.groupId, ctx.event.user_id, nickname);

    // 中文模糊命令分发（仅当不是显式 /xxx 命令时）
    const fuzzy = ctx.command ? null : detectFuzzyCommand(ctx.rawText.trim());

    // 只处理命令
    if (ctx.command === 'stats' || ctx.command === 'stat' || fuzzy === 'stats') {
      ctx.reply(statsManager.getSummary(ctx.groupId));
      return true;
    }

    if (ctx.command === 'me' || ctx.command === '我' || fuzzy === 'me') {
      const result = statsManager.getUserStats(ctx.groupId, ctx.event.user_id);
      if (result) {
        ctx.replyAt(result);
      } else {
        ctx.replyAt('🆕 你在本群还没说过话，先聊几句');
      }
      return true;
    }

    if (ctx.command === 'resetstats') {
      const config = ctx.bot.getConfig();
      if (!config.admin_qq.includes(ctx.event.user_id)) {
        ctx.replyAt('⛔ 权限不足');
        return true;
      }
      statsManager.reset(ctx.groupId);
      ctx.reply('✅ 统计数据已重置');
      return true;
    }

    return false;
  },
};
