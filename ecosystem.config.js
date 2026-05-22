// PM2 配置文件 - 针对 2G 内存 / 1 核 / 70GB 存储服务器优化
module.exports = {
  apps: [{
    name: 'wanjier',
    script: 'dist/index.js',
    // 单进程运行：1核机器不要开 cluster；给 Node 留足堆空间，同时给 NapCat/系统保留余量
    node_args: '--max-old-space-size=768 --expose-gc',
    // RSS 超过约 1.1GB 自动重启，避免长期缓存/供应商异常响应拖垮整机
    max_memory_restart: '1100M',
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
