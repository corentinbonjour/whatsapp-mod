# whatsapp-mod

Bot de modération pour groupes WhatsApp. Il lit les messages des groupes que vous choisissez et supprime ceux qui correspondent à vos règles, comme les liens d'invitation vers d'autres groupes ou les arnaques au faux don. Il peut aussi exclure l'auteur du message.

Le bot se connecte comme un appareil lié (WhatsApp Web) grâce à [Baileys](https://github.com/WhiskeySockets/Baileys), sans navigateur. Une interface web sert à choisir les groupes surveillés, écrire les règles, gérer une whitelist et consulter l'historique.

## Avant de commencer

WhatsApp n'autorise pas officiellement ce type de client. Utilisez un numéro dédié au bot plutôt que votre numéro personnel : en cas de blocage par WhatsApp, c'est ce numéro qui sera perdu.

Le numéro du bot doit être membre et admin de chaque groupe à surveiller. Sans les droits admin, il détecte le spam mais ne peut pas le supprimer (l'historique l'indique).

Il faut un serveur Linux avec Docker et le plugin Compose. En fonctionnement, le conteneur utilise environ 120 Mo de RAM et l'image pèse 300 Mo.

## Installation

```sh
git clone https://github.com/corentinbonjour/whatsapp-mod.git
cd whatsapp-mod
cp .env.example .env
```

Dans `.env`, remplacez `change-me` par un vrai mot de passe. Pour en générer un :

```sh
sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=')/" .env
```

Puis lancez le conteneur :

```sh
docker compose up -d --build
```

L'interface écoute sur `127.0.0.1:3000` et n'est donc pas joignable depuis Internet. Depuis votre poste, ouvrez un tunnel SSH vers le serveur :

```sh
ssh -N -L 3000:127.0.0.1:3000 utilisateur@serveur
```

et allez sur http://localhost:3000. La page de connexion demande le mot de passe de `.env`. La session dure 30 jours, ou jusqu'à ce que vous cliquiez sur le bouton de déconnexion en haut à droite.

## Première connexion

1. Un QR code s'affiche sur le tableau de bord. Sur le téléphone du bot, ouvrez WhatsApp, puis Appareils connectés, Connecter un appareil, et scannez-le. Le QR apparaît aussi dans `docker logs -f whatsapp-mod`.
2. Une fois connecté, cliquez sur Actualiser dans la carte Groupes pour charger la liste.
3. Activez les groupes à surveiller. Une étiquette « bot non admin » signale ceux où il faut encore donner les droits admin au bot.

Après Actualiser, le bot télécharge aussi la photo de chaque groupe, une toutes les deux secondes, et la garde sept jours. Le compteur de la carte Groupes indique l'avancement.

La session WhatsApp est conservée dans le volume Docker. Un redémarrage ou une mise à jour ne demande pas de rescanner.

## Règles

Le blocage des liens d'invitation (`chat.whatsapp.com`, chaînes WhatsApp) s'active d'un interrupteur. Les autres règles s'écrivent une par ligne.

Un texte simple est recherché dans le message sans tenir compte de la casse ni des accents. Les lettres stylisées que les spammeurs utilisent pour passer les filtres (𝐉𝐨𝐢𝐧, ｊｏｉｎ) sont ramenées à des lettres normales avant la comparaison.

Une règle entre slashs est une expression régulière JavaScript, toujours insensible à la casse. Par exemple, pour les arnaques du type « je donne mon appareil photo, écrivez-moi à tel mail », qui associent un don et une adresse e-mail :

```
/^(?=.*\b(giving away|give away|giveaway|for free|free of charge|a donner|je donne|gratuit(ement)?)\b)(?=.*[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,})/s
```

Le champ « Tester un message » montre tout de suite si un texte serait bloqué, et par quelle règle.

Les messages des admins du groupe et des numéros de la whitelist ne sont jamais filtrés. L'action par défaut supprime le message. L'option « Supprimer et exclure » retire aussi l'auteur du groupe, une seule fois même s'il a envoyé plusieurs messages.

## Limites de requêtes

WhatsApp limite le nombre de requêtes par compte. Le bot n'en envoie que pour supprimer un message ou exclure quelqu'un, avec au moins 1,5 seconde entre deux actions. La liste des groupes ne se recharge que sur un clic sur Actualiser. Si WhatsApp répond `rate-overlimit`, attendez quelques minutes avant de réessayer.

Après une coupure, le bot se reconnecte avec un délai qui double à chaque essai, jusqu'à cinq minutes. Si WhatsApp ferme la session parce qu'un autre appareil l'a reprise, il fait deux essais à dix secondes d'intervalle puis s'arrête. Un bouton Reconnecter apparaît alors dans l'interface.

## Historique

Chaque suppression, exclusion, reconnexion ou erreur est enregistrée dans une base SQLite. La page Historique permet de filtrer par type, résultat, groupe, période ou texte, et d'exporter le résultat en CSV (séparateur `;`, lisible par Excel). Les entrées de plus d'un an sont effacées au démarrage.

## Configuration

Variables lues dans `.env` :

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `ADMIN_PASSWORD` | aucun, obligatoire | Mot de passe de l'interface |
| `LOG_RETENTION_DAYS` | `365` | Durée de conservation de l'historique |
| `BAILEYS_LOG_LEVEL` | `warn` | Niveau de log de Baileys (`info` ou `debug` pour diagnostiquer une connexion) |

Le fuseau horaire est réglé sur `Europe/Paris` dans `docker-compose.yml`.

## Données et sauvegarde

Tout est dans le volume `data`, monté sur `/app/data` :

- `auth/` : la session WhatsApp. Quiconque possède ce dossier peut agir avec le compte du bot.
- `config.json` : groupes activés, règles, whitelist.
- `groups.json` : dernière liste des groupes chargée.
- `events.db` : l'historique.
- `pictures/` : les photos des groupes.

Pour une sauvegarde :

```sh
docker run --rm -v whatsapp-mod_data:/data -v "$PWD":/backup debian:bookworm-slim tar czf /backup/whatsapp-mod-data.tgz -C /data .
```

Le nom du volume dépend du nom du dossier du projet. `docker volume ls` l'affiche.

## Mise à jour

```sh
git pull
docker compose up -d --build
```

## Développement

Il faut Node.js 24 ou plus récent (pour `node:sqlite`).

```sh
npm install
ADMIN_PASSWORD=dev npm start
```

Les données vont alors dans `./data`. Le code est dans `src/` : `bot.js` gère la connexion et la modération, `filter.js` la détection, `db.js` l'historique, `server.js` l'API. L'interface est en HTML et JavaScript sans framework, dans `public/`.

## Accès à l'interface

Toutes les pages et toutes les routes de l'API demandent une session, sauf la page de connexion et sa feuille de style. Sans session, l'API répond 401 et les pages renvoient vers la connexion. Les sessions sont enregistrées côté serveur et une déconnexion invalide le cookie aussitôt. Le cookie est `HttpOnly` et `SameSite=Strict`, et les requêtes qui modifient quelque chose doivent porter l'en-tête `X-Requested-With: fetch`, ce qu'un formulaire d'un autre site ne peut pas envoyer.

Après cinq mots de passe faux, la connexion est bloquée pendant quinze minutes. Derrière le tunnel SSH toutes les requêtes arrivent de la même adresse, donc ce blocage vaut pour tout le monde.

Le tunnel SSH reste la solution la plus simple. Pour un accès direct, placez un reverse proxy avec HTTPS devant le port 3000 (Caddy ou nginx) et activez HSTS : sans HTTPS, le mot de passe et le cookie circulent en clair.
