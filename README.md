# Competition Link Tracker

Gestionnaire réutilisable de liens de compétition pour WhatsApp, conçu pour Cloudflare Workers + KV.

## Fonctions
- Ajout illimité de participants depuis /admin
- Un lien personnel par participant : /r/code
- Redirection vers le groupe WhatsApp
- Clics totaux et visiteurs uniques
- Classement automatique par visiteurs uniques
- Suppression des participants
- API JSON : /api/stats

## Déploiement Cloudflare
1. Créer un namespace KV dans Cloudflare.
2. Remplacer REPLACE_WITH_KV_NAMESPACE_ID dans wrangler.toml.
3. Connecter ce dépôt à Cloudflare Workers ou exécuter npm install puis npx wrangler deploy.
4. Ouvrir /admin.

Important : le compteur de visiteurs uniques limite les répétitions simples mais ne constitue pas une preuve absolue qu'une personne a rejoint le groupe WhatsApp.