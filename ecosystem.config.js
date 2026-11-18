// PM2: mock Accord + API. Jobs are started only by the server crontab calling the API.
//
//   pm2 start ecosystem.config.js
//   pm2 logs lab-api
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
  ],
};
