/**
 * 简易统一logger
 * - 时间戳前缀
 * - 按级别分流
 * - 控制台彩色输出（PM2会保留到日志文件）
 * - 不引入外部依赖
 */

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function ts(): string {
  const d = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function format(level: string, color: string, scope: string, args: unknown[]): string[] {
  const prefix = `${COLORS.gray}[${ts()}]${COLORS.reset} ${color}[${level}]${COLORS.reset} ${COLORS.cyan}[${scope}]${COLORS.reset}`;
  return [prefix, ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))];
}

export function createLogger(scope: string) {
  return {
    info: (...args: unknown[]) => console.log(...format('INFO ', COLORS.green, scope, args)),
    warn: (...args: unknown[]) => console.warn(...format('WARN ', COLORS.yellow, scope, args)),
    error: (...args: unknown[]) => console.error(...format('ERROR', COLORS.red, scope, args)),
    debug: (...args: unknown[]) => {
      if (process.env.WANJIER_DEBUG) {
        console.log(...format('DEBUG', COLORS.blue, scope, args));
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
