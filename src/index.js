import { log, start } from './bot.js';
import { createServer } from './server.js';

const PORT = Number(process.env.PORT) || 3000;

createServer().listen(PORT, () => console.log(`Interface web sur http://localhost:${PORT}`));

function boot() {
  start().catch((e) => {
    log(`Erreur démarrage: ${e.message}, nouvel essai dans 10 s`, {}, 'error');
    setTimeout(boot, 10000);
  });
}
boot();
