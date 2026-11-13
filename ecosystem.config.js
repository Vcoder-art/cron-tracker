// PM2: three processes. In the main app only the `worker` entry is new - the API already runs under PM2.
//
//   pm2 start ecosystem.config.js
//   pm2 logs lab-worker
//   pm2 stop ecosystem.config.js && pm2 delete ecosystem.config.js
module.exports = {
  apps: [
    {
      name: 'lab-mock-accord',
      script: 'mock-accord/server.js',
    },
    {
      name: 'lab-api',
      script: 'src/api/server.js',
      // the API may run in cluster mode: it never schedules, and the tracker lock prevents overlaps
      instances: 1,
      kill_timeout: 30000,
      shutdown_with_message: true, // Windows: PM2 sends 'shutdown' message instead of SIGINT
    },
    {
      name: 'lab-worker',
      script: 'src/worker/worker.js',
      instances: 1, // exactly ONE scheduler. Never cluster this process.
      exec_mode: 'fork',
      kill_timeout: 30000, // > WORKER_SHUTDOWN_GRACE_MS, so running jobs can finish on stop/restart
      shutdown_with_message: true,
      max_memory_restart: '512M',
      autorestart: true,
      restart_delay: 5000,
    },
  ],
};
