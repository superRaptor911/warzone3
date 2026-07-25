// pm2 process definition.  Must be .cjs, not .js: package.json is "type": "module",
// so a module.exports file with a .js extension fails to load.
//
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup
//   pm2 restart warzone3        # after a git pull that touched server/
//
// Client-only edits need no restart: index.ts reads client/ and shared/ per
// request and strips types on the fly, so a browser refresh picks them up.
module.exports = {
  apps: [
    {
      name: 'warzone3',
      script: 'server/index.ts',

      // pm2 maps the .ts extension to bun (lib/API/interpreter.json).  Without
      // this pin it refuses to boot ("Interpreter bun is NOT AVAILABLE in
      // PATH"), or — if bun is installed — runs the server under a runtime with
      // no stripTypeScriptTypes in node:module, which is what serves client/.
      // Node >= 22.18 required for that same reason.
      interpreter: 'node',
      interpreter_args: '--disable-warning=ExperimentalWarning',

      // Never cluster.  Rooms, players and matchmaking live in this process's
      // memory (`rooms` in server/index.ts), so a second instance would scatter
      // players across two disconnected sets of rooms at random.
      instances: 1,
      exec_mode: 'fork',

      env: { NODE_ENV: 'production', PORT: 3000 },

      // No cwd on purpose: ROOT is derived from import.meta.url, so the server
      // is cwd-independent and this file works at any clone path.
      autorestart: true,
      restart_delay: 2000,
      max_restarts: 10,
      time: true,
    },
  ],
};
