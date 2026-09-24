# Competition Link Tracker — Launch V1

La version de lancement reste volontairement minimale et mobile-first.

Flux admin unique :
1. ouvrir une compétition ;
2. créer manuellement un participant ;
3. récupérer/copier son lien personnel ;
4. consulter ses clics ;
5. ajouter ou retirer des points avec un motif ;
6. copier le lien public du classement.

Flux public :
- le lien participant `/r/:competition/:code` attribue le clic au participant ;
- le classement `/leaderboard/:competition` est le lien commun à partager dans le groupe ;
- le classement doit montrer la compétition, son visuel, les lots, les positions et l'écart de points vers la position supérieure.

Pour le lancement, masquer les modules secondaires : inscription publique, espace participant complexe, campagnes, missions/journées, prospects/ventes, récompenses avancées, anti-fraude, notifications et statistiques avancées.

Priorité UI : iPhone/mobile d'abord, puis desktop. Aucun défilement horizontal, actions principales accessibles au pouce et formulaires en une colonne sur petit écran.
