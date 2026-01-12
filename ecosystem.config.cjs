module.exports = {
  apps: [
    {
      name: 'bookmark-automation',
      script: 'dist/index.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
      },
      // Logs
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
      // Restart policy
      exp_backoff_restart_delay: 1000,
      max_restarts: 10,
      min_uptime: '10s',
    },
  ],
};
