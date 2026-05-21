// PM2 配置文件 - 针对小内存服务器(1G/1核)优化
module.exports = {
  apps: [{
    name: 'wanjier',
    script: 'dist/index.js',
    // Node.js 内存限制 + 启用GC手动调用（节省内存关键）
    node_args: '--max-old-space-size=400 --expose-gc',
    // 进程内存超过 500MB 自动重启
    max_memory_restart: '500M',
    // 异常退出自动重启
    autorestart: true,
    // 最多每5秒重启一次
    min_uptime: 5000,
    // 重启间隔
    restart_delay: 3000,
    // 日志相关
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    // 合并日志
    merge_logs: true,
    // 启动模式
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
    },
  }],
};
