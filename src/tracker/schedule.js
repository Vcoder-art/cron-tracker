// Schedule maths on top of cron-parser. A job can have several cron expressions,
// so "previous slot" = the latest of each expression's previous fire time.
const cronParser = require('cron-parser');

function slots(schedules, tz, now, direction) {
  return schedules.map((expr) => {
    const it = cronParser.parseExpression(expr, { currentDate: now, tz });
    return (direction === 'prev' ? it.prev() : it.next()).toDate();
  });
}

// Latest time the job was supposed to fire at or before `now`.
function prevSlot(schedules, tz, now = new Date()) {
  // +1s so a run that starts exactly on the minute still maps to that minute
  const list = slots(schedules, tz, new Date(now.getTime() + 1000), 'prev');
  return new Date(Math.max(...list.map((d) => d.getTime())));
}

// Next time the job will fire after `now`.
function nextSlot(schedules, tz, now = new Date()) {
  const list = slots(schedules, tz, now, 'next');
  return new Date(Math.min(...list.map((d) => d.getTime())));
}

module.exports = { prevSlot, nextSlot };
