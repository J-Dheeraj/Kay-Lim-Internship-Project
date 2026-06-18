export function makeLogger(service) {
  const line = (level, msg, meta) =>
    JSON.stringify({ ts: new Date().toISOString(), level, service, msg, ...meta });
  return {
    info:  (msg, meta = {}) => console.log(line('info',  msg, meta)),
    warn:  (msg, meta = {}) => console.warn(line('warn',  msg, meta)),
    error: (msg, meta = {}) => console.error(line('error', msg, meta)),
  };
}
